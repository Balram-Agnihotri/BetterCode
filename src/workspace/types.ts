/**
 * Types for the per-job investigation workspace.
 *
 * The workspace accumulates everything the agent discovers during a single
 * Slack question so the LLM can see a compressed summary of prior work
 * instead of replaying every raw tool result.
 */

export interface FileEntry {
  /** Repo-relative path. */
  path: string;
  /** Brief summary of what was found (auto-generated or LLM-written). */
  summary: string;
  /** Notable symbol names encountered. */
  keySymbols: string[];
  /** Line range that was read. */
  linesRead: { start: number; end: number };
  readAt: number; // monotonic counter for recency
}

export interface Finding {
  /** Plain-text description of the finding. */
  text: string;
  /** Citation anchors: 'path:L12' or 'path:L12-L34'. */
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface WorkspaceState {
  /** All files read so far (may be compressed by summarizer). */
  files: Map<string, FileEntry>;
  /** Discrete findings accumulated during exploration. */
  findings: Finding[];
  /** Working hypothesis — what we currently believe the answer is. */
  hypothesis: string;
  /** Questions still unresolved — drives further exploration. */
  unknowns: string[];
  /** Notable call/execution chains discovered. */
  callChains: string[];
  /** Monotonic counter for ordering reads. */
  private_readSeq: number;
}

export interface WorkspaceSummary {
  filesRead: string[];
  findings: Finding[];
  hypothesis: string;
  unknowns: string[];
  callChains: string[];
  tokenEstimate: number;
}
