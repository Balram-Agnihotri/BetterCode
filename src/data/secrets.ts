import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// Lazy-init SecretsManager client only when needed (local dev uses env vars)
let sm: SecretsManagerClient | null = null;
function getSmClient(): SecretsManagerClient {
  if (!sm) {
    sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  }
  return sm;
}
const cache = new Map<string, { value: string; exp: number }>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch a secret value, cached for the container lifetime (warm invocations
 * reuse it). For local dev, an env var named after the secret's last path
 * segment (uppercased, non-alnum -> _) is used as a fallback.
 */
export async function getSecret(secretName: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const cached = cache.get(secretName);
  if (cached && cached.exp > Date.now()) return cached.value;

  // Convert secret name to env var key: "bettercode/slack/bot-token" → "BETTERCODE_SLACK_BOT_TOKEN"
  const envKey = secretName.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const envFallback = process.env[envKey];

  if (envFallback) {
    cache.set(secretName, { value: envFallback, exp: Date.now() + ttlMs });
    return envFallback;
  }

  // Only call AWS SDK if env var not found
  const res = await getSmClient().send(new GetSecretValueCommand({ SecretId: secretName }));
  const value =
    res.SecretString ??
    (res.SecretBinary ? Buffer.from(res.SecretBinary as Uint8Array).toString('utf8') : '');
  if (!value) throw new Error(`secret ${secretName} is empty`);
  cache.set(secretName, { value, exp: Date.now() + ttlMs });
  return value;
}

/**
 * Materialize an SSH private key to a 0600 file (default under /tmp, which is
 * the only writable path in Lambda) and return its path for GIT_SSH_COMMAND.
 */
export async function materializeSshKey(
  secretName: string,
  destPath = '/tmp/bettercode/deploy_key',
): Promise<string> {
  const key = await getSecret(secretName);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
  await chmod(destPath, 0o600);
  return destPath;
}
