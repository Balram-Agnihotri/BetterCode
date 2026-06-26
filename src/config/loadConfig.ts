import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type BetterCodeConfig } from './schema';

let cached: BetterCodeConfig | undefined;

/**
 * Load + validate the root config. Cached for the lifetime of the Lambda
 * container (warm invocations reuse it). Throws a descriptive error on the
 * first malformed field so misconfig fails fast instead of mis-routing.
 */
export async function loadConfig(
  path = process.env.BETTERCODE_CONFIG_PATH ?? 'bettercode.config.yaml',
): Promise<BetterCodeConfig> {
  if (cached) return cached;
  const abs = resolve(path);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read BetterCode config at ${abs}: ${(err as Error).message}`);
  }

  const doc: unknown = parseYaml(raw);
  const parsed = configSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid bettercode.config.yaml:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: reset the module cache. */
export function __resetConfigCache(): void {
  cached = undefined;
}
