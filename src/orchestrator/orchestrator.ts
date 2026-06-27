import type { AgentRegistry } from '../agents/agentLoader';
import type { BetterCodeConfig, AccessConfig } from '../config/schema';
import { isToolUse, textBlocks, type LlmClient, type LlmContent, type LlmMessage } from '../llm/client';
import type { Logger } from '../observability/logger';
import { clamp } from '../tools/redaction';
import { buildToolSpecsForAgent, executeToolCall } from '../tools/runtime';
import type { SpawnSubagentFn, ToolContext } from '../tools/types';
import type {
  AgentManifest,
  AnswerResult,
  Budgets,
  Citation,
  Confidence,
  RepoSnapshot,
  ToolCallAudit,
} from '../types';
import type { RepoKnowledgeBase } from '../index/repoKnowledgeBase';
import { InvestigationWorkspace } from '../workspace/investigationWorkspace';
import { injectWorkspaceSummary, shouldInjectWorkspace } from '../workspace/workspaceSummarizer';
import { BudgetTracker } from './budgets';
import { estimateCostUsd, resolveModel, type ResolvedModel } from './modelRouter';
import {
  buildSystemPrompt,
  FORCE_FINAL_INSTRUCTION,
  SYNTHESIZE_INSTRUCTION,
  wrapSubagentTask,
  wrapUserQuestion,
} from './prompts';
import { setMaxListeners } from 'node:events';

// ---------------------------------------------------------------------------
// Orchestrator constants
// ---------------------------------------------------------------------------

/** Hard cap on LLM round-trips per agent run. */
const MAX_TURNS = 12;

/** Max chars returned from any single tool result to the model. */
const MODEL_TOOL_RESULT_CHARS = 4000;

/** Max citations attached to the final Slack response. */
const MAX_FINAL_CITATIONS = 20;

/**
 * After this many turns of tool usage, inject a nudge to synthesize if
 * the agent hasn't already started converging.
 */
const SYNTHESIZE_NUDGE_TURN = 7;

/**
 * Max consecutive search calls (without a read in between) before we inject a
 * "you should read now" hint. Prevents search-only spirals.
 * Reduced from 2 → 3 since hybrid search already surfaces symbol info.
 */
const MAX_CONSECUTIVE_SEARCHES = 3;

export interface RunJobParams {
  jobId: string;
  question: string;
  agentName: string;
  snapshot: RepoSnapshot;
  registry: AgentRegistry;
  access: AccessConfig;
  budgets: Budgets;
  cfg: BetterCodeConfig;
  llm: LlmClient;
  logger: Logger;
  recordAudit: (audit: ToolCallAudit) => Promise<void>;
  /** Pre-built repository index (symbol index + BM25). Optional — jobs still work without it. */
  knowledgeBase?: RepoKnowledgeBase;
}

