import { resolve } from 'node:path';
import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import { providerLabel, VideoGenError } from './errors.js';
import { ARK_DEFAULT_BASE_URL } from './providers/ark.js';
import { DASHSCOPE_DEFAULT_BASE_URL } from './providers/dashscope.js';
import { KLING_DEFAULT_BASE_URL } from './providers/kling.js';
import { MINIMAX_DEFAULT_BASE_URL } from './providers/minimax.js';
import { BUILT_IN_VIDEO_MODELS, findBuiltInModel } from './providers/models.js';
import { OPENROUTER_DEFAULT_BASE_URL } from './providers/openrouter.js';
import type {
  CustomVideoModel,
  ResolvedModel,
  ResolvedProvider,
  VideoApiStyle,
  VideoGenSettings,
  VideoModelCapabilities,
} from './types.js';

const SETTINGS_KEY = 'pi-video-gen';

/**
 * Fallback model when neither the caller nor settings.defaultModel name one.
 * A full registry id, NOT an alias — aliases can be dropped between versions,
 * the default must not depend on one.
 */
export const DEFAULT_VIDEO_MODEL_ID = 'doubao-seedance-2-0-260128';

/**
 * Keys a project-level settings file may set. Everything else — notably
 * `providers.*.baseUrl/apiKey` and `ffmpegPath` — is accepted ONLY from the
 * global and agent-dir layers, even when the project is trusted: a malicious
 * repo must not be able to redirect paid API traffic (and the key that comes
 * with it) to an attacker endpoint, or swap the ffmpeg binary.
 */
const PROJECT_ALLOWED_KEYS = new Set(['outputDir', 'defaultModel', 'rateLimit', 'concurrency']);

// Single source of truth: each adapter owns its default endpoint. `newapi`
// is absent ON PURPOSE — it is a self-hosted relay with no public default, so
// a missing baseUrl is a configuration error (see requireBaseUrl).
const PROVIDER_DEFAULT_BASE_URLS: Partial<Record<VideoApiStyle, string>> = {
  ark: ARK_DEFAULT_BASE_URL,
  kling: KLING_DEFAULT_BASE_URL,
  dashscope: DASHSCOPE_DEFAULT_BASE_URL,
  openrouter: OPENROUTER_DEFAULT_BASE_URL,
  minimax: MINIMAX_DEFAULT_BASE_URL,
};

/** Resolve the effective base URL, failing clearly when the style mandates one. */
function requireBaseUrl(
  style: VideoApiStyle,
  configured: string | undefined,
  settingsPath: string,
): string {
  const baseUrl = configured ?? PROVIDER_DEFAULT_BASE_URLS[style];
  if (!baseUrl) {
    throw new VideoGenError(
      `${providerLabel(style)} is a self-hosted relay with no default endpoint. Set "${settingsPath}" to your server address (e.g. "https://newapi.example.com") in global or agent-dir Pi settings, then retry.`,
      `config: ${style} requires baseUrl`,
    );
  }
  return baseUrl;
}

function settingsSection(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VideoGenError(
      `${path} must be an object in pi-video-gen settings.`,
      `config: invalid ${path}`,
    );
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, path: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new VideoGenError(
      `${path} must be a positive integer in pi-video-gen settings.`,
      `config: invalid ${path}`,
    );
  }
}

function nonNegativeInteger(value: unknown, path: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new VideoGenError(
      `${path} must be a non-negative integer in pi-video-gen settings.`,
      `config: invalid ${path}`,
    );
  }
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw new VideoGenError(
      `${path} must be a non-empty string in pi-video-gen settings.`,
      `config: invalid ${path}`,
    );
  }
}

function stringArray(value: unknown, path: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new VideoGenError(
      `${path} must be a non-empty array of strings in pi-video-gen settings.`,
      `config: invalid ${path}`,
    );
  }
}

function optionalHttpUrl(value: unknown, path: string): void {
  optionalString(value, path);
  if (value === undefined) return;
  try {
    const url = new URL(value as string);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new VideoGenError(
      `${path} must be an http(s) URL in pi-video-gen settings.`,
      `config: invalid ${path}`,
    );
  }
}

