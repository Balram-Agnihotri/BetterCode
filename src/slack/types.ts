/** Minimal subset of the Slack Events API payload we consume. */

export interface SlackEnvelope {
  type: 'url_verification' | 'event_callback' | string;
  token?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
  event?: SlackInnerEvent;
}

export interface SlackInnerEvent {
  type: 'message' | 'app_mention' | string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  // message_changed / message_deleted carry a nested message
  message?: { user?: string; text?: string; ts?: string };
  hidden?: boolean;
}

/** Normalized, decision-ready view of an inbound message. */
export interface NormalizedMessage {
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs: string;
  isBot: boolean;
  isAppMention: boolean;
  /** True when a plain message embeds an @bot mention (handled via app_mention). */
  mentionsBot: boolean;
  subtype?: string | undefined;
}