interface AgentRunResult {
  text: string;
  citations: Citation[];
  confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Phase tracking — distinguishes exploration from synthesis
// ---------------------------------------------------------------------------

type Phase = 'planning' | 'exploration' | 'synthesis';

interface TurnState {
  phase: Phase;
  turn: number;
  consecutiveSearches: number;
  hasReadAtLeastOnce: boolean;
}

function classifyPhase(state: TurnState): Phase {
  if (state.turn === 0) return 'planning';
  if (state.turn >= SYNTHESIZE_NUDGE_TURN) return 'synthesis';
  return 'exploration';
}

// ---------------------------------------------------------------------------
// Context summarization — keep tool results tight
// ---------------------------------------------------------------------------

/**
 * Summarize a tool result to reduce context bloat. For search results, trims to
 * the most relevant matches. For reads, trims to the requested range. This is
 * the main lever for keeping conversations efficient.
 */
function summarizeToolResult(
  toolName: string,
  rawContent: string,
  _isError: boolean,
): string {
  // Search results: cap output so only top hits survive
  if (toolName === 'search') {
    return clamp(rawContent, 3000).text;
  }
  // Read results: slightly more generous — code context matters
  if (toolName === 'read') {
    return clamp(rawContent, MODEL_TOOL_RESULT_CHARS).text;
  }
  // Agent results: already summarized by the subagent itself
  return clamp(rawContent, MODEL_TOOL_RESULT_CHARS).text;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run one BetterCode job to completion: the top-level agent's tool-call loop,
 * including any subagents it spawns. All agents in a job share one
 * BudgetTracker and one wall-clock AbortController, so global budgets and the
 * timeout are enforced across the whole tree.
 *
 * ## Execution model (Copilot-style)
 *
 * 1. **Planning** — First LLM turn: the model reasons about what to search/read
 *    before calling any tools. The system prompt encourages a hidden plan.
 * 2. **Exploration** — Iterative search→read loop with refinement. Multiple
 *    tool calls per turn are executed concurrently. Consecutive-search detection
 *    nudges the model to read before searching again.
 * 3. **Synthesis** — After enough evidence is gathered (or turn budget is
 *    high), inject a synthesis nudge. The model produces the final answer.
 *
 * Early exit: If the model responds with text (no tool_use stop) at any point,
 * we accept that as the final answer — it decided it has enough evidence.
 */
export async function runJob(p: RunJobParams): Promise<AnswerResult> {
  const tracker = new BudgetTracker(p.budgets);
  const abort = new AbortController();
  setMaxListeners(200, abort.signal);
  const timer = setTimeout(() => abort.abort(), p.budgets.maxWallClockMs);
  let seq = 0;
  const nextSeq = () => (seq += 1);
  const allCitations: Citation[] = [];

  // Per-job investigation workspace (fresh for each question)
  const workspace = new InvestigationWorkspace();

  const spawnSubagent: SpawnSubagentFn = async ({ agentName, task, thoroughness, depth }) => {
    const manifest = p.registry.get(agentName);
    const res = await runAgent(manifest, wrapSubagentTask(task, thoroughness), depth, false);
    return {
      agent: agentName,
      summary: res.text,
      citations: res.citations,
      confidence: res.confidence,
      usage: tracker.summary(),
      truncated: tracker.isTruncated(),
    };
  };

  const makeCtx = (agent: string, depth: number): ToolContext => ({
    jobId: p.jobId,
    agent,
    snapshot: p.snapshot,
    access: p.access,
    budgets: p.budgets,
    tracker,
    registry: p.registry,
    depth,
    logger: p.logger.child({ agent }),
    recordAudit: p.recordAudit,
    nextSeq,
    spawnSubagent,
    signal: abort.signal,
    knowledgeBase: p.knowledgeBase,
    workspace,
  });

  async function runAgent(
    manifest: AgentManifest,
    taskText: string,
    depth: number,
    isTopLevel: boolean,
  ): Promise<AgentRunResult> {
    const baseSystem = buildSystemPrompt(manifest, p.snapshot, isTopLevel, p.budgets);
    const tools = buildToolSpecsForAgent(manifest);
    const model = resolveModel(p.cfg, manifest.model ?? (isTopLevel ? 'synth' : 'explore'));
    const messages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: taskText }] }];
    const localCitations: Citation[] = [];

    const state: TurnState = {
      phase: 'planning',
      turn: 0,
      consecutiveSearches: 0,
      hasReadAtLeastOnce: false,
    };

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      state.turn = turn;
      state.phase = classifyPhase(state);

      if (!tracker.canCallModel() || abort.signal.aborted) {
        tracker.markTruncated();
        break;
      }

      // --- Workspace-based synthesis nudge (replaces rigid turn counter) ---
      // Inject nudge if workspace says we're ready, or as fallback at turn 7
      const workspaceReady = isTopLevel && workspace.isReadyToSynthesize();
      if (workspaceReady || (turn === SYNTHESIZE_NUDGE_TURN && state.hasReadAtLeastOnce)) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: SYNTHESIZE_INSTRUCTION }],
        });
      }

      // --- Inject workspace summary at each turn after the first read ---
      const system = isTopLevel && shouldInjectWorkspace(workspace, turn)
        ? injectWorkspaceSummary(baseSystem, workspace)
        : baseSystem;

      const resp = await p.llm.complete({
        model: model.id,
        fallbacks: model.fallbacks,
        system,
        messages,
        tools,
        maxTokens: model.maxTokens,
        signal: abort.signal,
      });
      tracker.addTokens(
        resp.usage.inputTokens,
        resp.usage.outputTokens,
        estimateCostUsd(resp.model, resp.usage.inputTokens, resp.usage.outputTokens),
      );
      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter(isToolUse);

      // --- Early exit: model chose to answer (no tool calls)
      if (resp.stopReason !== 'tool_use' || toolUses.length === 0) {
        const text = textBlocks(resp.content);
        return { text, citations: localCitations, confidence: parseConfidence(text) };
      }

      // --- Track consecutive searches for anti-spiral detection
      const toolNames = toolUses.map((tu) => tu.name);
      const allSearches = toolNames.every((n) => n === 'search');
      const hasRead = toolNames.includes('read');

      if (allSearches) {
        state.consecutiveSearches += 1;
      } else {
        state.consecutiveSearches = 0;
      }
      if (hasRead) {
        state.hasReadAtLeastOnce = true;
      }

      // --- Execute all tool calls concurrently (read/search/agent are read-only)
      const ctx = makeCtx(manifest.name, depth);
      const results = await Promise.all(
        toolUses.map((tu) => executeToolCall(tu.name, tu.input, ctx).then((r) => ({ tu, r }))),
      );

      // --- Build result blocks with context summarization
      const resultBlocks: LlmContent[] = results.map(({ tu, r }) => {
        localCitations.push(...r.citations);
        allCitations.push(...r.citations);

        // Auto-record file reads into the workspace so later turns get the summary
        if (tu.name === 'read' && r.ok && isTopLevel) {
          const readInput = tu.input as { path?: string; startLine?: number; endLine?: number };
          if (readInput.path) {
            workspace.recordFileRead(
              readInput.path,
              r.content,
              readInput.startLine ?? 1,
              readInput.endLine,
            );
          }
        }

        return {
          type: 'tool_result',
          toolUseId: tu.id,
          content: summarizeToolResult(tu.name, r.content, !r.ok),
          isError: !r.ok,
        };
      });

      messages.push({ role: 'user', content: resultBlocks });

      // --- Anti-spiral: if too many consecutive searches without reads, inject nudge
      if (state.consecutiveSearches >= MAX_CONSECUTIVE_SEARCHES && !state.hasReadAtLeastOnce) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '[System] You have searched multiple times without reading any files. ' +
                'Search results only show snippets. You MUST use the read tool on the most ' +
                'promising file paths to verify actual implementation before searching again.',
            },
          ],
        });
      } else if (state.consecutiveSearches >= MAX_CONSECUTIVE_SEARCHES) {
        // Already read before but spiraling again — lighter nudge
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '[System] Multiple searches without reads. Consider reading the most relevant ' +
                'results or refining your query with a more specific pattern/glob.',
            },
          ],
        });
      }
    }

    // Exhausted turns — force a final answer from gathered evidence
    const finalText = await forceFinal(system, messages, model);
    return { text: finalText, citations: localCitations, confidence: parseConfidence(finalText) };
  }

  async function forceFinal(
    system: string,
    messages: LlmMessage[],
    model: ResolvedModel,
  ): Promise<string> {
    messages.push({ role: 'user', content: [{ type: 'text', text: FORCE_FINAL_INSTRUCTION }] });
    try {
      const resp = await p.llm.complete({
        model: model.id,
        fallbacks: model.fallbacks,
        system,
        messages,
        maxTokens: model.maxTokens,
        signal: abort.signal,
      });
      tracker.addTokens(
        resp.usage.inputTokens,
        resp.usage.outputTokens,
        estimateCostUsd(resp.model, resp.usage.inputTokens, resp.usage.outputTokens),
      );
      return textBlocks(resp.content) || 'I could not finish investigating within budget.';
    } catch {
      return 'I could not finish investigating within budget.';
    }
  }

  try {
    const top = p.registry.get(p.agentName);
    const result = await runAgent(top, wrapUserQuestion(p.question), 0, true);
    return {
      answer: result.text,
      citations: dedupeCitations(allCitations).slice(0, MAX_FINAL_CITATIONS),
      confidence: result.confidence,
      incompleteSearch: tracker.isTruncated(),
      commitSha: p.snapshot.commitSha,
      project: p.snapshot.project,
      usage: tracker.summary(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseConfidence(text: string): Confidence {
  const m = /confidence:\s*(high|medium|low)/i.exec(text);
  return (m?.[1]?.toLowerCase() as Confidence) ?? 'low';
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = `${c.path}:${c.startLine}-${c.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
