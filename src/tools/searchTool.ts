import { z } from 'zod';
import type { Citation } from '../types';
import { hybridSearch } from '../retrieval/hybridSearch';
import { githubBlobUrl, ok, toolError, type ToolDefinition, type ToolContext } from './types';

const searchInput = z.object({
  query: z.string().min(1),
  mode: z.enum(['literal', 'regex', 'semantic']).default('literal'),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
  contextLines: z.number().int().min(0).max(5).optional(),
});
export type SearchInput = z.infer<typeof searchInput>;

const MAX_CITATIONS = 25;

export const searchTool: ToolDefinition<SearchInput> = {
  name: 'search',
  description:
    'Search source code using hybrid retrieval (ripgrep + BM25 + symbol index). Returns ranked file locations, ' +
    'symbol metadata, and short snippets. Prefer `findSymbol` or `workspaceSymbols` when you know the symbol name — ' +
    'this tool is best for free-text and pattern searches. Use specific terms (function names, class names, ' +
    'unique strings). Use the glob parameter to narrow scope to specific directories.',
  inputSchema: searchInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Pattern to search for.' },
      mode: { type: 'string', enum: ['literal', 'regex', 'semantic'], description: 'literal (default), regex, or semantic (BM25 + symbol index).' },
      glob: { type: 'string', description: 'Optional include glob, e.g. "**/*.ts".' },
      maxResults: { type: 'integer', minimum: 1, description: 'Cap on matches returned.' },
      contextLines: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines of context around each match (ripgrep only).' },
    },
  },

  async execute(input: SearchInput, ctx: ToolContext) {
    const { snapshot, access, budgets } = ctx;
    const cap = Math.min(input.maxResults ?? budgets.maxSearchResults, budgets.maxSearchResults);

    let hybrid;
    try {
      hybrid = await hybridSearch(
        { query: input.query, mode: input.mode, glob: input.glob, maxResults: cap, contextLines: input.contextLines },
        snapshot,
        access,
        ctx.signal,
        ctx.tracker.remainingMs(),
        ctx.knowledgeBase,
      );
    } catch (err) {
      return toolError('SEARCH_FAILED', (err as Error).message);
    }

    const { results, notes, totalSeen } = hybrid;

    if (totalSeen > results.length) ctx.tracker.markTruncated();

    if (results.length === 0) {
      return ok({
        content: `No matches for ${JSON.stringify(input.query)}.${notes.length ? ` (${notes.join(' ')})` : ''}`,
        citations: [],
        meta: { query: input.query, mode: input.mode, totalSeen },
        truncated: false,
      });
    }

    const citations: Citation[] = results.slice(0, MAX_CITATIONS).map((r) => ({
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      commitSha: snapshot.commitSha,
      url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, r.path, r.startLine, r.endLine),
    }));

    const body = results
      .map((r) => {
        const loc = `${r.path}:${r.startLine}`;
        const conf = r.confidence !== 'low' ? ` [${r.confidence}]` : '';
        const sym = r.symbolName ? ` · ${r.symbolKind} \`${r.symbolName}\`` : '';
        const sig = r.signature ? ` — ${r.signature.slice(0, 100)}` : r.snippet ? ` — ${r.snippet}` : '';
        return `${loc}${conf}${sym}${sig}`;
      })
      .join('\n');

    const noteStr = notes.length ? ` — ${notes.join(' ')}` : '';
    return ok({
      content: `${results.length} result(s)${noteStr}:\n${body}`,
      citations,
      meta: { query: input.query, mode: input.mode, returned: results.length, totalSeen },
      truncated: totalSeen > results.length,
    });
  },
};
