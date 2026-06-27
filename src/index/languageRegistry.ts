/**
 * Language registry for Tree-sitter parsers.
 * Manages one-time WASM initialization and per-language grammar loading.
 * All parsers are singletons reused across the Lambda instance lifetime.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';

const _req = createRequire(import.meta.url);
// __dirname equivalent for ESM — points to src/index/
const _dir = dirname(fileURLToPath(import.meta.url));
// Resolved node_modules root (two levels up from src/index/).
const _nodeModules = join(_dir, '..', '..', 'node_modules');

/** Maps lowercase file extension → tree-sitter-wasms grammar name. */
const EXT_TO_GRAMMAR: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'c_sharp',
};

let _initPromise: Promise<void> | null = null;
const _langs = new Map<string, Parser.Language>();
const _parsers = new Map<string, Parser>();

/** Resolve the directory containing a given npm package. */
function pkgDir(pkgName: string): string {
  // Try the require-resolution path first (works for packages with a valid main entry).
  // Fall back to direct node_modules navigation for packages whose main entry is missing.
  try {
    return dirname(_req.resolve(pkgName));
  } catch {
    return join(_nodeModules, pkgName);
  }
}

/**
 * One-time WASM initialization. Safe to call concurrently — the promise is
 * shared so init runs exactly once per process.
 */
function ensureInit(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const wasmPath = join(pkgDir('web-tree-sitter'), 'tree-sitter.wasm');
      const wasmBinary = await readFile(wasmPath);
      await (Parser as unknown as { init(opts: unknown): Promise<void> }).init({ wasmBinary });
    })();
  }
  return _initPromise;
}

export function extensionFromPath(filePath: string): string {
  const i = filePath.lastIndexOf('.');
  return i >= 0 ? filePath.slice(i + 1).toLowerCase() : '';
}

export function grammarForExt(ext: string): string | undefined {
  return EXT_TO_GRAMMAR[ext];
}

/** Returns true if this file extension has a Tree-sitter grammar. */
export function isIndexable(filePath: string): boolean {
  return EXT_TO_GRAMMAR[extensionFromPath(filePath)] !== undefined;
}

/**
 * Returns a ready-to-use (parser, language) pair for the given file path.
 * Returns null if the file type is unsupported or if the WASM grammar file
 * is not present in tree-sitter-wasms (graceful fallback).
 */
export async function getParserForFile(
  filePath: string,
): Promise<{ parser: Parser; language: Parser.Language; grammarName: string } | null> {
  const ext = extensionFromPath(filePath);
  const grammarName = EXT_TO_GRAMMAR[ext];
  if (!grammarName) return null;

  await ensureInit();

  if (!_langs.has(grammarName)) {
    try {
      const wasmPath = join(pkgDir('tree-sitter-wasms'), 'out', `tree-sitter-${grammarName}.wasm`);
      const wasmBinary = await readFile(wasmPath);
      const lang = await Parser.Language.load(wasmBinary);
      _langs.set(grammarName, lang);
    } catch {
      // Grammar WASM not available for this language — skip silently.
      return null;
    }
  }

  const language = _langs.get(grammarName)!;

  if (!_parsers.has(grammarName)) {
    const p = new Parser();
    p.setLanguage(language);
    _parsers.set(grammarName, p);
  }

  return { parser: _parsers.get(grammarName)!, language, grammarName };
}
