import type { AgentManifest, ToolCallAudit, ToolName } from '../types';
import { ALL_TOOL_NAMES } from '../types';
import { agentTool } from './agentTool';
import { readTool } from './readTool';
import { redact } from './redaction';
import { searchTool } from './searchTool';
import { toolError, type ToolContext, type ToolDefinition, type ToolResult } from './types';

const TOOLS: Record<ToolName, ToolDefinition> = {
  read: readTool as ToolDefinition,
  search: searchTool as ToolDefinition,
  agent: agentTool as ToolDefinition,
};

const AUDIT_TTL_DAYS = 90;

export interface LlmToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Build the tool specs offered to the LLM for a given agent (grants only). */
export function buildToolSpecsForAgent(manifest: AgentManifest): LlmToolSpec[] {
  return manifest.tools.map((t) => {
    const def = TOOLS[t];
    let description = def.description;
    if (t === 'agent') {
      const subs = manifest.subagents.length ? manifest.subagents.join(', ') : '(none)';
      description += ` Allowed subagents: ${subs}.`;
    }
    return { name: def.name, description, input_schema: def.parameters };
  });
}

function isToolName(name: string): name is ToolName {
  return (ALL_TOOL_NAMES as readonly string[]).includes(name);
}

/** Produce a redacted, size-bounded echo of tool input for the audit log. */
function digestInput(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') return { value: String(raw).slice(0, 200) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = redact(v).slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = `[${typeof v}]`;
  }
  return out;
}

/**
 * Central tool dispatcher. Enforces grants, validates input, checks budget,
 * executes, and writes one audit record per call. Errors are returned as tool
 * results (so the model can recover) rather than thrown, except that policy
 * violations are surfaced clearly and logged.
 */
export async function executeToolCall(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const startedAtIso = new Date().toISOString();
  const t0 = Date.now();
  const seq = ctx.nextSeq();

  const finish = async (result: ToolResult, tool: ToolName): Promise<ToolResult> => {
    await ctx.recordAudit({
      jobId: ctx.jobId,
      seq,
      agent: ctx.agent,
      tool,
      inputDigest: digestInput(rawInput),
      ok: result.ok,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      resultMeta: result.meta,
      startedAt: startedAtIso,
      durationMs: Date.now() - t0,
      ttl: Math.floor(Date.now() / 1000) + AUDIT_TTL_DAYS * 86400,
    } satisfies ToolCallAudit);
    return result;
  };

  if (!isToolName(name)) {
    ctx.logger.warn({ tool: name }, 'unknown tool requested by model');
    return finish(toolError('UNKNOWN_TOOL', `no such tool: ${name}`), 'read');
  }
  const toolName: ToolName = name;
  const manifest = ctx.registry.get(ctx.agent);

  if (!manifest.tools.includes(toolName)) {
    ctx.logger.warn({ agent: ctx.agent, tool: toolName }, 'tool not granted to agent');
    return finish(toolError('TOOL_NOT_GRANTED', `agent "${ctx.agent}" is not granted "${toolName}"`), toolName);
  }
  if (!ctx.tracker.canCallTool()) {
    ctx.tracker.markTruncated();
    return finish(toolError('BUDGET_EXCEEDED', 'tool-call budget exhausted'), toolName);
  }

  const def = TOOLS[toolName];
  const parsed = def.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return finish(toolError('BAD_INPUT', issues), toolName);
  }

  ctx.tracker.countTool(toolName);
  let result: ToolResult;
  try {
    result = await def.execute(parsed.data, ctx);
  } catch (err) {
    ctx.logger.error({ tool: toolName, err: (err as Error).message }, 'tool execution threw');
    result = toolError('TOOL_EXCEPTION', (err as Error).message);
  }
  return finish(result, toolName);
}
