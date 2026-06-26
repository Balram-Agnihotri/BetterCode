import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentManifest } from '../types';
import { ManifestError, parseAgentManifest } from './manifestParser';

/** An immutable, validated set of agents for one project. */
export class AgentRegistry {
  private constructor(private readonly agents: ReadonlyMap<string, AgentManifest>) {}

  static fromManifests(manifests: AgentManifest[]): AgentRegistry {
    const map = new Map<string, AgentManifest>();
    for (const m of manifests) {
      if (map.has(m.name)) {
        throw new ManifestError(`duplicate agent name "${m.name}"`, m.sourcePath);
      }
      map.set(m.name, m);
    }
    // Validate every declared subagent resolves to a real agent.
    for (const m of map.values()) {
      for (const sub of m.subagents) {
        if (!map.has(sub)) {
          throw new ManifestError(
            `agent "${m.name}" references unknown subagent "${sub}"`,
            m.sourcePath,
          );
        }
      }
    }
    return new AgentRegistry(map);
  }

  get(name: string): AgentManifest {
    const a = this.agents.get(name);
    if (!a) throw new Error(`agent "${name}" not found in registry`);
    return a;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  /** Whether `parent` is permitted to spawn `child` per its manifest. */
  canDelegate(parent: string, child: string): boolean {
    const p = this.agents.get(parent);
    return !!p && p.tools.includes('agent') && p.subagents.includes(child);
  }

  list(): AgentManifest[] {
    return [...this.agents.values()];
  }
}

/**
 * Load all agent manifests from a project's agent directory. Deterministic:
 * files are processed in sorted order so loading is reproducible and testable.
 *
 * `subagentGraph` is the project-level delegation policy from BetterCode config
 * (agent -> allowed subagents). It's merged onto any frontmatter `subagents`, so
 * delegation can be declared centrally without editing the target repo's
 * manifests. Delegation is closed by default: an agent can only spawn subagents
 * explicitly granted here or in its frontmatter.
 */
export async function loadProjectAgents(
  agentDir: string,
  subagentGraph: Record<string, string[]> = {},
): Promise<AgentRegistry> {
  let entries: string[];
  try {
    entries = await readdir(agentDir);
  } catch (err) {
    throw new Error(`Cannot read agent dir ${agentDir}: ${(err as Error).message}`);
  }

  const mdFiles = entries.filter((f) => f.toLowerCase().endsWith('.md')).sort();
  if (mdFiles.length === 0) {
    throw new Error(`No agent manifests (*.md) found in ${agentDir}`);
  }

  const manifests: AgentManifest[] = [];
  for (const file of mdFiles) {
    const full = join(agentDir, file);
    const content = await readFile(full, 'utf8');
    manifests.push(parseAgentManifest(content, full));
  }
  applySubagentGraph(manifests, subagentGraph);
  return AgentRegistry.fromManifests(manifests);
}

/** Merge the config delegation graph onto parsed manifests (in place). */
function applySubagentGraph(manifests: AgentManifest[], graph: Record<string, string[]>): void {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  for (const [agent, subs] of Object.entries(graph)) {
    const m = byName.get(agent);
    if (!m) throw new Error(`config grants subagents to unknown agent "${agent}"`);
    if (!m.tools.includes('agent')) {
      throw new Error(`agent "${agent}" is granted subagents in config but lacks the "agent" tool`);
    }
    m.subagents = Array.from(new Set([...m.subagents, ...subs]));
  }
}
