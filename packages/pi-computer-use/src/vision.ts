import { createModelErrorCapture, ValidationError } from '@amaster.ai/pi-shared';
import type { TextContent as AiTextContent } from '@earendil-works/pi-ai';
import { complete } from '@earendil-works/pi-ai/compat';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { VisionModelConfig } from './config.js';

export const VISUAL_SYSTEM_PROMPT = `You are a Visual Analysis Agent for computer-use automation.
You receive screenshots of a desktop and instructions about what to identify or analyze.

Your responses must:
- Describe UI elements with their exact pixel coordinates (x, y) relative to the top-left corner (0, 0)
- Identify clickable elements (buttons, links, inputs, menus) and their bounding regions
- Describe the current state of the screen (active window, focused element, visible text)
- Note any dialogs, popups, or overlays that may block interaction
- Provide spatial relationships between elements

When reporting coordinates for click targets, give the CENTER point of the element.
Format coordinates as (x, y) inline with descriptions.

If an element is not visible on screen, explicitly state so.
Do NOT perform actions — only analyze and report what you see.`;

export type VisionCaller = (
  instruction: string,
  imageBase64: string,
  mimeType: string,
  signal?: AbortSignal,
) => Promise<string>;

export function createPiVisionCaller(
  visionConfig: VisionModelConfig,
  ctx: ExtensionContext,
): VisionCaller {
  return async (
    instruction: string,
    imageBase64: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    const model = ctx.modelRegistry.find(visionConfig.provider, visionConfig.model);
    if (!model) {
      throw new ValidationError(
        'Vision model not found in model registry. Check the configured provider/model.',
        'configuration_error',
      );
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    signal?.throwIfAborted();
    if (!auth.ok) {
      throw new ValidationError(
        'Auth failed for vision model: credentials are unavailable. Check the vision model credentials.',
        'configuration_error',
      );
    }

    const options: Record<string, unknown> = {
      maxTokens: 2048,
    };
    if (auth.apiKey) options.apiKey = auth.apiKey;
    if (auth.headers) options.headers = auth.headers;
    if (signal) options.signal = signal;

    const modelErrors = createModelErrorCapture();
    Object.assign(options, modelErrors.fetchOptions(model.api));
    const result = await complete(
      model,
      {
        systemPrompt: VISUAL_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: `Analyze this screenshot and respond to the following instruction:\n\n${instruction}`,
              },
              { type: 'image' as const, data: imageBase64, mimeType },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );

    signal?.throwIfAborted();
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      throw modelErrors.error(
        'Vision model request',
        result,
        'Use accessibility tree elements instead.',
      );
    }

    if (process.env.DEBUG?.includes('pi-computer-use')) {
      const contentShape = result.content.map((c) => {
        const block = c as unknown as Record<string, unknown>;
        const type = typeof block.type === 'string' ? block.type : 'unknown';
        const text = typeof block.text === 'string' ? block.text : undefined;
        return {
          type,
          textLength: text?.length,
          keys: Object.keys(block),
        };
      });
      console.error(
        '[pi-computer-use vision] complete() returned',
        JSON.stringify(
          {
            provider: visionConfig.provider,
            model: visionConfig.model,
            imageBase64Length: imageBase64.length,
            mimeType,
            blockCount: result.content.length,
            contentShape,
          },
          null,
          2,
        ),
      );
    }

    const analysis = result.content
      .filter((c): c is AiTextContent => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (!analysis.trim())
      throw new ValidationError(
        'Vision model returned no analysis. Use accessibility tree elements instead.',
        'invalid_response',
      );
    return analysis;
  };
}
