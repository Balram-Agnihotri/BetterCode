/**
 * Graph index — builds import/dependency, inheritance, and approximate call
 * graphs from the raw extraction results produced by symbolIndex.ts.
 *
 * The graphs are queryable by the symbol tools without re-parsing any source.
 */
import { dirname, extname, join } from 'node:path';
import { access as fsAccess } from 'node:fs/promises';
import type { ImportRecord, InheritanceRecord, SymbolRecord } from './symbolIndex';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphIndex {
  /** Forward: file → files it imports (resolved where possible). */
  dependsOn: Map<string, string[]>;
  /** Reverse: file → files that import it. */
  importedBy: Map<string, string[]>;
  /** Class/interface inheritance edges. */
  inheritance: InheritanceRecord[];
  /** Map: childName → parent names */
  parentOf: Map<string, string[]>;
  /** Map: parentName → children names */
  childrenOf: Map<string, string[]>;
  /** Symbols look-up by file for fast reference finding. */
  symbolsByName: Map<string, SymbolRecord[]>;
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/** Extensions tried in order when resolving a bare relative import. */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rb', '/index.ts', '/index.js'];

/**
 * Best-effort resolution of a relative import specifier to a repo-relative path.
 * Returns null if the specifier is a bare package name (no leading './' or '../').
 */
export async function resolveImportPath(
  fromFile: string,
  specifier: string,
  worktreeRoot: string,
  knownPaths: Set<string>,
): Promise<string | null> {
  if (!specifier.startsWith('.')) return null; // bare package, not resolvable

  const fromDir = dirname(fromFile);
  const base = join(fromDir, specifier).split('\\').join('/');

  // Try exact match first
  if (knownPaths.has(base)) return base;

  // Try with known extensions
  for (const ext of RESOLVE_EXTS) {
    const candidate = (base + ext).split('\\').join('/');
    if (knownPaths.has(candidate)) return candidate;
  }

  // Filesystem fallback (only for warm paths that aren't in the in-memory set)
  for (const ext of RESOLVE_EXTS) {
    const candidate = join(worktreeRoot, base + ext);
    try {
      await fsAccess(candidate);
      return (base + ext).split('\\').join('/');
    } catch {
      /* not found */
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildGraphIndex(
  symbols: Map<string, SymbolRecord[]>,
  allSymbols: SymbolRecord[],
  imports: ImportRecord[],
  inheritance: InheritanceRecord[],
  worktreeRoot: string,
): Promise<GraphIndex> {
  const knownPaths = new Set(symbols.keys());

  // Build dependency maps
  const dependsOn = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();

  for (const imp of imports) {
    const resolved = await resolveImportPath(imp.fromFile, imp.rawSpecifier, worktreeRoot, knownPaths);
    if (!resolved) continue;

    const deps = dependsOn.get(imp.fromFile) ?? [];
    if (!deps.includes(resolved)) deps.push(resolved);
    dependsOn.set(imp.fromFile, deps);

    const rev = importedBy.get(resolved) ?? [];
    if (!rev.includes(imp.fromFile)) rev.push(imp.fromFile);
    importedBy.set(resolved, rev);
  }

  // Build inheritance maps
  const parentOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();

  for (const edge of inheritance) {
    const parents = parentOf.get(edge.childName) ?? [];
    if (!parents.includes(edge.parentName)) parents.push(edge.parentName);
    parentOf.set(edge.childName, parents);

    const children = childrenOf.get(edge.parentName) ?? [];
    if (!children.includes(edge.childName)) children.push(edge.childName);
    childrenOf.set(edge.parentName, children);
  }

  // Build name → records lookup
  const symbolsByName = new Map<string, SymbolRecord[]>();
  for (const sym of allSymbols) {
    const list = symbolsByName.get(sym.name) ?? [];
    list.push(sym);
    symbolsByName.set(sym.name, list);
  }

  return { dependsOn, importedBy, inheritance, parentOf, childrenOf, symbolsByName };
}

// ---------------------------------------------------------------------------
// Transitive traversal helpers (used by dependency graph tool)
// ---------------------------------------------------------------------------

export interface DependencyNode {
  path: string;
  depth: number;
  children: DependencyNode[];
}

/** Build a dependency tree rooted at `startFile`, up to `maxDepth` levels. */
export function buildDependencyTree(
  startFile: string,
  graph: GraphIndex,
  maxDepth = 3,
  direction: 'depends-on' | 'imported-by' = 'depends-on',
): DependencyNode {
  const visited = new Set<string>();

  function build(path: string, depth: number): DependencyNode {
    if (depth >= maxDepth || visited.has(path)) {
      return { path, depth, children: [] };
    }
    visited.add(path);
    const edges =
      direction === 'depends-on'
        ? graph.dependsOn.get(path) ?? []
        : graph.importedBy.get(path) ?? [];
    return {
      path,
      depth,
      children: edges.map((e) => build(e, depth + 1)),
    };
  }

  return build(startFile, 0);
}

/** Flatten a dependency tree into a sorted list of unique paths. */
export function flattenTree(node: DependencyNode): string[] {
  const seen = new Set<string>();
  function collect(n: DependencyNode): void {
    if (seen.has(n.path)) return;
    seen.add(n.path);
    for (const child of n.children) collect(child);
  }
  collect(node);
  seen.delete(node.path); // exclude root
  return [...seen].sort();
}
