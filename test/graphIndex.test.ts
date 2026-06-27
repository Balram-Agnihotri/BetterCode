import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from '../src/index/graphIndex';
import type { ImportRecord, InheritanceRecord, SymbolRecord } from '../src/index/symbolIndex';

function sym(name: string, file: string, kind: SymbolRecord['kind'] = 'function'): SymbolRecord {
  return { name, kind, signature: `${kind} ${name}`, file, startLine: 1, endLine: 10 };
}

function imp(fromFile: string, rawSpecifier: string, importedNames: string[] = []): ImportRecord {
  return { fromFile, rawSpecifier, importedNames, isStar: false, isDefault: false };
}

function inh(childFile: string, childName: string, parentName: string): InheritanceRecord {
  return { childFile, childName, parentName, kind: 'extends' };
}

describe('buildGraphIndex', () => {
  it('builds empty graph from empty inputs', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-graph-'));
    const graph = await buildGraphIndex(new Map(), [], [], [], tmp);

    expect(graph.dependsOn.size).toBe(0);
    expect(graph.importedBy.size).toBe(0);
    expect(graph.inheritance).toHaveLength(0);
    expect(graph.symbolsByName.size).toBe(0);
  });

  it('indexes symbols by name (not by file)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-graph-'));
    const symbols = new Map([
      ['src/a.ts', [sym('foo', 'src/a.ts'), sym('bar', 'src/a.ts')]],
      ['src/b.ts', [sym('baz', 'src/b.ts')]],
    ]);
    const allSymbols = [...symbols.values()].flat();

    const graph = await buildGraphIndex(symbols, allSymbols, [], [], tmp);

    // symbolsByName is keyed by symbol name, not by file path
    expect(graph.symbolsByName.get('foo')).toHaveLength(1);
    expect(graph.symbolsByName.get('bar')).toHaveLength(1);
    expect(graph.symbolsByName.get('baz')).toHaveLength(1);
    expect(graph.symbolsByName.get('src/a.ts')).toBeUndefined();
  });

  it('resolves relative imports between known files', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-graph-'));
    // Use flat structure so join('src', './orchestrator') = 'src/orchestrator'
    // which matches the knownPath 'src/orchestrator.ts' after .ts extension appended
    const symbols = new Map([
      ['src/worker.ts', [sym('processRecord', 'src/worker.ts')]],
      ['src/orchestrator.ts', [sym('runJob', 'src/orchestrator.ts')]],
    ]);
    const allSymbols = [...symbols.values()].flat();
    const imports: ImportRecord[] = [
      imp('src/worker.ts', './orchestrator', ['runJob']),
    ];

    const graph = await buildGraphIndex(symbols, allSymbols, imports, [], tmp);

    // worker.ts should depend on orchestrator.ts
    const deps = graph.dependsOn.get('src/worker.ts') ?? [];
    expect(deps).toContain('src/orchestrator.ts');

    // orchestrator.ts should be imported by worker.ts
    const rev = graph.importedBy.get('src/orchestrator.ts') ?? [];
    expect(rev).toContain('src/worker.ts');
  });

  it('ignores bare package imports (non-relative specifiers)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-graph-'));
    const symbols = new Map([['src/a.ts', [sym('a', 'src/a.ts')]]]);
    const allSymbols = [...symbols.values()].flat();
    const imports: ImportRecord[] = [
      imp('src/a.ts', 'zod'),
      imp('src/a.ts', '@slack/web-api'),
    ];

    const graph = await buildGraphIndex(symbols, allSymbols, imports, [], tmp);
    // Package imports should not create dependency edges
    expect(graph.dependsOn.get('src/a.ts') ?? []).toHaveLength(0);
  });

  it('records inheritance relationships', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-graph-'));
    const symbols = new Map([
      ['src/base.ts', [sym('Base', 'src/base.ts', 'class')]],
      ['src/child.ts', [sym('Child', 'src/child.ts', 'class')]],
    ]);
    const allSymbols = [...symbols.values()].flat();
    const inheritance: InheritanceRecord[] = [
      inh('src/child.ts', 'Child', 'Base'),
    ];

    const graph = await buildGraphIndex(symbols, allSymbols, [], inheritance, tmp);

    expect(graph.inheritance).toHaveLength(1);
    expect(graph.parentOf.get('Child')).toContain('Base');
    expect(graph.childrenOf.get('Base')).toContain('Child');
  });

  it('deduplicates dependency edges', async () => {
    // Two import records pointing to the same file should only create one edge
    const tmp = await mkdtemp(join(tmpdir(), 'bc-graph-'));
    const symbols = new Map([
      ['src/a.ts', [sym('a', 'src/a.ts')]],
      ['src/b.ts', [sym('b1', 'src/b.ts'), sym('b2', 'src/b.ts')]],
    ]);
    const allSymbols = [...symbols.values()].flat();
    const imports: ImportRecord[] = [
      imp('src/a.ts', './b', ['b1']),
      imp('src/a.ts', './b', ['b2']), // same file, different named import
    ];

    const graph = await buildGraphIndex(symbols, allSymbols, imports, [], tmp);
    const deps = graph.dependsOn.get('src/a.ts') ?? [];
    // Should only have one edge to src/b.ts
    expect(deps.filter((d) => d === 'src/b.ts')).toHaveLength(1);
  });
});
