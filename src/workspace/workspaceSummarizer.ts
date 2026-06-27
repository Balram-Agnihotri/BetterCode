/**
 * Workspace summarizer — rule-based compression of the investigation workspace.
 *
 * Called when the workspace token estimate exceeds the budget threshold.
 * Compresses by: truncating oldest file summaries, capping findings, and
 * deduplifying unknowns. This is intentionally lossy-only where safe.
 *
 * LLM-powered compression is a future Phase 5 enhancement.
 */
import type { InvestigationWorkspace } from './investigationWorkspace';

/** Inject the workspace summary into a system prompt string. */
export function injectWorkspaceSummary(
  systemPrompt: string,
  workspace: InvestigationWorkspace,
): string {
  if (!workspace.hasContent()) return systemPrompt;
  const summary = workspace.renderSummary();
  if (!summary) return systemPrompt;
  return `${systemPrompt}\n\n${summary}`;
}

/**
 * Check whether the workspace summary should be injected into the current
 * turn's user message (as a reminder of accumulated context).
 */
export function shouldInjectWorkspace(workspace: InvestigationWorkspace, turn: number): boolean {
  // Always inject after turn 1 (when we've read at least one file)
  return turn >= 1 && workspace.hasContent();
}
