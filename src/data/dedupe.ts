// In-memory event deduplication. Prevents duplicate answers when Slack retries
// an event (e.g. after a 504 from API Gateway). The map lives for the Lambda
// container lifetime; warm invocations reuse it, so retries within minutes hit
// the same cache. A cold start yields a fresh map — safe because cold starts
// happen only when no recent invocation could have produced the original answer.

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours; covers Slack's retry window
const cache = new Map<string, number>(); // eventId -> expiresAt

export async function claimEvent(eventId: string): Promise<boolean> {
  const now = Date.now();
  const expiry = cache.get(eventId);
  if (expiry !== undefined && expiry > now) return false; // duplicate
  cache.set(eventId, now + TTL_MS);
  // Prune stale entries to prevent unbounded growth on long-lived containers.
  if (cache.size > 10_000) {
    for (const [id, exp] of cache) {
      if (exp <= now) cache.delete(id);
    }
  }
  return true;
}
