import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  capabilitySizeDescription,
  hasAspectRatioKnob,
  hasImageSizeKnob,
  referenceImageDescription,
} from './capabilities.js';
import {
  listConfiguredProviders,
  listKnownModelIds,
  loadImageGenSettings,
  resolveModel,
} from './config.js';
import { errorMessageForUser, toLogSummary } from './errors.js';
import { generateImage } from './generate.js';
import type {
  ApiStyle,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
  ImageModelCapabilities,
} from './types.js';

export { loadImageGenSettings, resolveModel } from './config.js';
export { errorMessageForUser, toLogSummary } from './errors.js';
export { generateImage } from './generate.js';
export type { GenerateImageParams, ImageGenSettings } from './types.js';

/**
 * Quality levels advertised for providers whose `quality` vocabulary we have
 * verified: the built-in OpenAI gpt-image and OpenRouter image APIs. This is
 * deliberately NOT applied by wire format — a custom OpenAI-compatible provider
 * may use a different vocabulary (e.g. DALL·E 3 uses "standard"/"hd") or none at
 * all, so matching `api: "openai"` does not imply these values. See
 * {@link resolveImageToolCapabilities}.
 */
export const QUALITY_VALUES = ['low', 'medium', 'high', 'auto'] as const;

/** Provider-derived shape decisions for the `image_generate` schema. */
export interface ImageToolCapabilities {
  /** Active provider wire format, or null when the default model is unset/unresolvable. */
  api: ApiStyle | null;
  /** Allowed `quality` enum values, or null to omit `quality` from the schema entirely. */
  quality: readonly string[] | null;
  /**
   * Active model's capability contract — drives which of size/aspectRatio/
   * imageSize/n appear and with what enums, patterns, and descriptions. Null
   * (unset/unresolvable model, or a custom model with no contract) yields the
   * fully-generic fallback schema.
   */
  model: ImageModelCapabilities | null;
}

