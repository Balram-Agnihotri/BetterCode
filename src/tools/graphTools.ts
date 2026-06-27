/**
 * Graph-based tools — query import/dependency and inheritance graphs built
 * from the repository symbol index.
 */
import { z } from 'zod';
import { ok, type ToolDefinition, type ToolContext } from './types';
import { buildDependencyTree, flattenTree } from '../index/graphIndex';

// ---------------------------------------------------------------------------
// dependencyGraph
// ---------------------------------------------------------------------------

const depGraphInput = z.object({
  path: z.string().optional().describe('Repo-relative file path to show dependencies for. Omit for repo overview.'),
  depth: z.number().int().min(1).max(5).optional().describe('Traversal depth. Default 2.'),
  direction: z
    .enum(['depends-on', 'imported-by'])
    .optional()
    .describe('"depends-on" (what does this file import?) or "imported-by" (who imports this file?). Default depends-on.'),
});

export const dependencyGraphTool: ToolDefinition<z.infer<typeof depGraphInput>> = {
  name: 'dependencyGraph',
  description:
    'Show the import/dependency graph for a file or the whole repository. ' +
    'Use "depends-on" to see what a file imports, "imported-by" to see who imports it. ' +
    'Great for understanding module coupling and finding the entry points to a subsystem.',
  inputSchema: depGraphInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Repo-relative file path. Omit for repo-wide overview.' },
      depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Traversal depth. Default 2.' },
      direction: {
        type: 'string',
        enum: ['depends-on', 'imported-by'],
        description: '"depends-on" or "imported-by". Default: depends-on.',
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase } = ctx;
    if (!knowledgeBase) {
      return ok({
        content: 'Repository index not available. Fall back to `search` for import patterns.',
        citations: [],
        meta: { indexAvailable: false },
        truncated: false,
      });
    }

    const depth = input.depth ?? 2;
    const direction = input.direction ?? 'depends-on';
    const graph = knowledgeBase.graph;

    if (!input.path) {
      // Repo-wide overview: list files with highest fan-out (most dependencies)
      const entries = [...graph.dependsOn.entries()]
        .map(([file, deps]) => ({ file, deps: deps.length }))
        .sort((a, b) => b.deps - a.deps)
        .slice(0, 20);

      if (entries.length === 0) {
        return ok({
          content: 'No import edges found in the repository index. The repository may use a build system not captured by static analysis.',
          citations: [],
          meta: { edgesFound: 0 },
          truncated: false,
        });
      }

      const lines = entries.map((e) => `  ${e.file} → ${e.deps} imports`);
      return ok({
        content: `**Repository import graph overview (top ${entries.length} files by fan-out):**\n${lines.join('\n')}`,
        citations: [],
        meta: { topFiles: entries.length },
        truncated: false,
      });
    }

    // File-specific dependency tree
    const tree = buildDependencyTree(input.path, graph, depth, direction);
    const deps = flattenTree(tree);

    if (deps.length === 0) {
      const emptyMsg =
        direction === 'depends-on'
          ? `\`${input.path}\` has no resolved imports in the index (it may import only external packages).`
          : `\`${input.path}\` is not imported by any indexed file.`;
      return ok({
        content: emptyMsg,
        citations: [],
        meta: { path: input.path, direction, found: 0 },
        truncated: false,
      });
    }

    function renderTree(node: typeof tree, indent = 0): string[] {
      const prefix = '  '.repeat(indent);
      const lines: string[] = [];
      if (indent > 0) lines.push(`${prefix}${node.path}`);
      for (const child of node.children) {
        lines.push(...renderTree(child, indent + 1));
      }
      return lines;
    }

    const treeLines = renderTree(tree);
    const header =
      direction === 'depends-on'
        ? `\`${input.path}\` depends on (depth ${depth}):`
        : `\`${input.path}\` is imported by (depth ${depth}):`;

    return ok({
      content: `**${header}**\n${treeLines.join('\n')}\n\n_Total: ${deps.length} file(s)_`,
      citations: [],
      meta: { path: input.path, direction, depth, found: deps.length },
      truncated: false,
    });
  },
};
