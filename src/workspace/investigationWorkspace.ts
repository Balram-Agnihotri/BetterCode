/**
 * InvestigationWorkspace — per-job mutable state.
 *
 * Created fresh for each Slack question. Accumulates what the agent learns
 * so the orchestrator can inject a compressed summary rather than replaying
 * every raw tool result into the conversation.
 *
 * Repository knowledge (symbol index, BM25) lives in RepoKnowledgeBase and
 * is NOT reset between jobs — only the investigation state is per-job.
 */
import type { FileEntry, Finding, WorkspaceState, WorkspaceSummary } from './types';

/** Rough chars-per-token estimate for token budget calculations. */
const CHARS_PER_TOKEN = 4;

/** Max file summary stored per file (chars). Compress beyond this. */
const MAX_SUMMARY_CHARS = 500;

/** Max number of file entries to keep at full fidelity. */
const MAX_FULL_FILES = 15;

export class InvestigationWorkspace {
  private state: WorkspaceState = {
    files: new Map(),
    findings: [],
    hypothesis: '',
    unknowns: [],
    callChains: [],
    private_readSeq: 0,
  };

  // -------------------------------------------------------------------------
  // Write methods (called by tools or automatically by the read tool)
  // -------------------------------------------------------------------------

  /**
   * Record that a file was read. Auto-generates a one-line summary from the
   * content. Called automatically by the read tool after every successful read.
   */
  recordFileRead(path: string, content: string, startLine = 1, endLine?: number): void {
    const existing = this.state.files.get(path);
    const seq = ++this.state.private_readSeq;

    // Extract key symbol names from the content (naive: capitalized words after
    // 'function ', 'class ', 'interface ', 'export ', 'def ', 'class ')
    const keySymbols = extractKeySymbols(content);

    const summary = existing
      ? existing.summary // preserve agent-written summary if exists
      : autoSummary(content, path);

    this.state.files.set(path, {
      path,
      summary,
      keySymbols,
      linesRead: { start: startLine, end: endLine ?? startLine + content.split('\n').length },
      readAt: seq,
    });

    this.maybeCompress();
  }

  /** Add a discrete finding. Called by the `recordFinding` tool. */
  recordFinding(text: string, evidence: string[], confidence: Finding['confidence']): void {
    this.state.findings.push({ text, evidence, confidence });
  }

  /** Update the working hypothesis. Called by the `updateHypothesis` tool. */
  updateHypothesis(text: string): void {
    this.state.hypothesis = text.trim().slice(0, 800);
  }

  /** Add an unresolved question for the agent to revisit. */
  addUnknown(question: string): void {
    if (!this.state.unknowns.includes(question)) {
      this.state.unknowns.push(question);
    }
  }

  /** Mark a question as resolved (remove from unknowns). */
  resolveUnknown(question: string): void {
    this.state.unknowns = this.state.unknowns.filter(
      (u) => !u.toLowerCase().includes(question.toLowerCase()),
    );
  }

