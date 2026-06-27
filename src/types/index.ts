/**
 * Core domain types for BetterCode.
 *
 * These are the contracts shared across the ingress Lambda, the worker, the
 * orchestrator, the tool runtime, and the data layer. Keep them dependency-free
 * so they can be imported anywhere (including infra and tests).
 */

// ---------------------------------------------------------------------------
// Tools & agents
// ---------------------------------------------------------------------------

/** The fixed set of tool names the LLM may be granted. */
export type ToolName =
  | 'read'
  | 'search'
  | 'agent'
  // Symbol-aware tools (Phase 1)
  | 'findSymbol'
  | 'workspaceSymbols'
  | 'goToDefinition'
  | 'findReferences'
  | 'callHierarchy'
  | 'documentSymbols'
  // Graph tools (Phase 1)
  | 'dependencyGraph'
  // Workspace tools (Phase 3)
  | 'recordFinding'
  | 'getWorkspaceSummary'
  | 'updateHypothesis';

export const ALL_TOOL_NAMES: readonly ToolName[] = [
  'read',
  'search',
  'agent',
  'findSymbol',
  'workspaceSymbols',
  'goToDefinition',
  'findReferences',
  'callHierarchy',
  'documentSymbols',
  'dependencyGraph',
  'recordFinding',
  'getWorkspaceSummary',
  'updateHypothesis',
];

/** Parsed `.github/agents/<name>.md` manifest. */
export interface AgentManifest {
  /** Agent name (frontmatter `name`, else file stem). */
  name: string;
  /** Routing/selection description from frontmatter. */
  description: string;
  /** Normalized, de-duplicated tool grants (BetterCode's known tools only). */
  tools: ToolName[];
  /**
   * Tools the manifest requested that BetterCode does not implement (e.g.
   * `edit`, `execute`, MCP tools). Recorded for transparency/audit; never
   * granted. This is how BetterCode safely shares manifests with other runtimes.
   */
  unsupportedTools: string[];
  /** Subagents this agent may spawn via the `agent` tool. */
  subagents: string[];
  /** Model tier key (router | explore | synth) or explicit model id. */
  model?: string;
  /** Optional hint shown to humans; not used at runtime. */
  argumentHint?: string;
  /** Markdown body => the agent's system prompt. */
  systemPrompt: string;
  /** Absolute source path, for audit/debug. */
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// Repo snapshot & citations
// ---------------------------------------------------------------------------

/** An immutable, pinned view of a repo for the lifetime of a single job. */
export interface RepoSnapshot {
  project: string;
  /** Resolved commit the job is pinned to. */
  commitSha: string;
  branch: string;
  /** Absolute path to the read-only worktree root for this job. */
  worktreeRoot: string;
  /** Base URL for building GitHub web links, e.g. https://github.com/org/repo */
  githubWebBaseUrl: string;
}

/** A structured, verifiable pointer into the codebase. */
export interface Citation {
  path: string;        // repo-relative
  startLine: number;
  endLine: number;
  commitSha: string;
  /** Pre-rendered GitHub permalink (blob URL with line anchors). */
  url?: string;
  /** One-line "why this matters" note authored by the agent. */
  note?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Slack ingress / queue
// ---------------------------------------------------------------------------

/** Why a message was deemed answerable (audit + analytics). */
export type TriggerReason = 'app_mention' | 'question_like' | 'bot_keyword';

/** The SQS message shape produced by ingress, consumed by the worker. */
export interface JobMessage {
  schemaVersion: 1;
  jobId: string;
  eventId: string;          // Slack event_id, used for dedupe
  teamId: string;
  channelId: string;
  /** Thread to reply into. Falls back to the triggering message ts. */
  threadTs: string;
  messageTs: string;
  userId: string;
  /** Raw user text (untrusted). Cleaned of the bot mention by ingress. */
  text: string;
  project: string;
  agent: string;
  triggerReason: TriggerReason;
  receivedAt: string;       // ISO8601
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'   // ignored on purpose (rate limit, not answerable, etc.)
  | 'timed_out';

/** Persistent record of a job's lifecycle (DynamoDB jobs table). */
export interface JobRecord {
  jobId: string;
  eventId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  project: string;
  agent: string;
  status: JobStatus;
  commitSha?: string;
  interimTs?: string;       // ts of the "I'm checking…" message, if posted
  answerExcerpt?: string;   // first N chars, for quick inspection
  confidence?: Confidence;
  error?: { code: string; message: string };
  usage?: UsageSummary;
  createdAt: string;
  updatedAt: string;
  ttl: number;              // epoch seconds; DynamoDB TTL
}

// ---------------------------------------------------------------------------
// Orchestration results & telemetry
// ---------------------------------------------------------------------------

export interface UsageSummary {
  toolCalls: number;
  subagentCalls: number;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
  estimatedCostUsd: number;
  searchCount: number;
  readCount: number;
  truncated: boolean;       // true if any budget limit clipped the work
}

/** Final synthesized answer the responder posts to Slack. */
export interface AnswerResult {
  answer: string;
  citations: Citation[];
  confidence: Confidence;
  incompleteSearch: boolean;
  commitSha: string;
  project: string;
  usage: UsageSummary;
}

/** One audited tool invocation (DynamoDB audit table). */
export interface ToolCallAudit {
  jobId: string;
  /** Monotonic per-job sequence; sort key. */
  seq: number;
  agent: string;            // which agent issued the call
  tool: ToolName;
  /** Redacted, size-bounded input echo. */
  inputDigest: Record<string, unknown>;
  ok: boolean;
  errorCode?: string;
  /** Size-bounded result metadata (counts, paths) — never full file bodies. */
  resultMeta: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
  ttl: number;
}

// ---------------------------------------------------------------------------
// Budgets (resolved per job)
// ---------------------------------------------------------------------------

export interface Budgets {
  maxToolCalls: number;
  maxSubagentCalls: number;
  maxWallClockMs: number;
  maxTokens: number;
  maxSearchResults: number;
  maxFileBytes: number;
  maxFileLines: number;
  maxSlackChars: number;
}

/** Typed error categories used for graceful Slack failure messages. */
export type FailureCode =
  | 'REPO_UNAVAILABLE'
  | 'BUDGET_EXCEEDED'
  | 'TIMEOUT'
  | 'LLM_ERROR'
  | 'RATE_LIMITED'
  | 'NOT_ANSWERABLE'
  | 'INTERNAL';

export class BetterCodeError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'BetterCodeError';
  }
}
