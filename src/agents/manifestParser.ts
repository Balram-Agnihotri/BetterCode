import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentManifest, ToolName } from '../types';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Aliases accepted in manifests, normalized to canonical tool names. */
const TOOL_ALIASES: Record<string, ToolName> = {
  read: 'read',
  read_file: 'read',
  search: 'search',
  grep: 'search',
  agent: 'agent',
  subagent: 'agent',
  task: 'agent',
};

export class ManifestError extends Error {
  constructor(message: string, public readonly sourcePath: string) {
    super(`${message} (${sourcePath})`);
    this.name = 'ManifestError';
  }
}

/**
 * Parse a `.github/agents/<name>.md` manifest into a validated AgentManifest.
 * Deterministic and pure: same input always yields the same output, which makes
 * the loader unit-testable without a filesystem.
 */
export function parseAgentManifest(content: string, sourcePath: string): AgentManifest {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new ManifestError('missing YAML frontmatter block (--- ... ---)', sourcePath);
  }
  const [, frontmatterRaw, body] = match;

  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(frontmatterRaw ?? '') ?? {}) as Record<string, unknown>;
  } catch (err) {
    throw new ManifestError(`invalid frontmatter YAML: ${(err as Error).message}`, sourcePath);
  }

  const fileStem = basename(sourcePath)
    .replace(/\.agent\.md$/i, '')
    .replace(/\.md$/i, '');
  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fileStem;

  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  if (!description) {
    throw new ManifestError('frontmatter "description" is required', sourcePath);
  }

  const { tools, unsupported } = normalizeTools(fm.tools, sourcePath);
  const subagents = normalizeStringArray(fm.subagents);

  // A manifest that declares subagents must also hold the `agent` tool.
  if (subagents.length > 0 && !tools.includes('agent')) {
    throw new ManifestError(
      `declares subagents [${subagents.join(', ')}] but is not granted the "agent" tool`,
      sourcePath,
    );
  }
  if (subagents.includes(name)) {
    throw new ManifestError('agent lists itself as a subagent', sourcePath);
  }

  const model = typeof fm.model === 'string' ? fm.model.trim() : undefined;
  const argumentHint =
    typeof fm['argument-hint'] === 'string'
      ? (fm['argument-hint'] as string).trim()
      : typeof fm.argumentHint === 'string'
        ? (fm.argumentHint as string).trim()
        : undefined;

  const systemPrompt = (body ?? '').trim();
  if (!systemPrompt) {
    throw new ManifestError('manifest body (system prompt) is empty', sourcePath);
  }

  return {
    name,
    description,
    tools,
    unsupportedTools: unsupported,
    subagents,
    ...(model ? { model } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    systemPrompt,
    sourcePath,
  };
}

/**
 * Normalize a manifest `tools` list to BetterCode's known tools. Tools this
 * runtime does not implement (e.g. `edit`, `execute`, MCP tools) are dropped and
 * returned as `unsupported` rather than rejected — BetterCode simply never
 * grants them, which is exactly the safety property we want when a manifest is
 * shared with other agent runtimes.
 */
function normalizeTools(
  value: unknown,
  sourcePath: string,
): { tools: ToolName[]; unsupported: string[] } {
  if (value === undefined) return { tools: [], unsupported: [] };
  if (!Array.isArray(value)) {
    throw new ManifestError('"tools" must be a list', sourcePath);
  }
  const tools = new Set<ToolName>();
  const unsupported = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new ManifestError(`tool entry is not a string: ${JSON.stringify(raw)}`, sourcePath);
    }
    const canonical = TOOL_ALIASES[raw.trim().toLowerCase()];
    if (canonical) tools.add(canonical);
    else unsupported.add(raw.trim());
  }
  return { tools: [...tools], unsupported: [...unsupported] };
}

function normalizeStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()))];
}
