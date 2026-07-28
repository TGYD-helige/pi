import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type { ResolvedProvider } from './providers/index.js';
import type { BuiltInProviderId, WebToolSettings } from './types.js';

const SETTINGS_KEY = 'pi-web-access';

// ─── Built-in defaults ───────────────────────────────────────────────────────

const DEFAULT_BASE_URL: Record<BuiltInProviderId, string> = {
  tavily: 'https://api.tavily.com',
  brave: 'https://api.search.brave.com',
  firecrawl: 'https://api.firecrawl.dev',
  kimi: 'https://api.moonshot.cn/v1',
  mimo: 'https://api.xiaomimimo.com/v1',
  zai: 'https://api.z.ai',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  perplexity: 'https://api.perplexity.ai',
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

const ENV_VARS: Record<BuiltInProviderId, string> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  mimo: 'MIMO_API_KEY',
  zai: 'ZAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const DEFAULT_MODEL: Partial<Record<BuiltInProviderId, string>> = {
  kimi: 'kimi-k2.6',
  mimo: 'mimo-v2.5-pro',
  gemini: 'gemini-2.5-flash',
  perplexity: 'openai/gpt-5.5',
  xai: 'grok-4.3',
  openai: 'gpt-5.5',
  anthropic: 'claude-sonnet-4-6',
};

// ─── Settings loading ────────────────────────────────────────────────────────

export function loadWebToolSettings(cwd: string, projectTrusted = false): WebToolSettings {
  try {
    return loadPiSettings<WebToolSettings>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
      expandBareEnvVars: true,
    });
  } catch {
    return {};
  }
}

// ─── Provider resolution ─────────────────────────────────────────────────────

const PROVIDER_IDS = new Set<string>(Object.keys(DEFAULT_BASE_URL));

function isBuiltInProviderId(value: string): value is BuiltInProviderId {
  return PROVIDER_IDS.has(value);
}

export function resolveProvider(
  name: string,
  settings: WebToolSettings,
): ResolvedProvider | { error: string } {
  const requested = name.trim();
  if (!requested) return { error: 'Provider name is empty.' };

  if (!isBuiltInProviderId(requested)) {
    return { error: `Unknown provider "${requested}". Available: ${[...PROVIDER_IDS].join(', ')}` };
  }

  const config = settings.providers?.[requested] ?? {};
  const apiKey = config.apiKey || process.env[ENV_VARS[requested]];
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL[requested];

  const provider: ResolvedProvider = {
    id: requested,
    baseUrl,
  };
  if (apiKey) provider.apiKey = apiKey;
  if (config.headers) provider.headers = config.headers;
  const model = config.model ?? DEFAULT_MODEL[requested];
  if (model) provider.model = model;
  if (settings.timeoutMs) provider.timeoutMs = settings.timeoutMs;
  return provider;
}

export const SEARCH_PROVIDER_IDS: BuiltInProviderId[] = [
  'tavily',
  'brave',
  'firecrawl',
  'kimi',
  'mimo',
  'zai',
  'gemini',
  'perplexity',
];

/**
 * Resolve the search provider from settings.
 * Uses search.provider if set, otherwise picks the first provider with an API key.
 */
export function resolveSearchProvider(
  settings: WebToolSettings,
): ResolvedProvider | { error: string } {
  if (settings.search?.provider) {
    return resolveProvider(settings.search.provider, settings);
  }
  for (const id of SEARCH_PROVIDER_IDS) {
    const resolved = resolveProvider(id, settings);
    if (!('error' in resolved) && resolved.apiKey) return resolved;
  }
  return {
    error:
      'No search provider configured. Set search.provider or configure a provider with an API key.',
  };
}

/**
 * Resolve the fetch provider from settings.
 * Uses fetch.provider if set, otherwise falls back to local.
 */
export function resolveFetchProvider(settings: WebToolSettings): ResolvedProvider | null {
  if (!settings.fetch?.provider) return null;
  const resolved = resolveProvider(settings.fetch.provider, settings);
  if ('error' in resolved || !resolved.apiKey) return null;
  return resolved;
}
