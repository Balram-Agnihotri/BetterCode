/**
 * RepoKnowledgeBase — the central intelligence cache for one repository snapshot.
 *
 * Combines the Tree-sitter symbol index, the import/inheritance graph index,
 * and the BM25 full-text index into a single serializable object.
 *
 * Caching strategy: the serialized form is written to
 *   /tmp/bettercode/<project>/kb-<commitSha>.json
 * and reused for all subsequent jobs on the same commit. A new commit triggers
 * a fresh build (old cache files are left to expire naturally in Lambda's /tmp).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccessConfig } from '../config/schema';
import type { RepoSnapshot } from '../types';
import { Bm25Index } from '../retrieval/bm25Search';
import { buildGraphIndex, type GraphIndex } from './graphIndex';
import { buildRepoIndex, type SymbolRecord, type ImportRecord, type InheritanceRecord } from './symbolIndex';

// ---------------------------------------------------------------------------
// Serialization schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

interface SerializedKB {
  version: typeof SCHEMA_VERSION;
  commitSha: string;
  builtAt: string;
  /** relPath → SymbolRecord[] */
  symbols: Record<string, SymbolRecord[]>;
  imports: ImportRecord[];
  inheritance: InheritanceRecord[];
  bm25: unknown; // MiniSearch JSON
}

// ---------------------------------------------------------------------------
// RepoKnowledgeBase
// ---------------------------------------------------------------------------

export class RepoKnowledgeBase {
  readonly symbols: Map<string, SymbolRecord[]>;
  readonly allSymbols: SymbolRecord[];
  readonly graph: GraphIndex;
  readonly bm25: Bm25Index;
  readonly commitSha: string;

