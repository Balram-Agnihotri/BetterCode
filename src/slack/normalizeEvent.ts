import type { NormalizedMessage, SlackEnvelope, SlackInnerEvent } from './types';

/**
 * Normalize a raw Slack inner event into a decision-ready shape. Returns null
 * when the event is not a message/app_mention we could ever answer (e.g. join
 * notices, channel topic changes).
 */
export function normalizeEvent(envelope: SlackEnvelope): NormalizedMessage | null {
  const ev = envelope.event;
  if (!ev) return null;
  if (ev.type !== 'message' && ev.type !== 'app_mention') return null;

  const botUserId = envelope.authorizations?.find((a) => a.is_bot)?.user_id;

  const channelId = ev.channel ?? '';
  const ts = ev.ts ?? '';
  if (!channelId || !ts) return null;

  const rawText = ev.text ?? ev.message?.text ?? '';
  const userId = ev.user ?? ev.message?.user ?? '';

  const isBot = Boolean(ev.bot_id) || ev.subtype === 'bot_message' || (!!botUserId && userId === botUserId);
  const isAppMention = ev.type === 'app_mention';
  const mentionsBot = !!botUserId && rawText.includes(`<@${botUserId}>`);

  return {
    channelId,
    userId,
    text: stripMentions(rawText).trim(),
    ts,
    threadTs: ev.thread_ts ?? ts, // reply in-thread; start a thread off the message if none
    isBot,
    isAppMention,
    mentionsBot,
    ...(ev.subtype ? { subtype: ev.subtype } : {}),
  };
}

/** Remove all `<@U…>` user mentions (including the bot's) from text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, ' ').replace(/\s+/g, ' ');
}

/** Convenience: is this inner event a hidden/edit/delete we should skip? */
export function isHiddenEdit(ev: SlackInnerEvent): boolean {
  return ev.hidden === true || ev.subtype === 'message_changed' || ev.subtype === 'message_deleted';
}
