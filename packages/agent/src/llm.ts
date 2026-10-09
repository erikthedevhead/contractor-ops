import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';

/** The one LLM surface the agents use. Tests substitute a scripted fake. */
export interface LlmClient {
  create(params: MessageCreateParamsNonStreaming): Promise<Message>;
}

export function anthropicClient(apiKey: string): LlmClient {
  // The SDK retries 429/5xx with backoff (maxRetries); timeouts bound a hung call.
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 90_000 });
  return { create: (params) => client.messages.create(params) };
}

/** Model routing table. Haiku 5.5 is ~20x cheaper than Sonnet 5.5; use Sonnet only where reasoning pays. */
export const MODELS = {
  fast: 'claude-haiku-5-5',
  smart: 'claude-sonnet-5-5',
} as const;
