import type { AnswerResult, FailureCode, JobMessage } from '../types';

/** Escape the three characters Slack mrkdwn treats specially. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const INTERIM_TEXT = ':mag: BetterCode is checking the codebase…';

/**
 * Assemble the final Slack message. The model already produced a grounded,
 * mrkdwn-formatted body (answer + code evidence + confidence). We append a
 * trustworthy footer with the pinned commit and clickable GitHub source links
 * (built from real citations), plus an incompleteness note. The whole thing is
 * clamped to the channel's max length.
 */
export function formatFinalMessage(answer: AnswerResult, maxChars: number): string {
  const shortSha = answer.commitSha.slice(0, 12);

  const sources = answer.citations
    .slice(0, 6)
    .filter((c) => c.url)
    .map((c) => `• <${c.url}|${c.path}:L${c.startLine}-L${c.endLine}>`)
    .join('\n');

  const footerLines: string[] = ['', `*Repo:* ${answer.project} @ \`${shortSha}\``];
  if (sources) footerLines.push('*Sources:*', sources);
  if (answer.incompleteSearch) {
    footerLines.push('_Note: investigation was limited by budget; results may be incomplete._');
  }
  const footer = `\n${footerLines.join('\n')}`;

  const room = Math.max(280, maxChars - footer.length - 16);
  let body = answer.answer.trim();
  if (body.length > room) body = `${body.slice(0, room)}\n…_(truncated)_`;

  return `${body}${footer}`;
}

/** Graceful, user-friendly failure messages. Never leak internals. */
export function failureMessage(code: FailureCode): string {
  switch (code) {
    case 'REPO_UNAVAILABLE':
      return ':warning: I couldn’t access the repository just now. Please try again in a moment.';
    case 'BUDGET_EXCEEDED':
    case 'TIMEOUT':
      return ':hourglass: That question took longer than my budget allows. Try narrowing it to a specific feature, file, or flow.';
    case 'RATE_LIMITED':
      return ':warning: I’m handling a lot of requests right now. Please try again shortly.';
    case 'NOT_ANSWERABLE':
      return ':information_source: I can only answer questions about the configured codebase.';
    case 'LLM_ERROR':
    case 'INTERNAL':
    default:
      return ':warning: Something went wrong on my end while answering. The team has been notified.';
  }
}

export function interimContext(_job: JobMessage): string {
  return INTERIM_TEXT;
}
