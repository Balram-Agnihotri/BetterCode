import Anthropic from '@anthropic-ai/sdk';
import { BetterCodeError } from '../types';
import type { LlmClient, LlmContent, LlmMessage, LlmRequest, LlmResponse, StopReason } from './client';

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 529]);
const MAX_ATTEMPTS_PER_MODEL = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const models = [req.model, ...(req.fallbacks ?? [])];
    let lastErr: unknown;
    for (const model of models) {
      try {
        return await this.callModel({ ...req, model });
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw mapError(err);
        // else: fall through to the next fallback model
      }
    }
    throw mapError(lastErr);
  }

  private async callModel(req: LlmRequest & { model: string }): Promise<LlmResponse> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await this.client.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0,
            system: req.system,
            messages: toAnthropicMessages(req.messages),
            ...(req.tools ? { tools: req.tools as unknown as Anthropic.Tool[] } : {}),
          },
          { signal: req.signal },
        );
        return {
          model: res.model,
          stopReason: mapStop(res.stop_reason),
          content: fromAnthropic(res.content),
          usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        };
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS_PER_MODEL || !isRetryable(err)) throw err;
        await sleep(250 * 2 ** (attempt - 1) + Math.random() * 100);
      }
    }
  }
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((c) => {
      switch (c.type) {
        case 'text':
          return { type: 'text', text: c.text };
        case 'tool_use':
          return { type: 'tool_use', id: c.id, name: c.name, input: c.input as object };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: c.toolUseId,
            content: c.content,
            ...(c.isError ? { is_error: true } : {}),
          };
      }
    }),
  })) as Anthropic.MessageParam[];
}

function fromAnthropic(blocks: Anthropic.ContentBlock[]): LlmContent[] {
  const out: LlmContent[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
  }
  return out;
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return reason;
    default:
      return 'other';
  }
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') return RETRY_STATUSES.has(status);
  return err instanceof Anthropic.APIConnectionError;
}

function mapError(err: unknown): BetterCodeError {
  const status = (err as { status?: number })?.status;
  const msg = (err as Error)?.message ?? 'unknown LLM error';
  if (status === 429) return new BetterCodeError('LLM_ERROR', `rate limited by provider: ${msg}`, true);
  return new BetterCodeError('LLM_ERROR', msg, isRetryable(err));
}
