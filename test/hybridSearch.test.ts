import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hybridSearch, type HybridSearchInput } from '../src/retrieval/hybridSearch';
import type { RepoSnapshot } from '../src/types';
import type { AccessConfig } from '../src/config/schema';

/** Builds a minimal temp repo with a few source files and returns its path. */
async function makeRepo(): Promise<{ root: string; snapshot: RepoSnapshot; access: AccessConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'bc-hybrid-'));
  await mkdir(join(root, 'src'), { recursive: true });

  await writeFile(
    join(root, 'src/orchestrator.ts'),
    `export async function runJob(params: unknown) {
  // core job runner
  return { answer: 'ok' };
}
`,
    'utf8',
  );

  await writeFile(
    join(root, 'src/worker.ts'),
    `import { runJob } from './orchestrator';
export async function processRecord() {
  return runJob({});
}
`,
    'utf8',
  );

  const snapshot: RepoSnapshot = {
    project: 'test',
    worktreeRoot: root,
    commitSha: 'abc1234',
    branch: 'main',
    githubWebBaseUrl: 'https://github.com/test/repo',
  };

  const access: AccessConfig = {
    denyGlobs: [],
    allowGlobs: ['**/*'],
    maxBinaryBytesProbe: 8192,
  };

  return { root, snapshot, access };
}

describe('hybridSearch (no knowledge base — rg-only path)', () => {
  it('finds an exact string in the temp repo', async () => {
    const { snapshot, access } = await makeRepo();
    const input: HybridSearchInput = { query: 'runJob', maxResults: 10 };
    const ctrl = new AbortController();

    const { results, totalSeen } = await hybridSearch(input, snapshot, access, ctrl.signal, 10_000);

    expect(results.length).toBeGreaterThan(0);
    expect(totalSeen).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    // Both files reference runJob
    expect(paths.some((p) => p.includes('orchestrator'))).toBe(true);
  });

  it('returns empty results for a query that matches nothing', async () => {
    const { snapshot, access } = await makeRepo();
    const input: HybridSearchInput = {
      query: 'xXxThisStringCannotPossiblyExistInAnyFileXxX',
      maxResults: 10,
    };
    const ctrl = new AbortController();

    const { results, totalSeen } = await hybridSearch(input, snapshot, access, ctrl.signal, 10_000);

    expect(results).toHaveLength(0);
    expect(totalSeen).toBe(0);
  });

  it('result objects have the expected shape', async () => {
    const { snapshot, access } = await makeRepo();
    const input: HybridSearchInput = { query: 'processRecord', maxResults: 5 };
    const ctrl = new AbortController();

    const { results } = await hybridSearch(input, snapshot, access, ctrl.signal, 10_000);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.path).toBe('string');
      expect(typeof r.startLine).toBe('number');
      expect(typeof r.endLine).toBe('number');
      expect(['high', 'medium', 'low']).toContain(r.confidence);
      expect(Array.isArray(r.sources)).toBe(true);
      expect(typeof r.snippet).toBe('string');
    }
  });

  it('respects the glob filter', async () => {
    const { snapshot, access } = await makeRepo();
    const input: HybridSearchInput = {
      query: 'runJob',
      glob: 'src/worker.ts',
      maxResults: 10,
    };
    const ctrl = new AbortController();

    const { results } = await hybridSearch(input, snapshot, access, ctrl.signal, 10_000);

    for (const r of results) {
      expect(r.path).toContain('worker');
    }
  });

  it('appends a note when semantic mode is requested', async () => {
    const { snapshot, access } = await makeRepo();
    const input: HybridSearchInput = { query: 'runJob', mode: 'semantic', maxResults: 5 };
    const ctrl = new AbortController();

    const { notes } = await hybridSearch(input, snapshot, access, ctrl.signal, 10_000);

    expect(notes.some((n) => n.includes('BM25'))).toBe(true);
  });
});
