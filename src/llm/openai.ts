import OpenAI from 'openai';
import { BetterCodeError } from '../types';
import type { LlmClient, LlmContent, LlmMessage, LlmRequest, LlmResponse, StopReason } from './client';

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503]);
const MAX_ATTEMPTS_PER_MODEL = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAIClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
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
      }
    }
    throw mapError(lastErr);
  }

  private async callModel(req: LlmRequest & { model: string }): Promise<LlmResponse> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const messages = toOpenAIMessages(req.system, req.messages);
        const tools = req.tools
          ? req.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            }))
          : undefined;

        const res = await this.client.chat.completions.create(
          {
            model: req.model,
            messages,
            ...(tools ? { tools, tool_choice: 'auto' } : {}),
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0,
          },
          { signal: req.signal },
        );

        const choice = res.choices[0];
        if (!choice) throw new BetterCodeError('LLM_ERROR', 'OpenAI returned no choices', false);

        return {
          model: res.model,
          stopReason: mapStop(choice.finish_reason),
          content: fromOpenAI(choice.message),
          usage: {
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
          },
        };
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS_PER_MODEL || !isRetryable(err)) throw err;
        await sleep(250 * 2 ** (attempt - 1) + Math.random() * 100);
      }
    }
  }
}

function toOpenAIMessages(
  system: string,
  messages: LlmMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'user') {
      // Collect text and tool_result blocks into a user message.
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
      const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

      for (const c of m.content) {
        if (c.type === 'text') {
          parts.push({ type: 'text', text: c.text });
        } else if (c.type === 'tool_result') {
          toolResults.push({
            role: 'tool',
            tool_call_id: c.toolUseId,
            content: c.content,
          });
        }
      }

      if (parts.length > 0) {
        out.push({ role: 'user', content: parts });
      }
      out.push(...toolResults);
    } else {
      // assistant role: may have text and/or tool_use blocks
      const textParts = m.content
        .filter((c): c is Extract<LlmContent, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      const toolCalls = m.content
        .filter((c): c is Extract<LlmContent, { type: 'tool_use' }> => c.type === 'tool_use')
        .map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));

      out.push({
        role: 'assistant',
        content: textParts || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return out;
}

function fromOpenAI(msg: OpenAI.Chat.ChatCompletionMessage): LlmContent[] {
  const out: LlmContent[] = [];

  if (msg.content) {
    out.push({ type: 'text', text: msg.content });
  }

  for (const tc of msg.tool_calls ?? []) {
    if (tc.type !== 'function') continue;
    let input: unknown;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = tc.function.arguments;
    }
    out.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }

  return out;
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') return RETRY_STATUSES.has(status);
  return err instanceof OpenAI.APIConnectionError;
}

function mapError(err: unknown): BetterCodeError {
  const status = (err as { status?: number })?.status;
  const msg = (err as Error)?.message ?? 'unknown LLM error';
  if (status === 429) return new BetterCodeError('LLM_ERROR', `rate limited by provider: ${msg}`, true);
  return new BetterCodeError('LLM_ERROR', msg, isRetryable(err));
}
