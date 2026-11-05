import { describeToolError, modelResponseError, ValidationError } from '@amaster.ai/pi-shared';
/**
 * Single-turn, tool-less LLM completion helper shared by the derive and
 * evaluate steps. Wraps pi-agent-core's Agent + pi-ai's streamSimple, the same
 * primitives pi-memory uses for background work.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { GoalModelConfig } from './config.js';

/** Minimal slice of ctx.modelRegistry we depend on (kept narrow for testability). */
export interface GoalModelRegistry {
  find(provider: string, model: string): unknown;
  getApiKeyAndHeaders(
    model: unknown,
  ): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

interface AgentMessageLike {
  role: string;
  content: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Run one system+user prompt through the model and return the assistant's text.
 * Returns null on any resolution/auth failure so callers can degrade gracefully
 * (never throws for expected failures).
 */
export type CompletionFailure = ReturnType<typeof describeToolError>;

export async function completeOnce(
  registry: GoalModelRegistry,
  modelConfig: GoalModelConfig,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onError?: (failure: CompletionFailure) => void,
): Promise<string | null> {
  try {
    if (signal?.aborted) return null;
    const model = registry.find(modelConfig.provider, modelConfig.model);
    if (!model)
      throw new ValidationError(
        'The configured goal evaluator model is not registered.',
        'configuration_error',
      );
    const auth = await registry.getApiKeyAndHeaders(model);
    if (signal?.aborted) return null;
    if (!auth.ok)
      throw new ValidationError(
        'Goal evaluator credentials are unavailable. Check the model credentials.',
        'configuration_error',
      );
    const agent = new Agent({
      initialState: { systemPrompt, model: model as never, tools: [] as never[] },
      streamFn: (m: unknown, c: unknown, streamOpts?: unknown) => {
        const merged = { ...((streamOpts as Record<string, unknown>) ?? {}) };
        if (auth.apiKey) merged.apiKey = auth.apiKey;
        if (auth.headers) merged.headers = auth.headers;
        const existingSignal = (streamOpts as { signal?: AbortSignal } | undefined)?.signal;
        if (signal)
          merged.signal = existingSignal ? AbortSignal.any([existingSignal, signal]) : signal;
        return streamSimple(m as never, c as never, merged as never);
      },
      convertToLlm: (msgs: unknown) => msgs as never[],
    });
    agent.subscribe((event: unknown) => {
      if ((event as { type?: string }).type === 'turn_end') void agent.abort();
    });
    const onAbort = () => agent.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      await agent.prompt(userPrompt);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) return null;
    const messages = agent.state.messages as AgentMessageLike[];
    const last = messages.filter((message) => message.role === 'assistant').at(-1);
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted')
      throw modelResponseError('Goal evaluator request', last);
    const text = lastAssistantText(messages);
    if (!text)
      throw new ValidationError(
        'Goal evaluator returned no text. No judgment was made.',
        'invalid_response',
      );
    return text;
  } catch (error) {
    if (signal?.aborted) return null;
    const failure = describeToolError(
      'Goal evaluator request',
      error,
      'No goal judgment was made. Check the evaluator before resuming.',
    );
    console.error(`[pi-goal] evaluator unavailable (category=${failure.errorCategory})`);
    onError?.(failure);
    return null;
  }
}

function lastAssistantText(messages: AgentMessageLike[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    const text = extractText(msg.content);
    if (text) return text;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('\n')
      .trim();
  }
  return '';
}