function validateCapabilities(value: unknown, path: string): void {
  if (value === undefined) return;
  const caps = settingsSection(value, path)!;
  nonNegativeInteger(caps.maxReferenceImages, `${path}.maxReferenceImages`);
  nonNegativeInteger(caps.maxReferenceVideos, `${path}.maxReferenceVideos`);
  nonNegativeInteger(caps.maxReferenceAudios, `${path}.maxReferenceAudios`);
  if (caps.durations !== undefined) {
    if (
      !Array.isArray(caps.durations) ||
      caps.durations.length !== 2 ||
      caps.durations.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item)) ||
      caps.durations[0] <= 0 ||
      caps.durations[1] < caps.durations[0]
    ) {
      throw new VideoGenError(
        `${path}.durations must be an increasing [min, max] pair of positive integers.`,
        `config: invalid ${path}.durations`,
      );
    }
  }
  if (caps.resolutions !== undefined) stringArray(caps.resolutions, `${path}.resolutions`);
  if (caps.aspectRatios !== undefined) stringArray(caps.aspectRatios, `${path}.aspectRatios`);
  if (caps.referenceAssetModalities !== undefined) {
    stringArray(caps.referenceAssetModalities, `${path}.referenceAssetModalities`);
    const valid = ['image', 'video', 'audio'];
    if ((caps.referenceAssetModalities as string[]).some((item) => !valid.includes(item))) {
      throw new VideoGenError(
        `${path}.referenceAssetModalities may contain only image, video, and audio.`,
        `config: invalid ${path}.referenceAssetModalities`,
      );
    }
  }
  for (const key of ['nativeAudio', 'supportsFirstLastFrame']) {
    if (caps[key] !== undefined && typeof caps[key] !== 'boolean') {
      throw new VideoGenError(
        `${path}.${key} must be a boolean in pi-video-gen settings.`,
        `config: invalid ${path}.${key}`,
      );
    }
  }
}

const WIRE_FORMATS = ['ark', 'kling', 'dashscope', 'openrouter', 'newapi', 'minimax'];

function validateCustomProviders(value: unknown): void {
  if (value === undefined) return;
  const cps = settingsSection(value, 'customProviders');
  for (const [name, cp] of Object.entries(cps!)) {
    const section = settingsSection(cp, `customProviders.${name}`);
    const api = section!.api;
    if (typeof api !== 'string' || !WIRE_FORMATS.includes(api)) {
      throw new VideoGenError(
        `customProviders.${name}.api must be one of ${WIRE_FORMATS.join(', ')} in pi-video-gen settings.`,
        `config: invalid customProviders.${name}.api`,
      );
    }
    if (section!.models !== undefined && !Array.isArray(section!.models)) {
      throw new VideoGenError(
        `customProviders.${name}.models must be an array in pi-video-gen settings.`,
        `config: invalid customProviders.${name}.models`,
      );
    }
    optionalHttpUrl(section!.baseUrl, `customProviders.${name}.baseUrl`);
    optionalString(section!.apiKey, `customProviders.${name}.apiKey`);
    optionalString(section!.name, `customProviders.${name}.name`);
    for (const [index, rawModel] of (section!.models as unknown[] | undefined)?.entries() ?? []) {
      const path = `customProviders.${name}.models[${index}]`;
      if (typeof rawModel === 'string') {
        optionalString(rawModel, path);
        continue;
      }
      const model = settingsSection(rawModel, path)!;
      optionalString(model.id, `${path}.id`);
      if (typeof model.id !== 'string') {
        throw new VideoGenError(
          `${path}.id must be a non-empty string.`,
          `config: invalid ${path}.id`,
        );
      }
      optionalString(model.alias, `${path}.alias`);
      optionalString(model.name, `${path}.name`);
      optionalString(model.defaultResolution, `${path}.defaultResolution`);
      optionalString(model.defaultAspectRatio, `${path}.defaultAspectRatio`);
      positiveInteger(model.defaultDurationSec, `${path}.defaultDurationSec`);
      validateCapabilities(model.capabilities, `${path}.capabilities`);
      const caps = model.capabilities as Record<string, unknown> | undefined;
      if (
        model.defaultResolution !== undefined &&
        Array.isArray(caps?.resolutions) &&
        !caps.resolutions.includes(model.defaultResolution)
      ) {
        throw new VideoGenError(
          `${path}.defaultResolution must appear in capabilities.resolutions.`,
          `config: invalid ${path}.defaultResolution`,
        );
      }
      if (
        model.defaultAspectRatio !== undefined &&
        Array.isArray(caps?.aspectRatios) &&
        !caps.aspectRatios.includes(model.defaultAspectRatio)
      ) {
        throw new VideoGenError(
          `${path}.defaultAspectRatio must appear in capabilities.aspectRatios.`,
          `config: invalid ${path}.defaultAspectRatio`,
        );
      }
      if (
        typeof model.defaultDurationSec === 'number' &&
        Array.isArray(caps?.durations) &&
        (model.defaultDurationSec < (caps.durations[0] as number) ||
          model.defaultDurationSec > (caps.durations[1] as number))
      ) {
        throw new VideoGenError(
          `${path}.defaultDurationSec must be within capabilities.durations.`,
          `config: invalid ${path}.defaultDurationSec`,
        );
      }
    }
  }
}

