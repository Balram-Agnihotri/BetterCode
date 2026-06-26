import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectAgents } from '../src/agents/agentLoader';

// Mirrors the real engage-workspace format: `.agent.md`, no `subagents`
// frontmatter, and tools BetterCode does not implement (edit).
const PRODUCTLENS = `---
description: "Product-aware Q&A agent."
tools: [read, search, edit, agent]
argument-hint: "Ask about Engage"
---
You are ProductLens.`;

const EXPLORE = `---
description: "Read-only explorer."
tools: [read, search]
argument-hint: "What to look for"
---
You are explore.`;

describe('loadProjectAgents', () => {
  it('loads .agent.md manifests, ignores non-.md files, normalizes tools, and applies the config delegation graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-agents-'));
    await writeFile(join(dir, 'ProductLens.agent.md'), PRODUCTLENS);
    await writeFile(join(dir, 'explore.agent.md'), EXPLORE);
    await writeFile(join(dir, 'config.yaml'), 'foo: bar\n'); // must be ignored

    const reg = await loadProjectAgents(dir, { ProductLens: ['explore'] });

    expect(reg.has('ProductLens')).toBe(true);
    expect(reg.has('explore')).toBe(true);
    // `edit` is never granted by BetterCode.
    expect(reg.get('ProductLens').tools).toEqual(['read', 'search', 'agent']);
    expect(reg.get('ProductLens').unsupportedTools).toContain('edit');
    // Delegation comes from config, closed by default.
    expect(reg.canDelegate('ProductLens', 'explore')).toBe(true);
    expect(reg.canDelegate('explore', 'ProductLens')).toBe(false);
  });

  it('rejects a config graph that grants subagents to an agent lacking the agent tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-agents-'));
    await writeFile(join(dir, 'explore.agent.md'), EXPLORE); // no `agent` tool
    await expect(loadProjectAgents(dir, { explore: ['explore'] })).rejects.toThrow(/agent.*tool/i);
  });
});
