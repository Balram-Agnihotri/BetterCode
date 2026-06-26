import { z } from 'zod';
import { ok, toolError, type ToolDefinition, type ToolContext } from './types';

/** Only the top-level agent may delegate in v0 (prevents deep recursion). */
const MAX_DELEGATION_DEPTH = 1;

const agentInput = z.object({
  agentName: z.string().min(1),
  task: z.string().min(1),
  thoroughness: z.enum(['quick', 'medium', 'thorough']).default('medium'),
});
export type AgentInput = z.infer<typeof agentInput>;

export const agentTool: ToolDefinition<AgentInput> = {
  name: 'agent',
  description:
    'Spawn a subagent for complex multi-file investigations that require isolated context (e.g., tracing an end-to-end flow across 5+ files). Each call consumes subagent budget. For simple lookups or questions answerable in 1-3 reads, use search + read directly instead.',
  inputSchema: agentInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['agentName', 'task'],
    properties: {
      agentName: { type: 'string', description: 'Name of an allowed subagent (e.g. "explore").' },
      task: { type: 'string', description: 'A focused, self-contained investigation task.' },
      thoroughness: { type: 'string', enum: ['quick', 'medium', 'thorough'], description: 'Effort level (default medium).' },
    },
  },

  async execute(input: AgentInput, ctx: ToolContext) {
    // Permission: caller's manifest must declare this subagent + the agent tool.
    if (!ctx.registry.canDelegate(ctx.agent, input.agentName)) {
      return toolError(
        'DELEGATION_DENIED',
        `agent "${ctx.agent}" may not spawn "${input.agentName}"`,
      );
    }
    if (ctx.depth >= MAX_DELEGATION_DEPTH) {
      return toolError('DEPTH_EXCEEDED', `delegation depth limit (${MAX_DELEGATION_DEPTH}) reached`);
    }
    if (!ctx.tracker.canSpawnSubagent()) {
      ctx.tracker.markTruncated();
      return toolError('BUDGET_EXCEEDED', 'subagent budget exhausted; answer from evidence already gathered');
    }

    ctx.tracker.countSubagent();
    const result = await ctx.spawnSubagent({
      agentName: input.agentName,
      task: input.task,
      thoroughness: input.thoroughness,
      parentAgent: ctx.agent,
      depth: ctx.depth + 1,
    });

    // NOTE: parent and subagent share one BudgetTracker, so the subagent's tool
    // calls/tokens are already counted job-wide. We do NOT merge again here
    // (that would double-count). result.usage is informational only.

    // Return ONLY the summary + citations to the parent (no raw context dump).
    const citationLines = result.citations
      .map((c) => `• ${c.path}:L${c.startLine}-L${c.endLine}`)
      .join('\n');

    return ok({
      content:
        `Subagent "${result.agent}" (confidence: ${result.confidence}${result.truncated ? ', truncated' : ''}):\n` +
        `${result.summary}\n` +
        (citationLines ? `\nCited:\n${citationLines}` : ''),
      citations: result.citations,
      meta: {
        subagent: result.agent,
        confidence: result.confidence,
        subToolCalls: result.usage.toolCalls,
        truncated: result.truncated,
      },
      truncated: result.truncated,
    });
  },
};
