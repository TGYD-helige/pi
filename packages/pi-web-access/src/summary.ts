import { modelResponseError, SafeToolError, ValidationError } from '@amaster.ai/pi-shared';
import { completeModelRequest } from '@amaster.ai/pi-shared/models';
import type { TextContent as AiTextContent } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SummaryModelConfig } from './types.js';

const SYSTEM_PROMPT = `You are a content extraction assistant. You receive web page content (in markdown) and a user prompt describing what information to extract or summarize. Respond concisely with only the relevant information requested. Do not add commentary or explanations beyond what was asked.`;

const MAX_CONTENT_LENGTH = 100_000;

export async function summarizeContent(
  content: string,
  prompt: string,
  config: SummaryModelConfig,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string> {
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new ValidationError(
      'Summary model not found in model registry. Check the web fetch summary model configuration.',
      'configuration_error',
    );
  }

  const auth =
    typeof ctx.modelRegistry.streamSimple === 'function'
      ? {}
      : await ctx.modelRegistry.getApiKeyAndHeaders(model);
  const missingCredentials = () =>
    new ValidationError(
      'Auth failed for summary model. Check the credentials for the provider that serves the configured summary model.',
      'configuration_error',
    );
  if ('ok' in auth && !auth.ok) throw missingCredentials();

  const truncated =
    content.length > MAX_CONTENT_LENGTH
      ? `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated due to length...]`
      : content;

  const result = await completeModelRequest(
    ctx.modelRegistry,
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: `Here is the web page content:\n\n${truncated}\n\n---\n\nUser request: ${prompt}`,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { ...(signal ? { signal } : {}), temperature: 0, maxTokens: 4096 },
    auth,
  ).catch((error) => {
    signal?.throwIfAborted();
    throw new SafeToolError('Summary model request', error);
  });

  signal?.throwIfAborted();
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    // These Pi registry diagnostics are safe to classify, regardless of the provider name.
    if (
      result.errorMessage === `Provider is not configured: ${model.provider}` ||
      result.errorMessage === 'authHeader requires a resolved API key' ||
      (result.errorMessage?.startsWith(`Virtual model ${model.provider}/${model.id} routed to `) &&
        result.errorMessage.endsWith(', which has no credentials.'))
    ) {
      throw missingCredentials();
    }
    throw modelResponseError('Summary model request', result);
  }
  return result.content
    .filter((c): c is AiTextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}
