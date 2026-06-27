/**
 * Symbol-aware tools — give the LLM direct access to the repository symbol
 * index instead of forcing it to infer everything from raw text searches.
 *
 * All tools gracefully degrade (returning an informative message) when the
 * knowledge base has not been built or is empty, so jobs continue to work
 * with the plain rg/read fallback.
 */
import { z } from 'zod';
import { ok, toolError, githubBlobUrl, type ToolDefinition, type ToolContext } from './types';
import type { SymbolRecord } from '../index/symbolIndex';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSymbol(sym: SymbolRecord, snapshot: { githubWebBaseUrl: string; commitSha: string }): string {
  const loc = `${sym.file}:${sym.startLine}`;
  const url = githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, sym.file, sym.startLine, sym.endLine);
  const doc = sym.docComment ? `\n    doc: ${sym.docComment.split('\n')[0]?.slice(0, 120)}` : '';
  const parent = sym.parentName ? ` [in ${sym.parentName}]` : '';
  return `${sym.kind} \`${sym.name}\`${parent} — ${sym.signature.slice(0, 120)}\n    at ${loc} (${url})${doc}`;
}

function kbMissing(): ReturnType<typeof ok> {
  return ok({
    content:
      'Repository index not available (index may still be building or this repo is too large). ' +
      'Fall back to the `search` tool.',
    citations: [],
    meta: { indexAvailable: false },
    truncated: false,
  });
}

// ---------------------------------------------------------------------------
// findSymbol
// ---------------------------------------------------------------------------

const findSymbolInput = z.object({
  name: z.string().min(1).describe('Symbol name to look for (exact or fuzzy).'),
  kind: z
    .enum(['function', 'method', 'class', 'interface', 'type', 'enum', 'constant', 'variable'])
    .optional()
    .describe('Optional: restrict to this symbol kind.'),
  fuzzy: z.boolean().optional().describe('Allow substring/prefix matches. Default false.'),
  maxResults: z.number().int().positive().max(50).optional(),
});

