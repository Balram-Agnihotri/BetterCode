import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySlackSignature } from '../src/slack/verifySignature';

const SECRET = 'test-signing-secret';

function sign(body: string, ts: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const body = JSON.stringify({ type: 'event_callback' });
  const ts = String(Math.floor(Date.now() / 1000));

  it('accepts a valid, fresh signature', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts), timestamp: ts, rawBody: body }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts), timestamp: ts, rawBody: `${body}x` }),
    ).toBe(false);
  });

  it('rejects an expired timestamp (replay)', () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(body, old), timestamp: old, rawBody: body }),
    ).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(
      verifySlackSignature({ signingSecret: 'nope', signature: sign(body, ts), timestamp: ts, rawBody: body }),
    ).toBe(false);
  });
});
