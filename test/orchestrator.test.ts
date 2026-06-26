import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/agentLoader';
import { parseAgentManifest } from '../src/agents/manifestParser';
import type { BetterCodeConfig } from '../src/config/schema';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm/client';
import { noopLogger } from '../src/observability/logger';
import { runJob } from '../src/orchestrator/orchestrator';
import type { Budgets, RepoSnapshot } from '../src/types';

const PRODUCTLENS = `---
name: ProductLens
description: "Product Q&A agent."
tools: [read, search, agent]
subagents: [explore]
model: synth
---
You are ProductLens.`;

const EXPLORE = `---
name: explore
description: "Read-only explorer."
tools: [read, search]
model: explore
---
You are explore.`;

/** Scripted LLM: first turn reads a file, second turn answers. */
class FakeLlm implements LlmClient {
  private turn = 0;
  async complete(_req: LlmRequest): Promise<LlmResponse> {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        model: 's',
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'src/foo.ts' } }],
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    }
    return {
      model: 's',
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: "Here's what I found:\n\n`foo` exports a constant.\n\nCode evidence:\n• src/foo.ts:L1-L1 — the export\n\nConfidence: high",
        },
      ],
      usage: { inputTokens: 30, outputTokens: 15 },
    };
  }
}

const budgets: Budgets = {
  maxToolCalls: 10,
  maxSubagentCalls: 3,
  maxWallClockMs: 30_000,
  maxTokens: 100_000,
  maxSearchResults: 50,
  maxFileBytes: 100_000,
  maxFileLines: 1000,
  maxSlackChars: 3500,
};

const cfg = {
  llm: {
    models: {
      router: { id: 'r', maxTokens: 200 },
      explore: { id: 'e', maxTokens: 200 },
      synth: { id: 's', maxTokens: 200 },
    },
    fallbacks: {},
  },
} as unknown as BetterCodeConfig;

describe('runJob (orchestration loop)', () => {
  it('runs the tool loop, reads code, and produces a grounded answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bettercode-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/foo.ts'), 'export const x = 1;\n');

    const registry = AgentRegistry.fromManifests([
      parseAgentManifest(PRODUCTLENS, join(dir, 'ProductLens.md')),
      parseAgentManifest(EXPLORE, join(dir, 'explore.md')),
    ]);

    const snapshot: RepoSnapshot = {
      project: 'engage',
      commitSha: 'a'.repeat(40),
      branch: 'main',
      worktreeRoot: dir,
      githubWebBaseUrl: 'https://github.com/o/r',
    };

    const result = await runJob({
      jobId: 'job-1',
      question: 'What does foo export?',
      agentName: 'ProductLens',
      snapshot,
      registry,
      access: { denyGlobs: [], allowGlobs: ['**/*'], maxBinaryBytesProbe: 8192 },
      budgets,
      cfg,
      llm: new FakeLlm(),
      logger: noopLogger,
      recordAudit: async () => {},
    });

    expect(result.confidence).toBe('high');
    expect(result.commitSha).toBe('a'.repeat(40));
    expect(result.usage.readCount).toBe(1);
    expect(result.usage.toolCalls).toBe(1);
    const cited = result.citations.find((c) => c.path === 'src/foo.ts');
    expect(cited).toBeDefined();
    expect(cited?.url).toContain('/blob/aaaaaaaaaaaa');
  });
});
