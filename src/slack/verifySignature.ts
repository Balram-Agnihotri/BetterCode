import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyArgs {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  /** The EXACT raw request body bytes Slack signed (decoded, not re-serialized). */
  rawBody: string;
  toleranceSec?: number;
}

/**
 * Verify a Slack request signature (v0 scheme) with a timing-safe comparison and
 * a replay window. Never short-circuit this — it is the trust boundary for the
 * entire ingress path.
 *
 * basestring = `v0:{timestamp}:{rawBody}`
 * expected   = `v0=` + HMAC_SHA256(signingSecret, basestring)
 */
export function verifySlackSignature(args: VerifyArgs): boolean {
  const { signingSecret, signature, timestamp, rawBody, toleranceSec = 300 } = args;
  if (!signature || !timestamp || !signingSecret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false; // replay defense

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