  private constructor(
    symbols: Map<string, SymbolRecord[]>,
    allSymbols: SymbolRecord[],
    graph: GraphIndex,
    bm25: Bm25Index,
    commitSha: string,
  ) {
    this.symbols = symbols;
    this.allSymbols = allSymbols;
    this.graph = graph;
    this.bm25 = bm25;
    this.commitSha = commitSha;
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  /**
   * Load the cache if it matches the current commitSha, otherwise build fresh.
   * Errors during build are swallowed — callers get a minimal empty instance
   * rather than a broken job.
   */
  static async buildOrLoad(
    snapshot: RepoSnapshot,
    access: AccessConfig,
    cacheRoot = '/tmp/bettercode',
  ): Promise<RepoKnowledgeBase> {
    const cachePath = join(cacheRoot, snapshot.project, `kb-${snapshot.commitSha}.json`);

    // Try cache first
    try {
      const raw = await readFile(cachePath, 'utf8');
      const data = JSON.parse(raw) as SerializedKB;
      if (data.version === SCHEMA_VERSION && data.commitSha === snapshot.commitSha) {
        console.log('[RepoKnowledgeBase] Cache hit, loaded from', cachePath);
        return RepoKnowledgeBase.fromSerialized(data, snapshot.worktreeRoot);
      }
    } catch (err) {
      /* cache miss or schema mismatch — proceed to build */
      console.log('[RepoKnowledgeBase] Cache miss, will build fresh');
    }

    // Build fresh
    try {
      console.log('[RepoKnowledgeBase] Starting build for', snapshot.project, 'commit', snapshot.commitSha);
      const t0 = Date.now();
      const kb = await RepoKnowledgeBase.build(snapshot, access, cacheRoot, cachePath);
      const elapsed = Date.now() - t0;
      console.log('[RepoKnowledgeBase] Build succeeded in', elapsed, 'ms');
      return kb;
    } catch (err) {
      // Log the full error so we can diagnose
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : '';
      console.error('[RepoKnowledgeBase] Build failed:', msg);
      console.error('[RepoKnowledgeBase] Stack:', stack.split('\n').slice(0, 5).join('\n'));
      // Return empty instance so the job can still proceed with plain ripgrep
      console.error('[RepoKnowledgeBase] Falling back to empty index (symbol tools will be unavailable)');
      return RepoKnowledgeBase.empty(snapshot.commitSha);
    }
  }

  private static async build(
    snapshot: RepoSnapshot,
    access: AccessConfig,
    cacheRoot: string,
    cachePath: string,
  ): Promise<RepoKnowledgeBase> {
    const { symbols, allSymbols, imports, inheritance, fileChunks } =
      await buildRepoIndex(snapshot.worktreeRoot, access);

    const graph = await buildGraphIndex(
      symbols,
      allSymbols,
      imports,
      inheritance,
      snapshot.worktreeRoot,
    );

    const bm25 = Bm25Index.build(fileChunks);

    const kb = new RepoKnowledgeBase(symbols, allSymbols, graph, bm25, snapshot.commitSha);

    // Persist asynchronously (don't block the job on I/O)
    kb.persistAsync(cacheRoot, cachePath, imports, inheritance).catch(() => {/* best effort */});

    return kb;
  }

  private async persistAsync(
    cacheRoot: string,
    cachePath: string,
    imports: ImportRecord[],
    inheritance: InheritanceRecord[],
  ): Promise<void> {
    await mkdir(join(cacheRoot, /* will be project dir */ '..'), { recursive: true }).catch(() => {});
    await mkdir(join(cachePath, '..'), { recursive: true }).catch(() => {});
    const serialized: SerializedKB = {
      version: SCHEMA_VERSION,
      commitSha: this.commitSha,
      builtAt: new Date().toISOString(),
      symbols: Object.fromEntries(this.symbols),
      imports,
      inheritance,
      bm25: this.bm25.toJSON(),
    };
    await writeFile(cachePath, JSON.stringify(serialized), 'utf8');
  }

  private static async fromSerialized(data: SerializedKB, worktreeRoot: string): Promise<RepoKnowledgeBase> {
    const symbols = new Map<string, SymbolRecord[]>(Object.entries(data.symbols));
    const allSymbols: SymbolRecord[] = [];
    for (const recs of symbols.values()) allSymbols.push(...recs);

    const graph = await buildGraphIndex(
      symbols,
      allSymbols,
      data.imports,
      data.inheritance,
      worktreeRoot,
    );

    const bm25 = Bm25Index.fromJSON(data.bm25);

    return new RepoKnowledgeBase(symbols, allSymbols, graph, bm25, data.commitSha);
  }

  static empty(commitSha: string): RepoKnowledgeBase {
    const graph: GraphIndex = {
      dependsOn: new Map(),
      importedBy: new Map(),
      inheritance: [],
      parentOf: new Map(),
      childrenOf: new Map(),
      symbolsByName: new Map(),
    };
    return new RepoKnowledgeBase(new Map(), [], graph, Bm25Index.build([]), commitSha);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Find symbols by exact or fuzzy name match. */
  findSymbols(
    name: string,
    opts: { kind?: string; fuzzy?: boolean; maxResults?: number } = {},
  ): SymbolRecord[] {
    const { kind, fuzzy = false, maxResults = 20 } = opts;
    const lower = name.toLowerCase();
    const matches: SymbolRecord[] = [];

    for (const sym of this.allSymbols) {
      if (kind && sym.kind !== kind) continue;
      const symLower = sym.name.toLowerCase();
      if (fuzzy ? symLower.includes(lower) : symLower === lower) {
        matches.push(sym);
        if (matches.length >= maxResults) break;
      }
    }

    // Secondary pass: prefix match when fuzzy and results sparse
    if (fuzzy && matches.length < maxResults) {
      for (const sym of this.allSymbols) {
        if (kind && sym.kind !== kind) continue;
        if (sym.name.toLowerCase().startsWith(lower) && !matches.some((m) => m === sym)) {
          matches.push(sym);
          if (matches.length >= maxResults) break;
        }
      }
    }

    return matches.slice(0, maxResults);
  }

  /** Return all symbols defined in a specific file. */
  symbolsInFile(relPath: string): SymbolRecord[] {
    return this.symbols.get(relPath) ?? [];
  }

  /** Find symbols that reference a given name (approximate: text-based). */
  findReferences(name: string, maxResults = 30): { file: string; line: number; kind: string }[] {
    const results: { file: string; line: number; kind: string }[] = [];
    const bm25Results = this.bm25.search(name, 50);
    for (const r of bm25Results) {
      results.push({ file: r.path, line: r.startLine, kind: 'text-match' });
      if (results.length >= maxResults) break;
    }
    return results;
  }

  /** Summary of index statistics (for logging/debugging). */
  stats(): { files: number; symbols: number; importEdges: number; inheritanceEdges: number } {
    return {
      files: this.symbols.size,
      symbols: this.allSymbols.length,
      importEdges: this.graph.dependsOn.size,
      inheritanceEdges: this.graph.inheritance.length,
    };
  }
}