export const findSymbolTool: ToolDefinition<z.infer<typeof findSymbolInput>> = {
  name: 'findSymbol',
  description:
    'Find a code symbol (function, class, interface, type, enum, method) by name in the repository index. ' +
    'Returns location, signature, and documentation. Much faster than searching for symbols — use this ' +
    'instead of `search` when you know the symbol name.',
  inputSchema: findSymbolInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Symbol name to find.' },
      kind: {
        type: 'string',
        enum: ['function', 'method', 'class', 'interface', 'type', 'enum', 'constant', 'variable'],
        description: 'Restrict to this symbol kind.',
      },
      fuzzy: { type: 'boolean', description: 'Allow prefix/substring matches. Default false.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase, snapshot } = ctx;
    if (!knowledgeBase) return kbMissing();

    const matches = knowledgeBase.findSymbols(input.name, {
      kind: input.kind,
      fuzzy: input.fuzzy ?? false,
      maxResults: input.maxResults ?? 20,
    });

    if (matches.length === 0) {
      return ok({
        content: `No symbol named \`${input.name}\` found${input.kind ? ` of kind ${input.kind}` : ''}. Try fuzzy:true or use the \`search\` tool.`,
        citations: [],
        meta: { name: input.name, found: 0 },
        truncated: false,
      });
    }

    const lines = matches.map((sym) => formatSymbol(sym, snapshot));
    return ok({
      content: `Found ${matches.length} symbol(s) matching \`${input.name}\`:\n\n${lines.join('\n\n')}`,
      citations: matches.map((sym) => ({
        path: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, sym.file, sym.startLine, sym.endLine),
      })),
      meta: { name: input.name, found: matches.length },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// workspaceSymbols
// ---------------------------------------------------------------------------

const wsSymbolsInput = z.object({
  query: z.string().min(1).describe('Free-text query to match against symbol names.'),
  maxResults: z.number().int().positive().max(50).optional(),
});

export const workspaceSymbolsTool: ToolDefinition<z.infer<typeof wsSymbolsInput>> = {
  name: 'workspaceSymbols',
  description:
    'Fuzzy-search all symbols across the entire repository by name. Returns the top matches with ' +
    'locations and signatures. Use for broad exploration when you know part of a name.',
  inputSchema: wsSymbolsInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query (substring or prefix of a symbol name).' },
      maxResults: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase, snapshot } = ctx;
    if (!knowledgeBase) return kbMissing();

    const matches = knowledgeBase.findSymbols(input.query, {
      fuzzy: true,
      maxResults: input.maxResults ?? 25,
    });

    if (matches.length === 0) {
      return ok({
        content: `No symbols matched \`${input.query}\`. Try a shorter prefix or use the \`search\` tool.`,
        citations: [],
        meta: { query: input.query, found: 0 },
        truncated: false,
      });
    }

    const lines = matches.map((sym) => formatSymbol(sym, snapshot));
    return ok({
      content: `${matches.length} symbol(s) matching \`${input.query}\`:\n\n${lines.join('\n\n')}`,
      citations: matches.map((sym) => ({
        path: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, sym.file, sym.startLine, sym.endLine),
      })),
      meta: { query: input.query, found: matches.length },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// goToDefinition
// ---------------------------------------------------------------------------

const goToDefInput = z.object({
  symbol: z.string().min(1).describe('Symbol name to find the definition of.'),
  contextFile: z.string().optional().describe('Optional: prefer definitions visible from this file.'),
});

export const goToDefinitionTool: ToolDefinition<z.infer<typeof goToDefInput>> = {
  name: 'goToDefinition',
  description:
    'Find the definition location of a symbol — where it is declared, not where it is used. ' +
    'Returns the file, line number, and signature. Equivalent to IDE "Go to Definition".',
  inputSchema: goToDefInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['symbol'],
    properties: {
      symbol: { type: 'string', description: 'Symbol name.' },
      contextFile: { type: 'string', description: 'Optional file path for disambiguation.' },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase, snapshot } = ctx;
    if (!knowledgeBase) return kbMissing();

    let matches = knowledgeBase.findSymbols(input.symbol, { fuzzy: false, maxResults: 10 });

    // If contextFile given, prefer definitions from files imported by it
    if (input.contextFile && matches.length > 1) {
      const deps = knowledgeBase.graph.dependsOn.get(input.contextFile) ?? [];
      const fromDeps = matches.filter((m) => deps.includes(m.file));
      if (fromDeps.length > 0) matches = fromDeps;
    }

    if (matches.length === 0) {
      return ok({
        content: `Definition of \`${input.symbol}\` not found in the symbol index. Try \`search\` for its declaration.`,
        citations: [],
        meta: { symbol: input.symbol, found: 0 },
        truncated: false,
      });
    }

    const lines = matches.slice(0, 5).map((sym) => formatSymbol(sym, snapshot));
    return ok({
      content: `Definition(s) of \`${input.symbol}\`:\n\n${lines.join('\n\n')}`,
      citations: matches.slice(0, 5).map((sym) => ({
        path: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, sym.file, sym.startLine, sym.endLine),
      })),
      meta: { symbol: input.symbol, found: matches.length },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// findReferences
// ---------------------------------------------------------------------------

const findRefsInput = z.object({
  symbol: z.string().min(1).describe('Symbol name to find references/usages of.'),
  maxResults: z.number().int().positive().max(50).optional(),
});

export const findReferencesTool: ToolDefinition<z.infer<typeof findRefsInput>> = {
  name: 'findReferences',
  description:
    'Find all usages/call-sites of a symbol across the repository. Returns file locations. ' +
    'Uses the BM25 text index for approximation (not a true semantic reference graph). ' +
    'Equivalent to IDE "Find All References".',
  inputSchema: findRefsInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['symbol'],
    properties: {
      symbol: { type: 'string', description: 'Symbol name to find references to.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase, snapshot } = ctx;
    if (!knowledgeBase) return kbMissing();

    const refs = knowledgeBase.findReferences(input.symbol, input.maxResults ?? 30);

    if (refs.length === 0) {
      return ok({
        content: `No references to \`${input.symbol}\` found via text index.`,
        citations: [],
        meta: { symbol: input.symbol, found: 0 },
        truncated: false,
      });
    }

    const lines = refs.map((r) => {
      const url = githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, r.file, r.line, r.line);
      return `  ${r.file}:${r.line} (${url})`;
    });

    return ok({
      content: `References to \`${input.symbol}\` (${refs.length} location(s)):\n${lines.join('\n')}`,
      citations: refs.map((r) => ({
        path: r.file,
        startLine: r.line,
        endLine: r.line,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, r.file, r.line, r.line),
      })),
      meta: { symbol: input.symbol, found: refs.length },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// callHierarchy
// ---------------------------------------------------------------------------

const callHierarchyInput = z.object({
  symbol: z.string().min(1).describe('Symbol name to show call hierarchy for.'),
});

export const callHierarchyTool: ToolDefinition<z.infer<typeof callHierarchyInput>> = {
  name: 'callHierarchy',
  description:
    'Show the call hierarchy for a symbol: where it is defined AND where it is referenced (approximate). ' +
    'Use this to understand what calls a function or what a function calls.',
  inputSchema: callHierarchyInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['symbol'],
    properties: {
      symbol: { type: 'string', description: 'Symbol name.' },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase, snapshot } = ctx;
    if (!knowledgeBase) return kbMissing();

    const defs = knowledgeBase.findSymbols(input.symbol, { fuzzy: false, maxResults: 5 });
    const refs = knowledgeBase.findReferences(input.symbol, 20);

    if (defs.length === 0 && refs.length === 0) {
      return ok({
        content: `\`${input.symbol}\` not found in the symbol index. Try \`search\` for its name.`,
        citations: [],
        meta: { symbol: input.symbol },
        truncated: false,
      });
    }

    const parts: string[] = [`**Call hierarchy for \`${input.symbol}\`**\n`];

    if (defs.length > 0) {
      parts.push('**Definition:**');
      parts.push(...defs.map((sym) => `  ${formatSymbol(sym, snapshot)}`));
    }

    if (refs.length > 0) {
      parts.push(`\n**Referenced from (${refs.length} location(s)):**`);
      parts.push(
        ...refs.slice(0, 15).map((r) => {
          const url = githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, r.file, r.line, r.line);
          return `  ${r.file}:${r.line} — ${url}`;
        }),
      );
      if (refs.length > 15) parts.push(`  … and ${refs.length - 15} more`);
    }

    const allCitations = [
      ...defs.map((sym) => ({
        path: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, sym.file, sym.startLine, sym.endLine),
      })),
      ...refs.slice(0, 15).map((r) => ({
        path: r.file,
        startLine: r.line,
        endLine: r.line,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, r.file, r.line, r.line),
      })),
    ];

    return ok({
      content: parts.join('\n'),
      citations: allCitations,
      meta: { symbol: input.symbol, definitions: defs.length, references: refs.length },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// documentSymbols
// ---------------------------------------------------------------------------

const docSymbolsInput = z.object({
  path: z.string().min(1).describe('Repo-relative path to the file.'),
});

export const documentSymbolsTool: ToolDefinition<z.infer<typeof docSymbolsInput>> = {
  name: 'documentSymbols',
  description:
    'List all symbols defined in a specific file (functions, classes, methods, types, etc.) ' +
    'ordered by line number. Use this to understand the structure of a file without reading it entirely.',
  inputSchema: docSymbolsInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Repo-relative path to the file.' },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { knowledgeBase, snapshot } = ctx;
    if (!knowledgeBase) return kbMissing();

    const syms = knowledgeBase.symbolsInFile(input.path);

    if (syms.length === 0) {
      return ok({
        content: `No symbols found in \`${input.path}\`. The file may not be indexed (unsupported language) or may contain no top-level declarations.`,
        citations: [],
        meta: { path: input.path, found: 0 },
        truncated: false,
      });
    }

    const sorted = [...syms].sort((a, b) => a.startLine - b.startLine);
    const lines = sorted.map((sym) => {
      const parent = sym.parentName ? ` [in ${sym.parentName}]` : '';
      return `  L${sym.startLine}: ${sym.kind} \`${sym.name}\`${parent} — ${sym.signature.slice(0, 100)}`;
    });

    return ok({
      content: `**${input.path}** — ${syms.length} symbol(s):\n${lines.join('\n')}`,
      citations: sorted.map((sym) => ({
        path: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        commitSha: snapshot.commitSha,
        url: githubBlobUrl(snapshot.githubWebBaseUrl, snapshot.commitSha, sym.file, sym.startLine, sym.endLine),
      })),
      meta: { path: input.path, found: syms.length },
      truncated: false,
    });
  },
};
