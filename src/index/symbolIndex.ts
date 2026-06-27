/**
 * Symbol index — extracts code symbols from repository files using Tree-sitter.
 *
 * Supports: TypeScript, TSX, JavaScript, JSX, Python, Ruby, Go, Rust, Java,
 * Kotlin, C# — anything that has a grammar in tree-sitter-wasms.
 *
 * A SymbolRecord is intentionally lightweight: name, kind, signature (first
 * line), location, optional doc comment, and optional parent class name.
 * It is serializable to JSON so the index can be cached between jobs.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Parser from 'web-tree-sitter';
import type { AccessConfig } from '../config/schema';
import { isPathDenied } from '../tools/pathGuard';
import { extensionFromPath, getParserForFile, isIndexable } from './languageRegistry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'import';

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** First source line of the declaration — acts as a short signature. */
  signature: string;
  /** Repo-relative POSIX path. */
  file: string;
  startLine: number; // 1-based
  endLine: number;   // 1-based
  docComment?: string;
  /** Enclosing class/struct name for methods. */
  parentName?: string;
  /** Raw import specifier for `kind === 'import'` records (e.g. './foo'). */
  importSpecifier?: string;
}

export interface ImportRecord {
  fromFile: string;       // repo-relative path of the importer
  rawSpecifier: string;   // './foo' or 'some-package'
  importedNames: string[];
  isStar: boolean;
  isDefault: boolean;
}

export interface InheritanceRecord {
  childFile: string;
  childName: string;
  parentName: string;
  kind: 'extends' | 'implements';
}

// ---------------------------------------------------------------------------
// Per-language node-type → SymbolKind mappings
// ---------------------------------------------------------------------------

const KINDS: Record<string, Record<string, SymbolKind>> = {
  typescript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
    method_definition: 'method',
    method_signature: 'method',
    abstract_method_signature: 'method',
  },
  javascript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    method_definition: 'method',
  },
  python: {
    function_definition: 'function',
    async_function_definition: 'function',
    class_definition: 'class',
  },
  ruby: {
    method: 'function',
    singleton_method: 'function',
    class: 'class',
    module: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
  rust: {
    function_item: 'function',
    struct_item: 'class',
    enum_item: 'enum',
    impl_item: 'class',
    trait_item: 'interface',
    type_item: 'type',
  },
  java: {
    method_declaration: 'method',
    constructor_declaration: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    annotation_type_declaration: 'interface',
    record_declaration: 'class',
  },
  kotlin: {
    function_declaration: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    object_declaration: 'class',
    type_alias: 'type',
  },
  c_sharp: {
    method_declaration: 'method',
    constructor_declaration: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'class',
  },
};
// TSX shares TypeScript grammar rules
KINDS.tsx = KINDS.typescript;
// JSX shares JavaScript grammar rules
KINDS.jsx = KINDS.javascript;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the canonical name of a symbol node via the 'name' field or first identifier. */
function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text.trim();
  for (const child of node.namedChildren) {
    if (
      child.type === 'identifier' ||
      child.type === 'type_identifier' ||
      child.type === 'property_identifier' ||
      child.type === 'field_identifier'
    ) {
      return child.text.trim();
    }
  }
  return null;
}

/**
 * Extract JSDoc/docstring from the node preceding this one, or from the
 * Python function body's first string literal.
 */