export default function piImageGenExtension(pi: ExtensionAPI): void {
  let settings: ImageGenSettings = {};
  let sessionCwd = process.cwd();

  // Single generate path shared by the tool's execute() and the /image-gen
  // generate command, so options construction and signal wiring can't drift
  // between the two. Callers layer their own result formatting / error surface
  // on top (a tool result vs. a UI notification).
  const runGenerate = (
    params: GenerateImageParams,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ImageGenResult> => {
    const opts: Parameters<typeof generateImage>[1] = { cwd, settings };
    if (signal) opts.signal = signal;
    return generateImage(params, opts);
  };

  // Register (or re-register) the tool with a schema shaped for the currently
  // configured provider. `registerTool` is keyed by name, so a repeat call
  // overwrites the previous definition — we call this on session_start (once
  // settings are loaded) and again after `/image-gen reload`, so the parameter
  // set always reflects the active model. Notably, `quality` only appears for
  // providers whose API honors it; the model never sees a no-op knob it would
  // otherwise have to reason about.
  const registerImageTool = (): void => {
    const caps = resolveImageToolCapabilities(settings);
    pi.registerTool({
      name: 'image_generate',
      label: 'ImageGen',
      description:
        'Generate or edit images. The image model is fixed by pi-image-gen.defaultModel in settings (this tool does not accept a model parameter). Pass `image` to do image-to-image / edit / style transfer / character preservation: a regular image file inside the session cwd (absolute or relative) or a public http(s) URL. To iterate on a previous result, pass its file path back when it is inside cwd. Do NOT pass base64 or data: URIs — write bytes to a file under cwd first. Saves the output to disk and returns the absolute path(s). When reporting the result to the user, render each generated image as inline markdown — copy the `![alt](…)` line(s) from the tool result verbatim so the UI can display it; do not just paste the bare path. Run /image-gen list to see the active model.',
      promptSnippet:
        'Generate or edit raster images (photos, illustrations, textures, mockups). Not for icons/logos/diagrams that should be repo-native SVG/CSS/canvas.',
      promptGuidelines: buildImageGuidelines(caps),
      parameters: buildImageToolParameters(caps) as never,
      async execute(_toolCallId: string, rawParams: unknown, signal, _onUpdate, ctx) {
        const params = rawParams as GenerateImageParams;
        const cwd = ctx?.cwd ?? sessionCwd;
        try {
          const result = await runGenerate(params, cwd, signal);
          return {
            content: [{ type: 'text' as const, text: formatToolResultText(result) }],
            details: result,
          };
        } catch (error) {
          // Both surfaces are sanitized (see errors.ts): errorMessageForUser
          // returns an ImageGenError's vetted, body-free hint (and a generic
          // sentence for any unexpected throw), while toLogSummary gives stderr a
          // terse category. Neither echoes a raw fs/fetch error or response body.
          console.error(`[pi-image-gen] image_generate failed: ${toLogSummary(error)}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `image_generate failed: ${errorMessageForUser(error)}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
      },
    });
  };

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    settings = loadImageGenSettings(ctx.cwd, isProjectTrusted(ctx));
    registerImageTool();
  });

  pi.registerCommand('image-gen', {
    description: 'pi-image-gen: /image-gen [list|reload|generate <prompt>]',
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const raw = (args ?? '').trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      if (tokens[0] === 'reload') {
        settings = loadImageGenSettings(ctx.cwd, isProjectTrusted(ctx));
        // Re-register so the schema (e.g. whether `quality` is exposed) tracks
        // the newly loaded model, not just the settings read at execute time.
        registerImageTool();
        ctx.ui.notify('pi-image-gen settings reloaded.', 'info');
        return;
      }
      if (tokens[0] === 'generate') {
        const prompt = raw.slice(tokens[0].length).trim();
        if (!prompt) {
          ctx.ui.notify('Usage: /image-gen generate <prompt>', 'error');
          return;
        }
        const cwd = ctx.cwd ?? sessionCwd;
        try {
          const result = await runGenerate({ prompt }, cwd, ctx.signal);
          // notify() renders as a plain status line, not markdown — surface a
          // readable path summary here rather than `![](…)` image syntax (which
          // would show up literally). The tool path keeps markdown for the LLM.
          ctx.ui.notify(formatCommandSummary(result), 'info');
        } catch (error) {
          // Terse category summary to stderr; the notify surface gets the fuller
          // (still body-free) sanitized message. See execute() and errors.ts.
          console.error(`[pi-image-gen] /image-gen generate failed: ${toLogSummary(error)}`);
          ctx.ui.notify(`image generation failed: ${errorMessageForUser(error)}`, 'error');
        }
        return;
      }
      const providers = listConfiguredProviders(settings);
      const defaultModel = settings.defaultModel?.trim();
      let activeLine = `Default model: ${defaultModel ?? '(not set — configure pi-image-gen.defaultModel in settings.json)'}`;
      if (defaultModel) {
        const resolved = resolveModel(defaultModel, settings);
        if ('error' in resolved) {
          activeLine += `\n  ! ${resolved.error}`;
        } else {
          const provider = resolved.provider;
          const keyOk = Boolean(provider.apiKey);
          activeLine += `\n  routes to: ${provider.id} [${provider.api}] ${provider.builtIn ? '' : '(custom) '}${keyOk ? 'apiKey: set' : 'apiKey: MISSING'}`;
        }
      }
      const lines = [
        activeLine,
        `Output dir: ${settings.outputDir ?? '.pi/images'}`,
        '',
        'Configured providers:',
        ...(providers.length
          ? providers.map((p) => {
              const tags: string[] = [`[${p.api}]`];
              if (!p.builtIn) tags.push('(custom)');
              if (p.catchAll) tags.push('(catch-all — accepts any model)');
              else if (p.modelCount > 0)
                tags.push(`(${p.modelCount} model${p.modelCount === 1 ? '' : 's'})`);
              return `  - ${p.id} ${tags.join(' ')}`;
            })
          : [
              '  (none — set OPENAI_API_KEY / GEMINI_API_KEY / DASHSCOPE_API_KEY / OPENROUTER_API_KEY / ARK_API_KEY)',
            ]),
        '',
        'Built-in models:',
        ...listKnownModelIds().map((m) => `  - ${m}`),
      ];
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}

/**
 * The `low`/`medium`/`high`/`auto` vocabulary is specific to OpenAI's **gpt-image**
 * family. Other OpenAI-wire models served under the same API use a different
 * vocabulary — DALL·E 3, for instance, takes `standard`/`hd` — so matching the
 * wire format (or even the built-in `openai` provider) is not enough; we must
 * see a gpt-image model id.
 *
 * This holds for two routes to gpt-image:
 *   - the built-in OpenAI provider (remote id `gpt-image-2`), and
 *   - OpenRouter, whose remote id embeds the underlying model (`openai/gpt-image-2`).
 *
 * It deliberately excludes `openai/dall-e-3` (built-in openai, but non-gpt-image)
 * and OpenRouter routes to non-OpenAI models (`bytedance-seed/seedream-4.5`, …).
 */
function honorsGptImageQuality(api: ApiStyle, remoteId: string): boolean {
  if (api !== 'openai' && api !== 'openrouter') return false;
  return /(?:^|\/)gpt-image/i.test(remoteId);
}

/**
 * Derive the provider-dependent schema shape from settings.
 *
 * `quality` is exposed (as a constrained enum) ONLY when the resolved model is a
 * built-in-routed OpenAI gpt-image model — via the built-in `openai` provider or
 * OpenRouter (see {@link honorsGptImageQuality}). For everything else — Gemini,
 * DashScope/Qwen, Ark/Seedream (no such knob), non-gpt-image OpenAI models like
 * DALL·E 3 (different vocabulary), and any custom provider (unknown vocabulary) —
 * `quality` is omitted so the model never sees a knob whose legal values we can't
 * guarantee. When the default model is unset or fails to resolve, we fall back to
 * the fully-featured schema so the tool stays usable and `execute` can surface a
 * friendly config error.
 */
export function resolveImageToolCapabilities(settings: ImageGenSettings): ImageToolCapabilities {
  const defaultModel = settings.defaultModel?.trim();
  if (!defaultModel) return { api: null, quality: QUALITY_VALUES, model: null };
  const resolved = resolveModel(defaultModel, settings);
  if ('error' in resolved) return { api: null, quality: QUALITY_VALUES, model: null };
  const { provider } = resolved;
  const quality =
    provider.builtIn && honorsGptImageQuality(provider.api, resolved.remoteId)
      ? QUALITY_VALUES
      : null;
  return { api: provider.api, quality, model: resolved.capabilities ?? null };
}

/**
 * Fallback description for the `size` parameter when the active model has no
 * capability contract (custom providers without a registry match). Models
 * with a contract get a precise description from {@link capabilitySizeDescription}.
 */
export function sizeDescription(api: ApiStyle | null): string {
  if (api === 'ark') {
    return 'Image size such as "2048x2048". Seedream 5.0 / 5.0-lite / 4.5 require 2K or larger — "1024x1024" fails with InvalidParameter; only Seedream 4.0 accepts 1K sizes.';
  }
  return 'Image size hint such as "1024x1024". Provider-specific; ignored if unsupported.';
}

/** Capability-independent part of the `image` parameter description. */
const IMAGE_PARAM_BASE =
  'Optional reference image(s) for image-to-image / edit / style transfer / character preservation. Each entry MUST be either (a) a regular image file inside the session cwd — absolute or relative — or (b) a public http(s) URL. Symlinks, Base64 strings, and data: URIs are rejected; write raw image bytes to a file under cwd first. For a single image pass ["path"]. Multi-image conditioning is supported by OpenAI gpt-image-2, Gemini, and Qwen sync models. To iterate on a previous output inside cwd, pass that file path here.';

/**
 * Build the `image_generate` parameter schema for the resolved capabilities.
 * The invariant params are always present; everything else is shaped by the
 * active model's contract so the LLM sees exactly the knobs the provider
 * honors, with the documented values as ADVICE in enums and descriptions:
 * - `size` carries the model's documented form and limits in its description
 *   (never a schema pattern — the provider validates; private deployments may
 *   diverge from the cloud docs) and is hidden for Gemini-style models;
 * - `aspectRatio` / `imageSize` appear only for models that honor them
 *   (imageSize only when more than one tier exists);
 * - `n` carries the documented ceiling in its description (no `maximum`) and
 *   is hidden for models with no count knob;
 * - `image` spells out the model's documented reference-image contract;
 * - `quality` appears only when {@link resolveImageToolCapabilities} says the
 *   active provider honors it.
 */
export function buildImageToolParameters(caps: ImageToolCapabilities) {
  const model = caps.model;
  const aspectRatios = model && hasAspectRatioKnob(model) ? model.aspectRatios : undefined;
  const tieredImageSizes = model && hasImageSizeKnob(model) ? model.imageSizes : undefined;
  const showSize = !aspectRatios;
  const sizeText = showSize
    ? ((model ? capabilitySizeDescription(model) : null) ?? sizeDescription(caps.api))
    : null;
  return Type.Object({
    prompt: Type.String({
      description: 'Text prompt describing what to generate or how to edit.',
    }),
    image: Type.Optional(
      Type.Array(Type.String(), {
        description: model
          ? `${IMAGE_PARAM_BASE} ${referenceImageDescription(model)}`
          : IMAGE_PARAM_BASE,
      }),
    ),
    ...(!model || model.nMax > 1
      ? {
          n: Type.Optional(
            Type.Number({
              minimum: 1,
              // Advisory only: the documented ceiling goes in the description,
              // not a schema `maximum` — a private deployment may legitimately
              // differ from the cloud docs, and the provider's error is the
              // backstop. The no-contract fallback keeps the original wording.
              description: model
                ? `Number of images. Default 1 (integer; the active model documents up to ${model.nMax}).`
                : 'Number of images. Default 1 (integer).',
            }),
          ),
        }
      : {}),
    ...(showSize && sizeText
      ? {
          size: Type.Optional(
            model?.sizes
              ? StringEnum(model.sizes, { description: sizeText })
              : Type.String({ description: sizeText }),
          ),
        }
      : {}),
    ...(aspectRatios
      ? {
          aspectRatio: Type.Optional(
            StringEnum(aspectRatios, {
              description: 'Aspect ratio for the active model (it has no pixel-size knob).',
            }),
          ),
          ...(tieredImageSizes
            ? {
                imageSize: Type.Optional(
                  StringEnum(tieredImageSizes, {
                    description:
                      'Output resolution tier for the active model (uppercase "K"). Omit for the default tier.',
                  }),
                ),
              }
            : {}),
        }
      : {}),
    ...(caps.quality
      ? {
          quality: Type.Optional(
            StringEnum(caps.quality, {
              description:
                'Quality level honored by the active provider (OpenAI gpt-image / OpenRouter): "low" for fast drafts/thumbnails, "medium", "high" for final assets or dense text, or "auto".',
            }),
          ),
        }
      : {}),
    filename: Type.Optional(Type.String({ description: 'Filename prefix (without extension).' })),
    outputDir: Type.Optional(
      Type.String({
        description:
          'Directory to write images into. Relative paths resolve against the session cwd.',
      }),
    ),
  });
}

/**
 * Build the tool's prompt guidelines for the resolved capabilities. Most bullets
 * are provider-independent; the `quality` tip is included only when the schema
 * actually exposes a `quality` param, so guidance never references a knob the
 * model cannot use.
 */
export function buildImageGuidelines(caps: ImageToolCapabilities): string[] {
  const showN = !caps.model || caps.model.nMax > 1;
  const guidelines = [
    'For best results, read the `image-gen` skill listed in `<available_skills>` before using image_generate; it contains the prompt-shaping workflow.',
    'Use image_generate for bitmap assets: photos, illustrations, textures, sprites, product/UI mockups, concept art. Do NOT use it for icons, logos, or diagrams that should match existing repo-native SVG/vector/CSS/canvas assets — edit or write those directly instead.',
    'Generate vs edit: with no `image`, or when `image` entries are only style/composition/mood references, this is a fresh generation. To modify an existing image while preserving most of it, pass that image and describe the change as an edit.',
    ...(showN
      ? [
          '`n` produces variants of ONE prompt, not distinct assets. For several different assets, make one image_generate call per asset with its own prompt (do not raise `n` to cover distinct subjects).',
        ]
      : []),
    'For edits and multi-image conditioning, label each reference by role (e.g. "Image 1: edit target; Image 2: style reference") and restate invariants every iteration ("change only X; keep Y unchanged") to reduce drift.',
    'For text inside an image, quote the exact string verbatim and specify placement; spell uncommon words letter-by-letter when accuracy matters.',
  ];
  guidelines.push(
    caps.quality
      ? 'Prefer one targeted change per iteration over rewriting the whole prompt. Use `quality: "low"` for fast drafts and a higher `quality` for final assets or dense text.'
      : 'Prefer one targeted change per iteration over rewriting the whole prompt.',
  );
  if (caps.model && hasAspectRatioKnob(caps.model)) {
    guidelines.push(
      'The active model has no pixel-`size` knob — set `aspectRatio` (and `imageSize` where offered) instead; passing `size` is rejected.',
    );
  }
  guidelines.push(
    'The active model is fixed in settings — there is no `model` parameter. If generation fails on model/size, run /image-gen list and tell the user which knob (defaultModel or size) to adjust.',
  );
  return guidelines;
}

/**
 * Format a generated-image result as text the LLM can paste verbatim into its
 * reply. Uses inline markdown image syntax with the file stem as the alt text.
 */
export function formatToolResultText(result: ImageGenResult): string {
  const lines: string[] = [
    `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}). Show each one to the user as inline markdown — copy the lines below verbatim into your reply:`,
    '',
    ...result.images.flatMap((img) => {
      const alt = altFromPath(img.path);
      const md = `![${alt}](${markdownImageUrl(img.path)})`;
      return img.revisedPrompt ? [md, `> revised prompt: ${img.revisedPrompt}`] : [md];
    }),
  ];
  return lines.join('\n');
}

/**
 * Markdown-safe image URL for a saved absolute path — valid CommonMark for
 * any host renderer (desktop, TUI, CLI alike):
 * - Windows drive-letter paths (`C:\…`) become percent-encoded
 *   `file:///C:/…` URLs — markdown URL sanitizers read `C:` as an unknown
 *   URI scheme and strip the img `src` otherwise.
 * - POSIX paths stay bare absolute paths; only markdown/URL-unsafe
 *   characters are percent-escaped, so clean paths stay byte-identical.
 * Hand-rolled (not pathToFileURL) so the Windows case behaves the same on
 * every OS and stays testable off-Windows.
 */
export function markdownImageUrl(absolutePath: string): string {
  const drive = /^([A-Za-z]:)[\\/]/.exec(absolutePath)?.[1];
  if (!drive) return escapeMarkdownUnsafe(absolutePath);
  const segments = absolutePath
    .slice(3)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeUrlSegment);
  return `file:///${drive}/${segments.join('/')}`;
}

/**
 * file:// URLs must be ASCII, so Windows path segments get full
 * percent-encoding; ( ) additionally need escaping (encodeURIComponent
 * leaves them) or they unbalance the markdown link destination.
 */
function encodeUrlSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[()]/g, hexEscape);
}

