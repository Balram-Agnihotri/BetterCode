import { describe, expect, it } from 'vitest';
import type { BetterCodeConfig } from '../src/config/schema';
import { looksLikeQuestion, resolveChannelDecision } from '../src/config/resolveChannel';

function makeConfig(mode: 'auto' | 'mention-only' | 'off'): BetterCodeConfig {
  return {
    slack: { ignoreBotMessages: true, ignoreEditsAndDeletes: true },
    projects: { engage: {} },
    channels: {
      C1: {
        project: 'engage',
        agent: 'ProductLens',
        mode,
        triggers: { appMention: true, questionLikeMessages: true, botKeyword: 'BetterCode' },
      },
    },
  } as unknown as BetterCodeConfig;
}

const base = { channelId: 'C1', isBot: false, subtype: undefined, text: 'how does login work?' };

describe('resolveChannelDecision', () => {
  it('answers app mentions in configured channels', () => {
    const d = resolveChannelDecision(makeConfig('mention-only'), { ...base, isAppMention: true });
    expect(d.answer).toBe(true);
    if (d.answer) expect(d.reason).toBe('app_mention');
  });

  it('answers question-like messages only in auto mode', () => {
    const auto = resolveChannelDecision(makeConfig('auto'), { ...base, isAppMention: false });
    expect(auto.answer).toBe(true);

    const mentionOnly = resolveChannelDecision(makeConfig('mention-only'), { ...base, isAppMention: false });
    expect(mentionOnly.answer).toBe(false);
  });

  it('answers the bot keyword prefix even in mention-only mode', () => {
    const d = resolveChannelDecision(makeConfig('mention-only'), {
      ...base,
      isAppMention: false,
      text: 'BetterCode where is the auth middleware?',
    });
    expect(d.answer).toBe(true);
    if (d.answer) expect(d.reason).toBe('bot_keyword');
  });

  it('ignores bot messages and unconfigured channels', () => {
    expect(resolveChannelDecision(makeConfig('auto'), { ...base, isAppMention: false, isBot: true }).answer).toBe(false);
    expect(resolveChannelDecision(makeConfig('auto'), { ...base, channelId: 'CZ', isAppMention: true }).answer).toBe(false);
  });

  it('ignores everything when mode is off', () => {
    expect(resolveChannelDecision(makeConfig('off'), { ...base, isAppMention: true }).answer).toBe(false);
  });
});

describe('looksLikeQuestion', () => {
  it('detects question-shaped text', () => {
    expect(looksLikeQuestion('how does billing work')).toBe(true);
    expect(looksLikeQuestion('where is the auth code?')).toBe(true);
    expect(looksLikeQuestion('thanks team')).toBe(false);
    expect(looksLikeQuestion('lgtm')).toBe(false);
  });
});
