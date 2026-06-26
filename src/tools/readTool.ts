import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { BetterCodeError, type Citation } from '../types';
import { assertPathAllowed, assertRealPathInside, looksBinary, resolveInsideRepo } from './pathGuard';
import { clamp, redact } from './redaction';
import { githubBlobUrl, ok, toolError, type ToolDefinition, type ToolContext } from './types';

const readInput = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type ReadInput = z.infer<typeof readInput>;

export const readTool: ToolDefinition<ReadInput> = {
  name: 'read',
  description:
    'Read a source file (or a specific line range) from the repo snapshot. Use startLine/endLine to read targeted sections when you know the approximate location — this is more efficient than reading entire files. Returns numbered lines with a citation. Always read files found via search to verify behavior before answering.',
  inputSchema: readInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Repo-relative path. Must stay inside the repo.' },
      startLine: { type: 'integer', minimum: 1, description: 'First line (1-based, inclusive).' },
      endLine: { type: 'integer', minimum: 1, description: 'Last line (1-based, inclusive).' },
    },
  },

  async execute(input: ReadInput, ctx: ToolContext) {
    const { snapshot, access, budgets } = ctx;
    let absPath: string;
    let relPath: string;
    try {
      ({ absPath, relPath } = resolveInsideRepo(snapshot.worktreeRoot, input.path));
      assertPathAllowed(relPath, access);
      await assertRealPathInside(snapshot.worktreeRoot, absPath);
    } catch (err) {
      const e = err as BetterCodeError;
      return toolError('PATH_DENIED', e.message);
    }

    let info;
    try {
      info = await stat(absPath);
    } catch {
      return toolError('NOT_FOUND', `file not found: ${relPath}`);
    }
    if (info.isDirectory()) {
      return toolError('IS_DIRECTORY', `${relPath} is a directory; use search or repo_tree`);
    }
    if (info.size > budgets.maxFileBytes) {
      return toolError(
        'TOO_LARGE',
        `file ${relPath} is ${info.size} bytes (limit ${budgets.maxFileBytes}); narrow with startLine/endLine`,
      );
    }

    const buf = await readFile(absPath);
    if (looksBinary(buf, access.maxBinaryBytesProbe)) {
      return toolError('BINARY', `refusing to read binary file: ${relPath}`);
    }

    const allLines = buf.toString('utf8').split('\n');
    const total = allLines.length;
    const start = Math.max(1, input.startLine ?? 1);
    const requestedEnd = input.endLine ?? total;
    const end = Math.min(requestedEnd, total, start + budgets.maxFileLines - 1);
    const truncatedByLines = end < requestedEnd && requestedEnd < total;

    const numbered = allLines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}\t${line}`)
      .join('\n');

    const { text: safeBody, truncated: clampedBytes } = clamp(redact(numbered), budgets.maxFileBytes);

    const citation: Citation = {
      path: relPath,
      startLine: start,
      endLine: end,
      commitSha: snapshot.commitSha,
      url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, relPath, start, end),
    };

    return ok({
      content: `${relPath} (lines ${start}-${end} of ${total}) @ ${snapshot.commitSha.slice(0, 12)}\n${safeBody}`,
      citations: [citation],
      meta: { path: relPath, startLine: start, endLine: end, totalLines: total },
      truncated: truncatedByLines || clampedBytes,
    });
  },
};
