/**
 * Reranker — combines ranked result lists from multiple retrieval sources into
 * a single unified ranking using Reciprocal Rank Fusion (RRF).
 *
 * RRF formula: score(d) = Σ 1 / (k + rank_i(d))
 * where k=60 is a constant that limits the influence of high-ranked documents.
 *
 * Symbol-exact matches receive an additional boost multiplier.
 */

const RRF_K = 60;
const SYMBOL_EXACT_BOOST = 3.0;

export type ResultKind = 'rg' | 'bm25' | 'symbol-exact' | 'symbol-fuzzy';

export interface RankedInput {
  id: string; // unique key (e.g. 'path:startLine')
  path: string;
  startLine: number;
  endLine?: number;
  kind: ResultKind;
  /** Optional symbol metadata to surface in the merged result. */
  symbolName?: string;
  symbolKind?: string;
  signature?: string;
}

export interface RankedResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  rrfScore: number;
  confidence: 'high' | 'medium' | 'low';
  sources: ResultKind[];
  symbolName?: string;
  symbolKind?: string;
  signature?: string;
}

/**
 * Merge multiple ranked lists into one via Reciprocal Rank Fusion.
 *
 * @param lists Each element is a ranked list of results (index = rank).
 * @param maxResults Max number of results to return.
 */
export function reciprocalRankFusion(
  lists: RankedInput[][],
  maxResults = 20,
): RankedResult[] {
  const scores = new Map<string, number>();
  const meta = new Map<string, RankedInput>();
  const sources = new Map<string, Set<ResultKind>>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const baseScore = 1 / (RRF_K + rank + 1);
      const boost = item.kind === 'symbol-exact' ? SYMBOL_EXACT_BOOST : 1.0;
      const contribution = baseScore * boost;

      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
      if (!meta.has(item.id)) meta.set(item.id, item);
      const s = sources.get(item.id) ?? new Set<ResultKind>();
      s.add(item.kind);
      sources.set(item.id, s);
    }
  }

  const entries = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  return entries.slice(0, maxResults).map(([id, rrfScore]) => {
    const m = meta.get(id)!;
    const srcs = [...(sources.get(id) ?? new Set<ResultKind>())] as ResultKind[];

    // Confidence: high if multiple sources agree or symbol-exact match
    let confidence: RankedResult['confidence'] = 'low';
    if (srcs.includes('symbol-exact') || srcs.length >= 2) confidence = 'high';
    else if (rrfScore > 0.01) confidence = 'medium';

    return {
      id,
      path: m.path,
      startLine: m.startLine,
      endLine: m.endLine ?? m.startLine,
      rrfScore,
      confidence,
      sources: srcs,
      ...(m.symbolName ? { symbolName: m.symbolName } : {}),
      ...(m.symbolKind ? { symbolKind: m.symbolKind } : {}),
      ...(m.signature ? { signature: m.signature } : {}),
    };
  });
}
