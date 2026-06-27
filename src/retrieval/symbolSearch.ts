/**
 * Symbol search — query the symbol index for name/keyword matches.
 * Returns structured symbol records with relevance scores.
 */
import type { RepoKnowledgeBase } from '../index/repoKnowledgeBase';
import type { SymbolRecord } from '../index/symbolIndex';

export interface SymbolMatch {
  symbol: SymbolRecord;
  score: number;
  matchType: 'exact' | 'prefix' | 'fuzzy';
}

/**
 * Score and rank symbol matches for a query string.
 * Exact name match > prefix match > substring match.
 */
export function searchSymbols(
  query: string,
  kb: RepoKnowledgeBase,
  maxResults = 20,
): SymbolMatch[] {
  if (!query.trim()) return [];
  const lower = query.toLowerCase();
  const results: SymbolMatch[] = [];

  for (const sym of kb.allSymbols) {
    const symLower = sym.name.toLowerCase();

    if (symLower === lower) {
      results.push({ symbol: sym, score: 100, matchType: 'exact' });
    } else if (symLower.startsWith(lower)) {
      results.push({ symbol: sym, score: 70, matchType: 'prefix' });
    } else if (symLower.includes(lower)) {
      // Fuzzy substring — score by how early the match appears
      const idx = symLower.indexOf(lower);
      results.push({ symbol: sym, score: 40 - Math.min(idx, 20), matchType: 'fuzzy' });
    }
  }

  // Stable sort: score descending, then by file path for determinism
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.symbol.file.localeCompare(b.symbol.file);
  });

  return results.slice(0, maxResults);
}
