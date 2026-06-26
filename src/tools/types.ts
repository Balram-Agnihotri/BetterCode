import type { z } from 'zod';
import type { AgentRegistry } from '../agents/agentLoader';
import type { AccessConfig } from '../config/schema';
import type { BudgetTracker } from '../orchestrator/budgets';
import type { Logger } from '../observability/logger';
import type {
  Budgets,
  Citation,
  Confidence,
  RepoSnapshot,
  ToolCallAudit,
  ToolName,
  UsageSummary,
} from '../types';

/** Concise result returned by a subagent to its parent (summaries only). */
export interface SubagentResult {
  agent: string;
  summary: string;
  citations: Citation[];
  confidence: Confidence;
  usage: UsageSummary;
  truncated: boolean;
}

/** Implemented by the orchestrator; injected into the `agent` tool. */
export type SpawnSubagentFn = (args: {
  agentName: string;
  task: string;
  thoroughness: 'quick' | 'medium' | 'thorough';
  parentAgent: string;
  depth: number;
}) => Promise<SubagentResult>;

/** Everything a tool needs to execute safely within one job. */
export interface ToolContext {
  jobId: string;
  /** The agent that issued this tool call. */
  agent: string;
  snapshot: RepoSnapshot;
  access: AccessConfig;
  budgets: Budgets;
  tracker: BudgetTracker;
  registry: AgentRegistry;
  /** Delegation depth: 0 = top-level ProductLens, 1 = its subagents, … */
  depth: number;
  logger: Logger;
  recordAudit: (audit: ToolCallAudit) => Promise<void>;
  /** Monotonic per-job audit sequence generator. */
  nextSeq: () => number;
  spawnSubagent: SpawnSubagentFn;
  /** Aborted when the job exceeds its wall-clock budget. */
  signal: AbortSignal;
}

export interface ToolResult {
  /** Content surfaced back to the model. Already redacted + size-bounded. */
  content: string;
  /** Structured citations produced by this call (read/search). */
  citations: Citation[];
  /** Audit metadata (counts/paths only — never file bodies). */
  meta: Record<string, unknown>;
  truncated: boolean;
  ok: boolean;
  errorCode?: string;
}

export interface ToolDefinition<I = unknown> {
  name: ToolName;
  description: string;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** JSON Schema for the LLM tool spec (Anthropic `input_schema`). */
  parameters: Record<string, unknown>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(partial: Omit<ToolResult, 'ok'>): ToolResult {
  return { ...partial, ok: true };
}

export function toolError(code: string, message: string): ToolResult {
  return { content: `ERROR(${code}): ${message}`, citations: [], meta: { error: code }, truncated: false, ok: false, errorCode: code };
}

/** Build a GitHub blob permalink for a citation. */
export function githubBlobUrl(
  base: string,
  commitSha: string,
  path: string,
  startLine: number,
  endLine: number,
): string {
  const anchor = startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
  return `${base.replace(/\/$/, '')}/blob/${commitSha}/${path}${anchor}`;
}