/**
 * Escape just the characters that break a bare path inside a markdown link
 * destination or a URL parse: whitespace, # ? % < > and ( ). Everything else
 * — including CJK — passes through byte-identical, so POSIX paths that render
 * inline today keep their exact current output.
 */
function escapeMarkdownUnsafe(path: string): string {
  return path.replace(/[\s#%()?<>]/g, hexEscape);
}

function hexEscape(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Format a generated-image result as a plain-text summary for `ctx.ui.notify`,
 * which renders a status line rather than markdown. Lists the saved absolute
 * paths (and any revised prompt) without `![](…)` syntax, which notify would
 * otherwise show literally.
 */
export function formatCommandSummary(result: ImageGenResult): string {
  const header = `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}):`;
  const lines = result.images.flatMap((img) =>
    img.revisedPrompt
      ? [`  ${img.path}`, `    revised prompt: ${img.revisedPrompt}`]
      : [`  ${img.path}`],
  );
  return [header, ...lines].join('\n');
}

/**
 * Derive a markdown `alt` from the saved file path. We use the filename without
 * its extension so the user-supplied `filename` (or our auto-generated stamp)
 * shows up in the rendered image label, not the model id.
 */
export function altFromPath(absolutePath: string): string {
  const segments = absolutePath.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? 'image';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  // Escape `]` so the markdown link doesn't break if the filename has one.
  return stem.replace(/\]/g, '\\]') || 'image';
}
