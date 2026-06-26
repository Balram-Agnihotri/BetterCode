import type { BetterCodeConfig } from '../config/schema';

export interface ResolvedModel {
  id: string;
  maxTokens: number;
  fallbacks: string[];
}

type Tier = 'router' | 'explore' | 'synth';
const TIERS: readonly Tier[] = ['router', 'explore', 'synth'];

function isTier(key: string): key is Tier {
  return (TIERS as readonly string[]).includes(key);
}

/**
 * Resolve an agent's `model` (a tier key like "synth", or an explicit model id)
 * into a concrete model id + token cap + ordered fallbacks.
 */
export function resolveModel(cfg: BetterCodeConfig, key: string): ResolvedModel {
  if (isTier(key)) {
    const spec = cfg.llm.models[key];
    return { id: spec.id, maxTokens: spec.maxTokens, fallbacks: cfg.llm.fallbacks[key] ?? [] };
  }
  // Explicit model id: use as-is with a sensible default cap.
  return { id: key, maxTokens: 4096, fallbacks: [] };
}

/** USD per million tokens. Conservative defaults; tune from billing data. */
const PRICES: Record<string, { in: number; out: number }> = {
  // Anthropic
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-3-5-sonnet-latest': { in: 3, out: 15 },
  'claude-3-5-haiku-latest': { in: 0.8, out: 4 },
  // OpenAI
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4-turbo': { in: 10, out: 30 },
  'o1': { in: 15, out: 60 },
  'o1-mini': { in: 3, out: 12 },
  'o3-mini': { in: 1.1, out: 4.4 },
};
const DEFAULT_PRICE = { in: 3, out: 15 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? matchByPrefix(model) ?? DEFAULT_PRICE;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

function matchByPrefix(model: string): { in: number; out: number } | undefined {
  if (model.includes('haiku')) return PRICES['claude-3-5-haiku-latest'];
  if (model.includes('sonnet')) return PRICES['claude-3-5-sonnet-latest'];
  if (model.startsWith('gpt-4o-mini')) return PRICES['gpt-4o-mini'];
  if (model.startsWith('gpt-4o')) return PRICES['gpt-4o'];
  if (model.startsWith('gpt-4')) return PRICES['gpt-4-turbo'];
  if (model.startsWith('o1-mini')) return PRICES['o1-mini'];
  if (model.startsWith('o1')) return PRICES['o1'];
  if (model.startsWith('o3-mini')) return PRICES['o3-mini'];
  return undefined;
}
