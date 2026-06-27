/**
 * Hybrid search — orchestrates ripgrep, BM25, and symbol search into a single
 * ranked result set using Reciprocal Rank Fusion.
 *
 * The LLM receives a richer, structured response instead of raw ripgrep output.
 * Ripgrep is always run first so exact matches are never missed; BM25 and symbol
 * search add semantic breadth and structured metadata.
 */
import { runCommand } from '../util/exec';
import { isPathDenied } from '../tools/pathGuard';
import { clamp, redact } from '../tools/redaction';
import type { RepoKnowledgeBase } from '../index/repoKnowledgeBase';
import { searchSymbols } from './symbolSearch';
import { reciprocalRankFusion, type RankedInput } from './reranker';
import type { AccessConfig } from '../config/schema';
import type { RepoSnapshot } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HybridSearchInput {
  query: string;
  mode?: 'literal' | 'regex' | 'semantic';
  glob?: string;
  maxResults?: number;
  contextLines?: number;
}

export interface HybridSearchResult {
  path: string;
  startLine: number;
  endLine: number;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  /** Symbol name if this result came from the symbol index. */
  symbolName?: string;
  symbolKind?: string;
  signature?: string;
  /** Short text snippet (may be empty if result is purely structural). */
  snippet: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a hybrid search across the repository.
 * If no knowledge base is available, falls back to pure ripgrep.
 */
export async function hybridSearch(
  input: HybridSearchInput,
  snapshot: RepoSnapshot,
  access: AccessConfig,
  signal: AbortSignal,
  remainingMs: number,
  kb?: RepoKnowledgeBase,
): Promise<{ results: HybridSearchResult[]; notes: string[]; totalSeen: number }> {
  const cap = input.maxResults ?? 25;
  const notes: string[] = [];
  if (input.mode === 'semantic') {
    notes.push('semantic mode uses BM25 + symbol index (no vector embeddings in this build).');
  }

  // ------- 1. Ripgrep -------
  const rgList: RankedInput[] = [];
  let totalSeen = 0;
  const snippets = new Map<string, string>(); // id → snippet text

  try {
    const args = ['--json', '--smart-case', '--max-columns', '300'];
    if (input.mode !== 'regex') args.push('--fixed-strings');
    if (input.glob) args.push('--glob', input.glob);
    for (const deny of access.denyGlobs) args.push('--glob', `!${deny}`);
    if (input.contextLines) args.push('--context', String(input.contextLines));
    args.push('-e', input.query, '.');

    const res = await runCommand('rg', args, {
      cwd: snapshot.worktreeRoot,
      timeoutMs: Math.min(15_000, remainingMs),
      okExitCodes: [0, 1],
      signal,
      maxBuffer: 24 * 1024 * 1024,
    });

    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      let evt: { type?: string; data?: unknown };
      try { evt = JSON.parse(line) as typeof evt; } catch { continue; }
      if (evt.type !== 'match' || !evt.data) continue;
      totalSeen += 1;

      const data = evt.data as {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
      const rawPath = data.path?.text ?? '';
      const relPath = rawPath.replace(/^\.\//, '');
      if (!relPath || isPathDenied(relPath, access)) continue;
      if (rgList.length >= cap * 2) continue;

      const lineNum = data.line_number ?? 0;
      const id = `${relPath}:${lineNum}`;
      const snippetText = clamp(redact((data.lines?.text ?? '').replace(/\n$/, '').trim()), 240).text;
      rgList.push({ id, path: relPath, startLine: lineNum, endLine: lineNum, kind: 'rg' });
      snippets.set(id, snippetText);
    }
  } catch (err) {
    notes.push(`ripgrep failed: ${(err as Error).message}`);
  }

  // If no knowledge base, return rg-only results
  if (!kb) {
    return {
      results: rgList.slice(0, cap).map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        confidence: 'medium',
        sources: ['rg'],
        snippet: snippets.get(r.id) ?? '',
      })),
      notes,
      totalSeen,
    };
  }

  // ------- 2. BM25 -------
  const bm25Raw = kb.bm25.search(input.query, cap);
  const bm25List: RankedInput[] = bm25Raw.map((r) => ({
    id: `${r.path}:${r.startLine}`,
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    kind: 'bm25' as const,
  }));

  // ------- 3. Symbol search -------
  const symRaw = searchSymbols(input.query, kb, cap);
  const symList: RankedInput[] = symRaw.map((m) => ({
    id: `${m.symbol.file}:${m.symbol.startLine}`,
    path: m.symbol.file,
    startLine: m.symbol.startLine,
    endLine: m.symbol.endLine,
    kind: (m.matchType === 'exact' ? 'symbol-exact' : 'symbol-fuzzy') as RankedInput['kind'],
    symbolName: m.symbol.name,
    symbolKind: m.symbol.kind,
    signature: m.symbol.signature,
  }));

  // ------- 4. Rerank -------
  const merged = reciprocalRankFusion([rgList, bm25List, symList], cap);

  if (totalSeen > merged.length) {
    notes.push(`showing ${merged.length} of ${totalSeen}+ matches; narrow with a glob or more specific query.`);
  }

  const results: HybridSearchResult[] = merged.map((r) => ({
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    confidence: r.confidence,
    sources: r.sources,
    ...(r.symbolName ? { symbolName: r.symbolName } : {}),
    ...(r.symbolKind ? { symbolKind: r.symbolKind } : {}),
    ...(r.signature ? { signature: r.signature } : {}),
    snippet: snippets.get(r.id) ?? '',
  }));

  return { results, notes, totalSeen };
}
