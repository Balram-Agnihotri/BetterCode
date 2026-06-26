import type { Budgets, ToolName, UsageSummary } from '../types';

/**
 * Mutable per-job accounting for all budget dimensions. The orchestrator and
 * tool runtime consult this before every model call, tool call, and subagent
 * spawn. When any dimension is exhausted, work stops gracefully and the answer
 * is marked truncated rather than the job hard-failing.
 */
export class BudgetTracker {
  toolCalls = 0;
  subagentCalls = 0;
  searchCount = 0;
  readCount = 0;
  inputTokens = 0;
  outputTokens = 0;
  estimatedCostUsd = 0;
  private truncated = false;
  private readonly startedAt = Date.now();

  constructor(private readonly b: Budgets) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.b.maxWallClockMs - this.elapsedMs());
  }

  private tokensExhausted(): boolean {
    return this.inputTokens + this.outputTokens >= this.b.maxTokens;
  }

  canCallTool(): boolean {
    return this.toolCalls < this.b.maxToolCalls && this.remainingMs() > 0 && !this.tokensExhausted();
  }

  canSpawnSubagent(): boolean {
    return this.subagentCalls < this.b.maxSubagentCalls && this.canCallTool();
  }

  canCallModel(): boolean {
    return this.remainingMs() > 0 && !this.tokensExhausted();
  }

  countTool(name: ToolName): void {
    this.toolCalls += 1;
    if (name === 'search') this.searchCount += 1;
    if (name === 'read') this.readCount += 1;
  }

  countSubagent(): void {
    this.subagentCalls += 1;
  }

  addTokens(input: number, output: number, costUsd: number): void {
    this.inputTokens += input;
    this.outputTokens += output;
    this.estimatedCostUsd += costUsd;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  /** Fold a finished subagent's usage into the parent totals. */
  mergeSubagentUsage(child: UsageSummary): void {
    this.inputTokens += child.inputTokens;
    this.outputTokens += child.outputTokens;
    this.estimatedCostUsd += child.estimatedCostUsd;
    this.searchCount += child.searchCount;
    this.readCount += child.readCount;
    this.toolCalls += child.toolCalls;
    if (child.truncated) this.truncated = true;
  }

  summary(): UsageSummary {
    return {
      toolCalls: this.toolCalls,
      subagentCalls: this.subagentCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      wallClockMs: this.elapsedMs(),
      estimatedCostUsd: Number(this.estimatedCostUsd.toFixed(4)),
      searchCount: this.searchCount,
      readCount: this.readCount,
      truncated: this.truncated,
    };
  }
}