  /** Record a notable call or execution chain. */
  addCallChain(chain: string): void {
    if (!this.state.callChains.includes(chain)) {
      this.state.callChains.push(chain);
    }
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  /** Whether the workspace has been populated at all. */
  hasContent(): boolean {
    return (
      this.state.files.size > 0 ||
      this.state.findings.length > 0 ||
      this.state.hypothesis.length > 0
    );
  }

  /** True when the model has recorded ≥2 findings and resolved all unknowns. */
  isReadyToSynthesize(): boolean {
    return this.state.findings.length >= 2 && this.state.unknowns.length === 0;
  }

  /**
   * Return a structured summary suitable for injection into the system prompt.
   * This replaces raw tool result history in the context window.
   */
  getSummary(): WorkspaceSummary {
    // Sort files by recency (most recently read first)
    const files = [...this.state.files.values()].sort((a, b) => b.readAt - a.readAt);

    return {
      filesRead: files.map((f) => {
        const range = `L${f.linesRead.start}-L${f.linesRead.end}`;
        const syms = f.keySymbols.length ? ` [${f.keySymbols.slice(0, 5).join(', ')}]` : '';
        return `${f.path} (${range})${syms}: ${f.summary}`;
      }),
      findings: this.state.findings,
      hypothesis: this.state.hypothesis,
      unknowns: this.state.unknowns,
      callChains: this.state.callChains,
      tokenEstimate: this.getTokenEstimate(),
    };
  }

  /** Render the workspace summary as a string for prompt injection. */
  renderSummary(): string {
    if (!this.hasContent()) return '';
    const s = this.getSummary();
    const parts: string[] = ['## Current Investigation Workspace'];

    if (s.hypothesis) {
      parts.push(`**Working hypothesis:** ${s.hypothesis}`);
    }

    if (s.filesRead.length > 0) {
      parts.push(`**Files read (${s.filesRead.length}):**`);
      parts.push(...s.filesRead.map((f) => `  • ${f}`));
    }

    if (s.findings.length > 0) {
      parts.push(`**Findings (${s.findings.length}):**`);
      parts.push(
        ...s.findings.map(
          (f) =>
            `  • [${f.confidence}] ${f.text}${f.evidence.length ? ` — ${f.evidence.join(', ')}` : ''}`,
        ),
      );
    }

    if (s.unknowns.length > 0) {
      parts.push(`**Still unknown:**`);
      parts.push(...s.unknowns.map((u) => `  • ${u}`));
    }

    if (s.callChains.length > 0) {
      parts.push(`**Call chains:** ${s.callChains.join(' | ')}`);
    }

    return parts.join('\n');
  }

  /** Rough token estimate for budget tracking. */
  getTokenEstimate(): number {
    // Compute directly from state to avoid circular call through renderSummary/getSummary.
    const chars =
      this.state.hypothesis.length +
      [...this.state.files.values()].reduce((n, f) => n + f.path.length + f.summary.length, 0) +
      this.state.findings.reduce((n, f) => n + f.text.length + f.evidence.join('').length, 0) +
      this.state.unknowns.join('').length +
      this.state.callChains.join('').length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  // -------------------------------------------------------------------------
  // Compression
  // -------------------------------------------------------------------------

  /**
   * When the workspace grows large, compress the oldest file entries to keep
   * the context injection lean. Newest files are kept at full fidelity.
   */
  private maybeCompress(): void {
    if (this.state.files.size <= MAX_FULL_FILES) return;

    // Sort by recency; keep the most recent MAX_FULL_FILES
    const sorted = [...this.state.files.entries()].sort(
      ([, a], [, b]) => b.readAt - a.readAt,
    );

    for (const [path, entry] of sorted.slice(MAX_FULL_FILES)) {
      // Compress: truncate summary to 1 line
      this.state.files.set(path, {
        ...entry,
        summary: entry.summary.split('\n')[0]?.slice(0, MAX_SUMMARY_CHARS) ?? entry.summary,
        keySymbols: entry.keySymbols.slice(0, 3),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function autoSummary(content: string, path: string): string {
  const firstLines = content.split('\n').slice(0, 5).join(' ').replace(/\s+/g, ' ').trim();
  const ext = path.split('.').pop() ?? '';
  const MAX = 200;
  if (firstLines.length <= MAX) return firstLines;
  return firstLines.slice(0, MAX) + '…';
}

function extractKeySymbols(content: string): string[] {
  const seen = new Set<string>();
  // Match common declaration patterns across languages
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Z][a-zA-Z0-9_]*)/g,
    /(?:export\s+)?class\s+([A-Z][a-zA-Z0-9_]*)/g,
    /(?:export\s+)?interface\s+([A-Z][a-zA-Z0-9_]*)/g,
    /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
    /def\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /class\s+([A-Z][a-zA-Z0-9_]*)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) seen.add(match[1]);
      if (seen.size >= 10) break;
    }
    if (seen.size >= 10) break;
  }
  return [...seen].slice(0, 8);
}