function validateRuntimeSettings(settings: VideoGenSettings): VideoGenSettings {
  settingsSection(settings, 'pi-video-gen');
  optionalString(settings.defaultModel, 'defaultModel');
  optionalString(settings.outputDir, 'outputDir');
  optionalString(settings.ffmpegPath, 'ffmpegPath');
  const providers = settingsSection(settings.providers, 'providers');
  for (const style of WIRE_FORMATS) {
    const provider = settingsSection(providers?.[style], `providers.${style}`);
    optionalString(provider?.apiKey, `providers.${style}.apiKey`);
    optionalHttpUrl(provider?.baseUrl, `providers.${style}.baseUrl`);
  }
  const rateLimit = settingsSection(settings.rateLimit, 'rateLimit');
  const concurrency = settingsSection(settings.concurrency, 'concurrency');
  positiveInteger(rateLimit?.maxRequestsPerMinute, 'rateLimit.maxRequestsPerMinute');
  positiveInteger(rateLimit?.maxRequestsPerDay, 'rateLimit.maxRequestsPerDay');
  positiveInteger(concurrency?.clips, 'concurrency.clips');
  validateCustomProviders(settings.customProviders);
  return settings;
}

/**
 * Load `pi-video-gen` settings with the trust boundary applied:
 * - untrusted project ⇒ the project layer is ignored entirely;
 * - trusted project ⇒ only PROJECT_ALLOWED_KEYS are honored from the project
 *   layer; sensitive keys there are stripped (and reported once to stderr).
 */
export function loadVideoGenSettings(cwd: string, projectTrusted: boolean): VideoGenSettings {
  const base = loadPiSettings<VideoGenSettings>(SETTINGS_KEY, {
    cwd,
    projectTrusted: false,
  });
  if (!projectTrusted) return validateRuntimeSettings(base);

  const merged = loadPiSettings<VideoGenSettings>(SETTINGS_KEY, {
    cwd,
    projectTrusted: true,
    strictProjectSettings: true,
  });
  const allowed: Record<string, unknown> = {};
  for (const key of PROJECT_ALLOWED_KEYS) {
    if (merged[key as keyof VideoGenSettings] !== base[key as keyof VideoGenSettings]) {
      allowed[key] = merged[key as keyof VideoGenSettings];
    }
  }
  return validateRuntimeSettings({ ...base, ...allowed } as VideoGenSettings);
}

/** Resolve the provider section for a wire format against built-in defaults. */
export function resolveProvider(
  settings: VideoGenSettings,
  style: VideoApiStyle,
): ResolvedProvider {
  const section = settings.providers?.[style] ?? {};
  return {
    style,
    apiKey: section.apiKey,
    apiKeyPath: `pi-video-gen.providers.${style}.apiKey`,
    baseUrl: requireBaseUrl(style, section.baseUrl, `pi-video-gen.providers.${style}.baseUrl`),
  };
}

/**
 * Conservative capabilities for custom models declared as a bare string (or
 * with a partial capabilities object) whose id matches NO built-in registry
 * entry: text-to-video + first frame only, no audio, no last-frame
 * interpolation, 720p/16:9. Declare full capabilities in the custom model
 * object to lift these. When the id DOES name a built-in model (e.g.
 * "MiniMax-H3" behind a relay), the built-in capability table is the base
 * instead — the remote contract is known, so resolution/duration/ratio
 * defaults come from the registry.
 */
const CONSERVATIVE_CUSTOM_CAPABILITIES: VideoModelCapabilities = {
  maxReferenceImages: 1,
  durations: [4, 15],
  resolutions: ['720p'],
  aspectRatios: ['16:9'],
  nativeAudio: false,
  supportsFirstLastFrame: false,
};

/**
 * Default-value inheritance for custom models: an explicit settings value
 * wins; then the built-in registry default (only while it stays valid against
 * the merged capabilities); finally the caller-supplied fallback.
 */
