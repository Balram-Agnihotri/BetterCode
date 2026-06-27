import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, type RankedInput } from '../src/retrieval/reranker';

function item(id: string, kind: RankedInput['kind'] = 'rg'): RankedInput {
  return { id, path: `src/${id}.ts`, startLine: 1, kind };
}

describe('reciprocalRankFusion', () => {
  it('returns items ordered by descending RRF score', () => {
    // Item A appears in rank-0 of both lists → highest score
    // Item B appears only in rank-0 of one list
    const listA: RankedInput[] = [item('A'), item('B')];
    const listB: RankedInput[] = [item('A'), item('C')];

    const results = reciprocalRankFusion([listA, listB]);
    expect(results[0].id).toBe('A');
    expect(results.map((r) => r.id)).toContain('B');
    expect(results.map((r) => r.id)).toContain('C');
  });

  it('gives symbol-exact hits a 3x boost over rg-only hits', () => {
    // symbolResult at rank-10, rgResult at rank-0 — boost should overcome the rank gap
    const symbolList: RankedInput[] = [
      ...Array.from({ length: 10 }, (_, i) => item(`filler-${i}`, 'rg')),
      { id: 'sym', path: 'src/sym.ts', startLine: 1, kind: 'symbol-exact' },
    ];
    const rgList: RankedInput[] = [item('rg-hit', 'rg')];

    const results = reciprocalRankFusion([symbolList, rgList]);
    // sym should outrank rg-hit due to boost
    const symPos = results.findIndex((r) => r.id === 'sym');
    const rgPos = results.findIndex((r) => r.id === 'rg-hit');
    expect(symPos).toBeLessThan(rgPos);
  });

  it('marks a result as high-confidence when multiple sources agree', () => {
    const rgList: RankedInput[] = [item('X', 'rg')];
    const bm25List: RankedInput[] = [item('X', 'bm25')];

    const results = reciprocalRankFusion([rgList, bm25List]);
    const x = results.find((r) => r.id === 'X')!;
    expect(x.confidence).toBe('high');
    expect(x.sources).toContain('rg');
    expect(x.sources).toContain('bm25');
  });

  it('marks a symbol-exact result as high-confidence even from one source', () => {
    const results = reciprocalRankFusion([[item('S', 'symbol-exact')]]);
    expect(results[0].confidence).toBe('high');
  });

  it('respects maxResults cap', () => {
    const list: RankedInput[] = Array.from({ length: 50 }, (_, i) => item(`item-${i}`));
    const results = reciprocalRankFusion([list], 10);
    expect(results.length).toBe(10);
  });

  it('carries symbol metadata through to merged results', () => {
    const withMeta: RankedInput = {
      id: 'fn',
      path: 'src/fn.ts',
      startLine: 5,
      kind: 'symbol-exact',
      symbolName: 'runJob',
      symbolKind: 'function',
      signature: 'export async function runJob(',
    };
    const results = reciprocalRankFusion([[withMeta]]);
    expect(results[0].symbolName).toBe('runJob');
    expect(results[0].signature).toContain('runJob');
  });

  it('returns empty array for empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });
});
