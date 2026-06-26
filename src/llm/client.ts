/**
 * Provider-agnostic LLM abstraction. The orchestrator and tools depend only on
 * these types, so swapping/adding providers (Bedrock, OpenAI) means writing one
 * new LlmClient — no orchestration changes.
 */

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContent[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';

export interface LlmRequest {
  model: string;
  /** Ordered fallback model ids tried on retryable failure. */
  fallbacks?: string[];
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  model: string;
  stopReason: StopReason;
  content: LlmContent[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export function isToolUse(c: LlmContent): c is Extract<LlmContent, { type: 'tool_use' }> {
  return c.type === 'tool_use';
}

export function textBlocks(content: LlmContent[]): string {
  return content
    .filter((c): c is Extract<LlmContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}
