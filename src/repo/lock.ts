export interface HeldLock {
  key: string;
  token: string;
}

export interface LockOptions {
  ttlMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

/** No-op lock: runs fn() directly. Safe for single-process, low-traffic deployments. */
export async function withRepoLock<T>(
  _key: string,
  fn: () => Promise<T>,
  _opts: LockOptions = {},
): Promise<T> {
  return fn();
}
