import { z } from 'zod';
import type { Citation } from '../types';
import { runCommand } from '../util/exec';
import { isPathDenied } from './pathGuard';
import { clamp, redact } from './redaction';
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
const MAX_SNIPPET_CHARS = 240;

interface RgMatch {
  path: string;
  lineNumber: number;
  text: string;
}

export const searchTool: ToolDefinition<SearchInput> = {
  name: 'search',
  description:
    'Search source code using ripgrep. Returns file paths, line numbers, and short snippets. Use specific search terms (function names, class names, unique strings) — avoid vague single-word queries. Use the glob parameter to narrow scope to specific directories. After searching, use the read tool to verify actual implementation. You can call search multiple times with refined queries if initial results are too broad.',
  inputSchema: searchInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Pattern to search for.' },
      mode: { type: 'string', enum: ['literal', 'regex', 'semantic'], description: 'literal (default), regex, or semantic (v0: falls back to literal).' },
      glob: { type: 'string', description: 'Optional include glob, e.g. "**/*.ts".' },
      maxResults: { type: 'integer', minimum: 1, description: 'Cap on matches returned.' },
      contextLines: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines of context around each match.' },
    },
  },

  async execute(input: SearchInput, ctx: ToolContext) {
    const { snapshot, access, budgets } = ctx;
    const cap = Math.min(input.maxResults ?? budgets.maxSearchResults, budgets.maxSearchResults);
    const notes: string[] = [];
    if (input.mode === 'semantic') {
      notes.push('semantic mode is not available in v0; ran a literal search instead.');
    }

    const args = ['--json', '--smart-case', '--max-columns', '300'];
    if (input.mode !== 'regex') args.push('--fixed-strings');
    if (input.glob) args.push('--glob', input.glob);
    for (const deny of access.denyGlobs) args.push('--glob', `!${deny}`);
    if (input.contextLines) args.push('--context', String(input.contextLines));
    args.push('-e', input.query, '.');

    let stdout: string;
    try {
      const res = await runCommand('rg', args, {
        cwd: snapshot.worktreeRoot,
        timeoutMs: Math.min(20_000, ctx.tracker.remainingMs()),
        okExitCodes: [0, 1], // 1 = no matches
        signal: ctx.signal,
        maxBuffer: 24 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (err) {
      return toolError('SEARCH_FAILED', (err as Error).message);
    }

    const matches: RgMatch[] = [];
    let totalSeen = 0;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let evt: { type?: string; data?: Record<string, unknown> };
      try {
        evt = JSON.parse(line) as typeof evt;
      } catch {
        continue;
      }
      if (evt.type !== 'match' || !evt.data) continue;
      totalSeen += 1;
      const data = evt.data as {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
      const rawPath = data.path?.text ?? '';
      const relPath = rawPath.replace(/^\.\//, '');
      if (!relPath || isPathDenied(relPath, access)) continue; // defense in depth
      if (matches.length >= cap) continue;
      matches.push({
        path: relPath,
        lineNumber: data.line_number ?? 0,
        text: (data.lines?.text ?? '').replace(/\n$/, ''),
      });
    }

    const truncated = totalSeen > matches.length;
    if (truncated) {
      notes.push(`showing ${matches.length} of ${totalSeen}+ matches; narrow with a glob or more specific query.`);
      ctx.tracker.markTruncated();
    }

    if (matches.length === 0) {
      return ok({
        content: `No matches for ${JSON.stringify(input.query)}.${notes.length ? ` (${notes.join(' ')})` : ''}`,
        citations: [],
        meta: { query: input.query, mode: input.mode, totalSeen },
        truncated: false,
      });
    }

    const citations: Citation[] = matches.slice(0, MAX_CITATIONS).map((m) => ({
      path: m.path,
      startLine: m.lineNumber,
      endLine: m.lineNumber,
      commitSha: snapshot.commitSha,
      url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, m.path, m.lineNumber, m.lineNumber),
    }));

    const body = matches
      .map((m) => {
        const snippet = clamp(redact(m.text).trim(), MAX_SNIPPET_CHARS).text;
        return `${m.path}:${m.lineNumber}: ${snippet}`;
      })
      .join('\n');

    return ok({
      content: `${matches.length} match(es)${notes.length ? ` — ${notes.join(' ')}` : ''}:\n${body}`,
      citations,
      meta: { query: input.query, mode: input.mode, returned: matches.length, totalSeen },
      truncated,
    });
  },
};
