import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/index/symbolIndex';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

describe('symbolIndex — extractFile', () => {
  it('extracts runJob from the real orchestrator.ts', async () => {
    const absPath = join(REPO_ROOT, 'src/orchestrator/orchestrator.ts');
    const result = await extractFile(absPath, 'src/orchestrator/orchestrator.ts');

    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain('runJob');
  });

  it('finds the runJob symbol with kind "function"', async () => {
    const absPath = join(REPO_ROOT, 'src/orchestrator/orchestrator.ts');
    const result = await extractFile(absPath, 'src/orchestrator/orchestrator.ts');

    const runJob = result!.symbols.find((s) => s.name === 'runJob');
    expect(runJob).toBeDefined();
    expect(runJob!.kind).toBe('function');
    expect(runJob!.startLine).toBeGreaterThan(0);
    expect(runJob!.endLine).toBeGreaterThanOrEqual(runJob!.startLine);
  });

  it('extracts imports from orchestrator.ts', async () => {
    const absPath = join(REPO_ROOT, 'src/orchestrator/orchestrator.ts');
    const result = await extractFile(absPath, 'src/orchestrator/orchestrator.ts');

    expect(result).not.toBeNull();
    expect(result!.imports.length).toBeGreaterThan(0);
    // Should see an import from the types module
    const typeImport = result!.imports.find((i) => i.rawSpecifier.includes('types'));
    expect(typeImport).toBeDefined();
  });

  it('extracts class symbols from a synthesized TypeScript snippet', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-sym-'));
    const source = `
export class MyService {
  constructor(private name: string) {}
  async doWork(): Promise<void> {
    return;
  }
}
export function helper(x: number): number {
  return x * 2;
}
export interface ServiceConfig {
  timeout: number;
}
`.trim();
    const absPath = join(tmp, 'service.ts');
    await writeFile(absPath, source, 'utf8');

    const result = await extractFile(absPath, 'service.ts');
    expect(result).not.toBeNull();

    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain('MyService');
    expect(names).toContain('helper');
    expect(names).toContain('ServiceConfig');

    const cls = result!.symbols.find((s) => s.name === 'MyService')!;
    expect(cls.kind).toBe('class');

    const fn = result!.symbols.find((s) => s.name === 'helper')!;
    expect(fn.kind).toBe('function');

    const iface = result!.symbols.find((s) => s.name === 'ServiceConfig')!;
    expect(iface.kind).toBe('interface');
  });

  it('returns null for unsupported file types', async () => {
    const result = await extractFile('/some/file.yaml', 'config.yaml');
    expect(result).toBeNull();
  });

  it('file path in each symbol matches the relPath argument', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bc-sym-'));
    const source = 'export function ping() { return "pong"; }';
    const absPath = join(tmp, 'ping.ts');
    await writeFile(absPath, source, 'utf8');

    const result = await extractFile(absPath, 'src/util/ping.ts');
    expect(result).not.toBeNull();
    for (const sym of result!.symbols) {
      expect(sym.file).toBe('src/util/ping.ts');
    }
  });
});