function inheritDefault<T>(
  explicit: T | undefined,
  builtIn: T | undefined,
  isValid: (value: T) => boolean,
  fallback: T,
): T {
  return explicit ?? (builtIn !== undefined && isValid(builtIn) ? builtIn : fallback);
}

function resolveCustomModel(settings: VideoGenSettings, wanted: string): ResolvedModel | null {
  const needle = wanted.trim().toLowerCase();
  for (const [providerName, cp] of Object.entries(settings.customProviders ?? {})) {
    for (const m of cp.models ?? []) {
      const model: CustomVideoModel = typeof m === 'string' ? { id: m } : m;
      const matches =
        model.id.toLowerCase() === needle ||
        (model.alias != null && model.alias.toLowerCase() === needle);
      if (!matches) continue;
      const builtIn = findBuiltInModel(model.id);
      const capabilities = {
        ...(builtIn?.capabilities ?? CONSERVATIVE_CUSTOM_CAPABILITIES),
        ...(model.capabilities ?? {}),
      };
      const defaultResolution = inheritDefault(
        model.defaultResolution,
        builtIn?.defaultResolution,
        (v) => capabilities.resolutions.includes(v),
        capabilities.resolutions[0]!,
      );
      const defaultAspectRatio = inheritDefault(
        model.defaultAspectRatio,
        builtIn?.defaultAspectRatio,
        (v) => capabilities.aspectRatios.includes(v),
        capabilities.aspectRatios[0]!,
      );
      const defaultDurationSec = inheritDefault(
        model.defaultDurationSec,
        builtIn?.defaultDurationSec,
        (v) => v >= capabilities.durations[0] && v <= capabilities.durations[1],
        capabilities.durations[0],
      );
      return {
        entry: {
          id: model.id,
          aliases: model.alias ? [model.alias] : [],
          provider: cp.api,
          capabilities,
          defaultResolution,
          defaultAspectRatio,
          defaultDurationSec,
        },
        remoteId: model.id,
        provider: {
          style: cp.api,
          apiKey: cp.apiKey,
          apiKeyPath: `pi-video-gen.customProviders.${providerName}.apiKey`,
          baseUrl: requireBaseUrl(
            cp.api,
            cp.baseUrl,
            `pi-video-gen.customProviders.${providerName}.baseUrl`,
          ),
        },
      };
    }
  }
  return null;
}

/**
 * Resolve a model id/alias (defaulting to settings.defaultModel, then
 * DEFAULT_VIDEO_MODEL_ID). Built-in registry wins over custom provider
 * models on conflict.
 */
export function resolveModel(settings: VideoGenSettings, modelId?: string): ResolvedModel | null {
  const wanted = modelId ?? settings.defaultModel ?? DEFAULT_VIDEO_MODEL_ID;
  const entry = findBuiltInModel(wanted);
  if (entry) {
    return {
      entry,
      remoteId: entry.remoteId ?? entry.id,
      provider: resolveProvider(settings, entry.provider),
    };
  }
  return resolveCustomModel(settings, wanted);
}

/** Registry view for the video_capabilities tool / `/video-gen models`. */
export function listModelRegistry(settings: VideoGenSettings): {
  activeId: string;
  activeResolved: boolean;
  models: { id: string; aliases: string[]; provider: string; keyReady: boolean }[];
} {
  const wanted = settings.defaultModel ?? DEFAULT_VIDEO_MODEL_ID;
  const active = resolveModel(settings, wanted);
  return {
    activeId: active?.entry.id ?? wanted,
    activeResolved: active != null,
    models: [
      ...BUILT_IN_VIDEO_MODELS.map((m) => ({
        id: m.id,
        aliases: m.aliases,
        provider: m.provider as string,
        keyReady: resolveProvider(settings, m.provider).apiKey != null,
      })),
      ...Object.entries(settings.customProviders ?? {}).flatMap(([providerName, cp]) =>
        (cp.models ?? []).map((m) => {
          const model: CustomVideoModel = typeof m === 'string' ? { id: m } : m;
          return {
            id: model.id,
            aliases: model.alias ? [model.alias] : [],
            provider: `${providerName}(${cp.api})`,
            keyReady: cp.apiKey != null,
          };
        }),
      ),
    ],
  };
}

/** Job root directory (absolute). */
export function resolveOutputDir(settings: VideoGenSettings, cwd: string): string {
  return resolve(cwd, settings.outputDir ?? '.video-gen');
}
