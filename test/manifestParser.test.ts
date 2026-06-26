import { describe, expect, it } from 'vitest';
import { parseAgentManifest } from '../src/agents/manifestParser';
import { AgentRegistry } from '../src/agents/agentLoader';

const PRODUCTLENS = `---
name: ProductLens
description: "Product Q&A agent."
tools: [read, search, agent]
subagents: [explore]
model: synth
---
You are ProductLens. Answer grounded in code.`;

const EXPLORE = `---
description: "Read-only explorer."
tools: [Read, GREP]
---
You are explore.`;

describe('parseAgentManifest', () => {
  it('parses frontmatter, normalizes tools, keeps body as prompt', () => {
    const m = parseAgentManifest(PRODUCTLENS, '/x/ProductLens.md');
    expect(m.name).toBe('ProductLens');
    expect(m.tools).toEqual(['read', 'search', 'agent']);
    expect(m.subagents).toEqual(['explore']);
    expect(m.model).toBe('synth');
    expect(m.systemPrompt).toContain('You are ProductLens');
  });

  it('falls back to file stem and normalizes tool aliases', () => {
    const m = parseAgentManifest(EXPLORE, '/x/explore.md');
    expect(m.name).toBe('explore'); // from file stem
    expect(m.tools).toEqual(['read', 'search']); // Read->read, GREP->search
  });

  it('derives the agent name from a .agent.md filename', () => {
    const m = parseAgentManifest(`---\ndescription: "x"\ntools: [read]\n---\nbody`, '/x/ProductLens.agent.md');
    expect(m.name).toBe('ProductLens');
  });

  it('drops tools BetterCode does not implement and records them as unsupported', () => {
    const m = parseAgentManifest(
      `---\ndescription: "x"\ntools: [read, search, edit, execute, internal-codecov/*, agent]\n---\nbody`,
      '/x/coverage.agent.md',
    );
    expect(m.tools).toEqual(['read', 'search', 'agent']);
    expect(m.unsupportedTools).toEqual(expect.arrayContaining(['edit', 'execute', 'internal-codecov/*']));
  });

  it('rejects subagents without the agent tool', () => {
    const bad = `---\ndescription: "x"\ntools: [read]\nsubagents: [explore]\n---\nbody`;
    expect(() => parseAgentManifest(bad, '/x/a.md')).toThrow(/agent.*tool/i);
  });

  it('requires a description and a body', () => {
    expect(() => parseAgentManifest(`---\ntools: [read]\n---\nbody`, '/x/a.md')).toThrow(/description/);
    expect(() => parseAgentManifest(`---\ndescription: "x"\ntools: [read]\n---\n`, '/x/a.md')).toThrow(/body/);
  });
});

describe('AgentRegistry', () => {
  it('validates subagent references resolve', () => {
    const pl = parseAgentManifest(PRODUCTLENS, '/x/ProductLens.md');
    expect(() => AgentRegistry.fromManifests([pl])).toThrow(/unknown subagent/);

    const ex = parseAgentManifest(EXPLORE, '/x/explore.md');
    const reg = AgentRegistry.fromManifests([pl, ex]);
    expect(reg.canDelegate('ProductLens', 'explore')).toBe(true);
    expect(reg.canDelegate('explore', 'ProductLens')).toBe(false);
  });
});
