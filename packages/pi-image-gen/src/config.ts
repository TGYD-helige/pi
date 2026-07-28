import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import {
  BUILT_IN_MODELS,
  DEFAULT_API_STYLE,
  DEFAULT_BASE_URL,
  ENV_VARS,
  PROVIDER_DISPLAY_NAME,
} from './models.js';
import type {
  BuiltInProviderId,
  CustomImageModel,
  CustomImageProvider,
  ImageGenSettings,
  ResolvedModel,
  ResolvedProvider,
} from './types.js';

const SETTINGS_KEY = 'pi-image-gen';

export function loadImageGenSettings(cwd: string, projectTrusted = false): ImageGenSettings {
  try {
    return loadPiSettings<ImageGenSettings>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
      expandBareEnvVars: true,
    });
  } catch {
    return {};
  }
}

function buildBuiltInProvider(
  id: BuiltInProviderId,
  settings: ImageGenSettings,
): ResolvedProvider | null {
  const override = settings.providers?.[id] ?? {};
  const apiKey = override.runtimeAuthProvider
    ? override.apiKey
    : override.apiKey || process.env[ENV_VARS[id]];
  const provider: ResolvedProvider = {
    id,
    api: DEFAULT_API_STYLE[id],
    baseUrl: override.baseUrl || DEFAULT_BASE_URL[id],
    name: PROVIDER_DISPLAY_NAME[id],
    builtIn: true,
  };
  if (apiKey) provider.apiKey = apiKey;
  if (override.headers) provider.headers = override.headers;
  return provider;
}

function buildCustomProvider(name: string, raw: CustomImageProvider): ResolvedProvider | null {
  const api = raw.api;
  if (!api) return null;
  const baseUrl = raw.baseUrl || DEFAULT_BASE_URL[api as BuiltInProviderId];
  if (!baseUrl) return null;
  const provider: ResolvedProvider = {
    id: name,
    api,
    baseUrl,
    name: raw.name ?? name,
    builtIn: false,
  };
  const apiKey = raw.apiKey;
  if (apiKey) provider.apiKey = apiKey;
  if (raw.headers) provider.headers = raw.headers;
  return provider;
}

function customModels(raw: CustomImageProvider): Array<{ id: string; alias: string }> {
  const list = raw.models ?? [];
  return list.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry, alias: entry }];
    const m = entry as CustomImageModel;
    if (!m.id) return [];
    return [{ id: m.id, alias: m.alias ?? m.id }];
  });
}

/**
 * Resolve a model id (or alias) to a (provider, remoteModelId) pair using:
 *   1. Custom providers' explicit model lists (alias or id match).
 *   2. Built-in known models (alias or id match).
 *   3. `<provider>/<remote-id>` fallback for explicit routing.
 *   4. Catch-all: any custom provider that didn't declare a `models` list
 *      will accept any unknown model id, passing it through as the remote id.
 *      This lets users configure a single OpenAI-compatible gateway and use
 *      any model name without restating it in `models`.
 */
export function resolveModel(
  modelOrAlias: string,
  settings: ImageGenSettings,
): ResolvedModel | { error: string } {
  const requested = modelOrAlias.trim();
  if (!requested) return { error: 'Model id is empty.' };

  for (const [name, raw] of Object.entries(settings.customProviders ?? {})) {
    const provider = buildCustomProvider(name, raw);
    if (!provider) continue;
    for (const model of customModels(raw)) {
      if (model.alias === requested || model.id === requested) {
        return { provider, remoteId: model.id, requestedId: requested };
      }
    }
  }

  const builtIn = BUILT_IN_MODELS.find(
    (entry) => entry.id === requested || entry.aliases?.includes(requested),
  );
  if (builtIn) {
    const provider = buildBuiltInProvider(builtIn.provider, settings);
    if (provider?.apiKey) {
      return { provider, remoteId: builtIn.remoteId ?? builtIn.id, requestedId: requested };
    }
    // Built-in match without a configured API key — fall through so a
    // catch-all customProvider can still pick this up.
  }

  const slash = requested.indexOf('/');
  if (slash > 0) {
    const providerKey = requested.slice(0, slash);
    const remoteId = requested.slice(slash + 1);
    if (isBuiltInProviderId(providerKey)) {
      const provider = buildBuiltInProvider(providerKey, settings);
      if (provider) return { provider, remoteId, requestedId: requested };
    }
    const customRaw = settings.customProviders?.[providerKey];
    if (customRaw) {
      const provider = buildCustomProvider(providerKey, customRaw);
      if (provider) return { provider, remoteId, requestedId: requested };
    }
  }

  for (const [name, raw] of Object.entries(settings.customProviders ?? {})) {
    if (raw.models && raw.models.length > 0) continue;
    const provider = buildCustomProvider(name, raw);
    if (provider) return { provider, remoteId: requested, requestedId: requested };
  }

  return { error: unknownModelError(requested, settings) };
}

function unknownModelError(requested: string, settings: ImageGenSettings): string {
  const customNames = Object.keys(settings.customProviders ?? {});
  const lines = [`Unknown image model "${requested}".`];

  if (customNames.length > 0) {
    const explicit = customNames.filter((n) => {
      const m = settings.customProviders?.[n]?.models;
      return m && m.length > 0;
    });
    if (explicit.length > 0) {
      lines.push(
        `Configured customProviders with explicit model lists: ${explicit.join(', ')}. The requested id didn't match any of their entries.`,
      );
    }
    lines.push(
      `To accept any model id without listing it, omit the "models" field on a customProvider — that provider then becomes a catch-all.`,
    );
  }

  const builtInIds = listKnownModelIds();
  lines.push(
    `Built-in model ids: ${builtInIds.slice(0, 10).join(', ')}${builtInIds.length > 10 ? ', ...' : ''}.`,
  );
  return lines.join(' ');
}

export function listKnownModelIds(): string[] {
  return BUILT_IN_MODELS.flatMap((m) => [m.id, ...(m.aliases ?? [])]);
}

export type ConfiguredProvider = ResolvedProvider & {
  /** True for customProviders without an explicit `models` list — accepts any unknown id. */
  catchAll: boolean;
  /** Number of model entries explicitly declared. */
  modelCount: number;
};

export function listConfiguredProviders(settings: ImageGenSettings): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  for (const id of ['openai', 'gemini', 'dashscope', 'openrouter', 'ark'] as BuiltInProviderId[]) {
    const provider = buildBuiltInProvider(id, settings);
    if (provider?.apiKey) out.push({ ...provider, catchAll: false, modelCount: 0 });
  }
  for (const [name, raw] of Object.entries(settings.customProviders ?? {})) {
    const provider = buildCustomProvider(name, raw);
    if (provider) {
      const modelCount = raw.models?.length ?? 0;
      out.push({ ...provider, catchAll: modelCount === 0, modelCount });
    }
  }
  return out;
}

function isBuiltInProviderId(value: string): value is BuiltInProviderId {
  return (
    value === 'openai' ||
    value === 'gemini' ||
    value === 'dashscope' ||
    value === 'openrouter' ||
    value === 'ark'
  );
}
