import type { BetterCodeConfig, ChannelConfig, ProjectConfig, AccessConfig } from './schema';
import type { Budgets, TriggerReason } from '../types';

/** Inputs the ingress handler extracts from a normalized Slack event. */
export interface ChannelDecisionInput {
  channelId: string;
  isAppMention: boolean;
  isBot: boolean;
  /** e.g. message_changed / message_deleted; undefined for plain messages. */
  subtype?: string | undefined;
  /** Text with the bot mention stripped. */
  text: string;
}

export type ChannelDecision =
  | { answer: false; rejectReason: string }
  | {
      answer: true;
      reason: TriggerReason;
      project: string;
      agent: string;
      channel: ChannelConfig;
    };

/**
 * Pure routing decision. Given the config and a normalized event, decide
 * whether BetterCode should answer, and as which project/agent.
 *
 * Decision policy (see docs/DECISIONS.md #1):
 *   - app mentions are always answered in configured channels;
 *   - question-like messages are answered only when mode === 'auto';
 *   - everything else is ignored.
 */
export function resolveChannelDecision(
  cfg: BetterCodeConfig,
  input: ChannelDecisionInput,
): ChannelDecision {
  const channel = cfg.channels[input.channelId];
  if (!channel) return { answer: false, rejectReason: 'channel_not_configured' };
  if (channel.mode === 'off') return { answer: false, rejectReason: 'channel_off' };

  if (cfg.slack.ignoreBotMessages && input.isBot) {
    return { answer: false, rejectReason: 'bot_message' };
  }
  if (cfg.slack.ignoreEditsAndDeletes && input.subtype) {
    return { answer: false, rejectReason: `subtype_${input.subtype}` };
  }

  const project = channel.project;
  const agent = channel.agent;

  // 1) App mention: always eligible.
  if (input.isAppMention && channel.triggers.appMention) {
    return { answer: true, reason: 'app_mention', project, agent, channel };
  }

  // 2) Explicit bot keyword (e.g. "BetterCode: why ...").
  const keyword = channel.triggers.botKeyword;
  if (keyword && startsWithKeyword(input.text, keyword)) {
    return { answer: true, reason: 'bot_keyword', project, agent, channel };
  }

  // 3) Question-like, auto mode only.
  if (
    channel.mode === 'auto' &&
    channel.triggers.questionLikeMessages &&
    looksLikeQuestion(input.text)
  ) {
    return { answer: true, reason: 'question_like', project, agent, channel };
  }

  return { answer: false, rejectReason: 'not_triggered' };
}

function startsWithKeyword(text: string, keyword: string): boolean {
  return text.trim().toLowerCase().startsWith(keyword.toLowerCase());
}

/**
 * Cheap, dependency-free question heuristic. Intentionally conservative — the
 * router LLM does the authoritative intent gate (DECISIONS.md #1). This only
 * filters obvious non-questions before spending tokens.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.includes('?')) return true;
  return /^(how|what|why|where|when|which|who|does|do|is|are|can|could|should|would|where's|what's)\b/i.test(
    t,
  );
}

/** Merge global + per-channel budgets (channel overrides win). */
export function resolveBudgets(cfg: BetterCodeConfig, channel: ChannelConfig): Budgets {
  return { ...cfg.budgets, ...(channel.budgets ?? {}) };
}

/**
 * Merge global + project access policy. Deny globs are *unioned* (a project can
 * only ever add denials, never remove them — see security model).
 */
export function resolveAccess(cfg: BetterCodeConfig, project: ProjectConfig): AccessConfig {
  const base = cfg.access;
  const override = project.access;
  if (!override) return base;
  return {
    denyGlobs: Array.from(new Set([...base.denyGlobs, ...(override.denyGlobs ?? [])])),
    allowGlobs: override.allowGlobs ?? base.allowGlobs,
    maxBinaryBytesProbe: override.maxBinaryBytesProbe ?? base.maxBinaryBytesProbe,
  };
}