function getDocComment(node: Parser.SyntaxNode, sourceLines: string[]): string | undefined {
  // TypeScript / JavaScript: `/** ... */` or `//` immediately before
  const prev = node.previousNamedSibling;
  if (prev?.type === 'comment') {
    const t = prev.text;
    if (t.startsWith('/**')) {
      return t
        .replace(/^\/\*\*\s*/, '')
        .replace(/\s*\*\/$/, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim()
        .slice(0, 400);
    }
    if (t.startsWith('//')) {
      return t.replace(/^\/\/\s*/, '').trim().slice(0, 400);
    }
    if (t.startsWith('#')) {
      return t.replace(/^#\s*/, '').trim().slice(0, 400);
    }
  }
  // Python: docstring as first statement in body
  if (
    node.type === 'function_definition' ||
    node.type === 'async_function_definition' ||
    node.type === 'class_definition'
  ) {
    const body = node.childForFieldName('body');
    if (body) {
      const first = body.namedChildren[0];
      if (first?.type === 'expression_statement') {
        const inner = first.namedChildren[0];
        if (inner?.type === 'string') {
          return inner.text.replace(/^['"`]{1,3}|['"`]{1,3}$/g, '').trim().slice(0, 400);
        }
      }
    }
  }
  void sourceLines; // unused; kept for future snippet extraction
  return undefined;
}

/** Extract the source module specifier string from an import node. */
function extractImportSpecifier(node: Parser.SyntaxNode): string | null {
  // TS/JS: (import_statement ... (string "'./foo'"))
  // Walk backwards to find the string node (the module specifier)
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'string') {
      return child.text.replace(/^['"`]|['"`]$/g, '');
    }
    // Python: module_name field
    const mod = node.childForFieldName('module_name');
    if (mod) return mod.text;
  }
  return null;
}

/** Collect all identifier names imported by an import_statement. */
function extractImportedNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  function walk(n: Parser.SyntaxNode): void {
    if (
      (n.type === 'identifier' || n.type === 'type_identifier') &&
      n.parent?.type !== 'string'
    ) {
      names.push(n.text);
    }
    for (const child of n.namedChildren) {
      // Don't descend into the source string
      if (child.type !== 'string') walk(child);
    }
  }
  for (const child of node.namedChildren) {
    if (child.type !== 'string') walk(child);
  }
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Core extractor
// ---------------------------------------------------------------------------

interface ExtractResult {
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  inheritance: InheritanceRecord[];
}

export function extractFromSource(
  source: string,
  relPath: string,
  grammarName: string,
  tree: Parser.Tree,
): ExtractResult {
  const symbols: SymbolRecord[] = [];
  const imports: ImportRecord[] = [];
  const inheritance: InheritanceRecord[] = [];
  const kindMap = KINDS[grammarName] ?? {};
  const sourceLines = source.split('\n');

  function recordInheritance(node: Parser.SyntaxNode, childName: string): void {
    // TypeScript: class_heritage → extends_clause, implements_clause
    const heritage = node.childForFieldName('class_heritage') ??
                     node.children.find((c) => c.type === 'class_heritage') ?? null;
    if (heritage) {
      for (const clause of heritage.namedChildren) {
        const kind = clause.type === 'extends_clause' ? 'extends' : 'implements';
        for (const typeNode of clause.namedChildren) {
          if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier') {
            inheritance.push({ childFile: relPath, childName, parentName: typeNode.text, kind });
          }
        }
      }
    }
    // Python: class_definition → argument_list (base classes)
    const args = node.childForFieldName('superclasses') ??
                 node.children.find((c) => c.type === 'argument_list') ?? null;
    if (args) {
      for (const arg of args.namedChildren) {
        if (arg.type === 'identifier') {
          inheritance.push({ childFile: relPath, childName, parentName: arg.text, kind: 'extends' });
        }
      }
    }
  }

  function walk(node: Parser.SyntaxNode, parentName: string | undefined): void {
    const type = node.type;

    // ------- Import statements -------
    if (type === 'import_statement' || type === 'import_from_statement') {
      const specifier = extractImportSpecifier(node);
      if (specifier) {
        const importedNames = extractImportedNames(node);
        const isStar = node.text.includes('* as') || node.text.includes('import *');
        const isDefault =
          (node.childForFieldName('import_clause')?.namedChildren[0]?.type === 'identifier') ??
          false;
        imports.push({ fromFile: relPath, rawSpecifier: specifier, importedNames, isStar, isDefault });
      }
      // Don't recurse into import children — they're not symbols
      return;
    }

    // ------- Variable declarator with function value (common TS/JS pattern) -------
    if (type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (
        nameNode &&
        valueNode &&
        (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
      ) {
        const sig = sourceLines[node.startPosition.row]?.trim() ?? '';
        symbols.push({
          name: nameNode.text,
          kind: 'function',
          signature: sig.slice(0, 200),
          file: relPath,
          startLine: node.startPosition.row + 1,
          endLine: valueNode.endPosition.row + 1,
          ...(parentName ? { parentName } : {}),
        });
        // Recurse into arrow function body for nested symbols
        walk(valueNode, parentName);
        return;
      }
    }

    // ------- Named symbol types -------
    const kind = kindMap[type];
    if (kind) {
      const name = getNodeName(node);
      if (name) {
        const sig = sourceLines[node.startPosition.row]?.trim() ?? '';
        const doc = getDocComment(node, sourceLines);
        symbols.push({
          name,
          kind,
          signature: sig.slice(0, 200),
          file: relPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...(doc ? { docComment: doc } : {}),
          ...(parentName ? { parentName } : {}),
        });
        // Track inheritance for class-like nodes
        if (kind === 'class') {
          recordInheritance(node, name);
        }
        // Set parentName for children of class bodies
        const newParent = kind === 'class' ? name : parentName;
        for (const child of node.namedChildren) {
          walk(child, newParent);
        }
        return;
      }
    }

    // ------- Recurse -------
    for (const child of node.namedChildren) {
      walk(child, parentName);
    }
  }

  walk(tree.rootNode, undefined);
  return { symbols, imports, inheritance };
}

// ---------------------------------------------------------------------------
// File-level extraction (async, with parser)
// ---------------------------------------------------------------------------

/** Max file size to index (1 MB). Larger files are skipped. */
const MAX_INDEX_FILE_BYTES = 1_048_576;

/**
 * Parse and extract symbols from a single file.
 * Returns null if the file type is unsupported, too large, or parse fails.
 */
export async function extractFile(absPath: string, relPath: string): Promise<ExtractResult | null> {
  const parserResult = await getParserForFile(relPath);
  if (!parserResult) return null;
  const { parser, grammarName } = parserResult;

  let source: string;
  try {
    const buf = await readFile(absPath);
    if (buf.length > MAX_INDEX_FILE_BYTES) return null;
    source = buf.toString('utf8');
  } catch {
    return null;
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    return null;
  }

  return extractFromSource(source, relPath, grammarName, tree);
}

// ---------------------------------------------------------------------------
// Repo-level walk
// ---------------------------------------------------------------------------

/** Default globs to always exclude from indexing. */
const ALWAYS_SKIP = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage',
  '__pycache__', '.mypy_cache', '.pytest_cache', 'vendor', '.yarn',
];

function shouldSkipDir(name: string): boolean {
  return ALWAYS_SKIP.includes(name) || name.startsWith('.');
}

export interface FileChunk {
  relPath: string;
  content: string;
}

export interface RepoIndexResult {
  symbols: Map<string, SymbolRecord[]>;
  allSymbols: SymbolRecord[];
  imports: ImportRecord[];
  inheritance: InheritanceRecord[];
  /** Raw file contents for BM25 indexing (source files only, ≤MAX_INDEX_FILE_BYTES). */
  fileChunks: FileChunk[];
}

/**
 * Walk the entire repo, extract symbols and import edges from all indexable
 * files. Respects the access denyGlobs from config.
 */
export async function buildRepoIndex(
  worktreeRoot: string,
  access: AccessConfig,
): Promise<RepoIndexResult> {
  const symbols = new Map<string, SymbolRecord[]>();
  const allSymbols: SymbolRecord[] = [];
  const imports: ImportRecord[] = [];
  const inheritance: InheritanceRecord[] = [];
  const fileChunks: FileChunk[] = [];

  async function walkDir(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absPath = join(absDir, entry.name);
        const relPath = relative(worktreeRoot, absPath).split('\\').join('/');

        if (entry.isDirectory()) {
          if (shouldSkipDir(entry.name)) return;
          if (isPathDenied(relPath, access)) return;
          return walkDir(absPath);
        }

        if (!entry.isFile()) return;
        if (isPathDenied(relPath, access)) return;
        if (!isIndexable(relPath)) return;

        const extracted = await extractFile(absPath, relPath);
        if (extracted) {
          symbols.set(relPath, extracted.symbols);
          allSymbols.push(...extracted.symbols);
          imports.push(...extracted.imports);
          inheritance.push(...extracted.inheritance);
        }

        // Collect file content for BM25 indexing (any text file, not just indexable)
        try {
          const st = await stat(absPath);
          if (st.size <= MAX_INDEX_FILE_BYTES) {
            const content = await readFile(absPath, 'utf8');
            fileChunks.push({ relPath, content });
          }
        } catch {
          /* skip */
        }
      }),
    );
  }

  await walkDir(worktreeRoot);
  return { symbols, allSymbols, imports, inheritance, fileChunks };
}
