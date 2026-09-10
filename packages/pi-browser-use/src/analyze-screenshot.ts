/**
 * Optional vision-model integration.
 *
 * Takes a screenshot via the upstream take_screenshot tool, sends it to a
 * vision model, and returns the analysis as text. This lets the LLM identify
 * elements by visual attributes (color, layout, coordinates) when the
 * accessibility tree is insufficient.
 *
 * Both extension mode and CLI mode resolve credentials from Pi's model registry.
 */

import type { TextContent as AiTextContent } from '@earendil-works/pi-ai';
import type { VisionModelConfig } from './config.js';
import type { DevToolsClient } from './index.js';

/** System prompt for the vision analysis model. */
export const VISUAL_SYSTEM_PROMPT = `You are a Visual Analysis Agent. You receive a screenshot of a browser page and an instruction.

Your job is to ANALYZE the screenshot and provide precise information that a browser automation agent can act on.

COORDINATE SYSTEM:
- Coordinates are pixel-based relative to the viewport
- (0,0) is top-left of the visible area
- Estimate element positions from the screenshot

RESPONSE FORMAT:
- For coordinate identification: provide exact (x, y) pixel coordinates
- For element identification: describe the element's visual location and appearance
- For layout analysis: describe the spatial relationships between elements
- Be concise and actionable

IMPORTANT:
- You are NOT performing actions — you are only providing visual analysis
- Include coordinates when possible so the caller can use click_at(x, y)
- If the element is not visible in the screenshot, say so explicitly`;

/**
 * Abstraction for calling a vision model.
 * Extension mode and CLI mode each provide their own implementation.
 */
export type VisionCaller = (
  instruction: string,
  imageBase64: string,
  mimeType: string,
  signal?: AbortSignal,
) => Promise<string>;

/** Create a VisionCaller that resolves credentials from Pi's model registry. Used in CLI standalone mode. */
export function createFetchVisionCaller(visionConfig: VisionModelConfig): VisionCaller {
  // Imported lazily: pi-ai and pi-coding-agent are heavy and only needed on an actual vision call.
  const registryPromise = import('@earendil-works/pi-coding-agent').then(
    ({ ModelRegistry, ModelRuntime }) =>
      ModelRuntime.create().then((modelRuntime) => new ModelRegistry(modelRuntime)),
  );

  return async (
    instruction: string,
    imageBase64: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const [registry, { complete }] = await Promise.all([
      registryPromise,
      import('@earendil-works/pi-ai/compat'),
    ]);
    const model = registry.find(visionConfig.provider, visionConfig.model);
    if (!model) {
      throw new Error(
        `Vision model "${visionConfig.provider}/${visionConfig.model}" not found in model registry.`,
      );
    }

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(`Auth failed for vision model: ${auth.error}`);
    }

    const options: Record<string, unknown> = {
      maxTokens: 2048,
    };
    if (auth.apiKey) options.apiKey = auth.apiKey;
    if (auth.headers) options.headers = auth.headers;
    if (signal) options.signal = signal;

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

    if (result.stopReason === 'error') {
      throw new Error(result.errorMessage || 'Vision model request failed');
    }

    return result.content
      .filter((c): c is AiTextContent => c.type === 'text')
      .map((c) => c.text)
      .join('');
  };
}

// ---------------------------------------------------------------------------
// Main handler (framework-agnostic)
// ---------------------------------------------------------------------------

/**
 * Capture a screenshot via the upstream tool and analyze it with the provided vision caller.
 * The caller abstraction allows extension mode (pi-ai) and CLI mode (raw fetch) to share logic.
 */
export async function handleAnalyzeScreenshot(
  client: DevToolsClient,
  callVision: VisionCaller,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const instruction = String(args.instruction ?? '');
  const screenshotArgs = typeof args.pageId === 'number' ? { pageId: args.pageId } : {};

  try {
    const screenshotResult = await client.callTool('take_screenshot', screenshotArgs, signal);

    let imageBase64 = '';
    let mimeType = 'image/png';
    if (screenshotResult.content && Array.isArray(screenshotResult.content)) {
      for (const item of screenshotResult.content) {
        if (item.type === 'image' && item.data) {
          imageBase64 = item.data;
          mimeType = item.mimeType ?? 'image/png';
          break;
        }
      }
    }

    if (!imageBase64) {
      return {
        content: [
          {
            type: 'text',
            text: 'Failed to capture screenshot for visual analysis. Use accessibility tree elements instead.',
          },
        ],
        isError: true,
      };
    }

    const analysis = await callVision(instruction, imageBase64, mimeType, signal);

    if (!analysis) {
      return {
        content: [
          {
            type: 'text',
            text: 'Visual model returned no analysis. Use accessibility tree elements instead.',
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `Visual Analysis Result:\n${analysis}` }],
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const errorMsg = error instanceof Error ? error.message : String(error);

    const isModelError =
      errorMsg.includes('404') ||
      errorMsg.includes('403') ||
      errorMsg.includes('not found') ||
      errorMsg.includes('permission');

    if (!isModelError) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[pi-browser-use] visual analysis failed (${errorName})`);
    }

    const fallbackMsg = isModelError
      ? 'Visual analysis model is not available. Use accessibility tree elements (uids from take_snapshot) for all interactions instead.'
      : 'Visual analysis failed. Use accessibility tree elements instead.';

    return {
      content: [{ type: 'text', text: fallbackMsg }],
      isError: true,
    };
  }
}
