/**
 * BM25 full-text search over repository file chunks using MiniSearch.
 *
 * Files are chunked into overlapping windows so that a long function
 * crossing a chunk boundary still appears in at least one chunk.
 */
import MiniSearch from 'minisearch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BM25Result {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  /** Short excerpt around the best matching area. */
  snippet?: string;
}

interface Chunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

const CHUNK_LINES = 150;
const OVERLAP_LINES = 20;
const STEP = CHUNK_LINES - OVERLAP_LINES;

// ---------------------------------------------------------------------------
// Index class
// ---------------------------------------------------------------------------

export class Bm25Index {
  private ms: MiniSearch<Chunk>;

  private constructor(ms: MiniSearch<Chunk>) {
    this.ms = ms;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  static build(files: { path: string; content: string }[]): Bm25Index {
    const ms = Bm25Index.createMs();
    const chunks: Chunk[] = [];

    for (const { path, content } of files) {
      const lines = content.split('\n');
      if (lines.length === 0) continue;

      for (let start = 0; start < lines.length; start += STEP) {
        const end = Math.min(start + CHUNK_LINES, lines.length);
        chunks.push({
          id: `${path}:${start + 1}`,
          path,
          startLine: start + 1,
          endLine: end,
          content: lines.slice(start, end).join('\n'),
        });
        if (end >= lines.length) break;
      }
    }

    ms.addAll(chunks);
    return new Bm25Index(ms);
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  search(query: string, maxResults = 15): BM25Result[] {
    const results = this.ms.search(query, { fuzzy: 0.1, prefix: true, boost: { content: 1, path: 0.3 } });
    return results.slice(0, maxResults).map((r) => ({
      path: r.path as string,
      startLine: r.startLine as number,
      endLine: r.endLine as number,
      score: r.score,
    }));
  }

  // -------------------------------------------------------------------------
  // Serialization (JSON stored in the knowledge-base cache file)
  // -------------------------------------------------------------------------

  toJSON(): unknown {
    return this.ms.toJSON();
  }

  static fromJSON(data: unknown): Bm25Index {
    const ms = MiniSearch.loadJSON<Chunk>(JSON.stringify(data), {
      fields: ['content', 'path'],
      storeFields: ['path', 'startLine', 'endLine'],
      tokenize: (text: string) => text.split(/[\s\p{P}]+/u).filter(Boolean),
      processTerm: (term: string) => term.toLowerCase().slice(0, 50),
    });
    return new Bm25Index(ms);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private static createMs(): MiniSearch<Chunk> {
    return new MiniSearch<Chunk>({
      fields: ['content', 'path'],
      storeFields: ['path', 'startLine', 'endLine'],
      tokenize: (text: string) => text.split(/[\s\p{P}]+/u).filter(Boolean),
      processTerm: (term: string) => term.toLowerCase().slice(0, 50),
    });
  }
}
