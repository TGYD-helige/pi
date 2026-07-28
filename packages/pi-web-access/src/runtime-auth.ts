import {
  mergeRuntimeAuthHeaders,
  type RuntimeAuthRegistry,
  resolveRuntimeProviderAuth,
} from '@amaster.ai/pi-shared/runtime-auth';
import { resolveProvider, SEARCH_PROVIDER_IDS } from './config.js';
import type { ResolvedProvider } from './providers/index.js';
import type { BuiltInProviderId, WebToolSettings } from './types.js';

type ProviderResolution = ResolvedProvider | { error: string };

export async function resolveProviderForSession(
  name: BuiltInProviderId,
  settings: WebToolSettings,
  registry: RuntimeAuthRegistry,
): Promise<ProviderResolution> {
  const resolved = resolveProvider(name, settings);
  if ('error' in resolved) return resolved;

  const runtimeProvider = settings.providers?.[name]?.runtimeAuthProvider?.trim();
  if (!runtimeProvider) return resolved;

  const runtimeAuth = await resolveRuntimeProviderAuth(runtimeProvider, registry);
  if (!runtimeAuth.ok) return { error: runtimeAuth.error };

  const headers = mergeRuntimeAuthHeaders(resolved.headers, runtimeAuth.headers);
  const { headers: _staticHeaders, ...provider } = resolved;
  return {
    ...provider,
    apiKey: runtimeAuth.apiKey,
    baseUrl: runtimeAuth.baseUrl,
    ...(headers ? { headers } : {}),
  };
}

export async function resolveSearchProviderForSession(
  settings: WebToolSettings,
  registry: RuntimeAuthRegistry,
): Promise<ProviderResolution> {
  if (settings.search?.provider) {
    return resolveProviderForSession(settings.search.provider, settings, registry);
  }

  for (const provider of SEARCH_PROVIDER_IDS) {
    const resolved = await resolveProviderForSession(provider, settings, registry);
    if (!('error' in resolved) && resolved.apiKey) return resolved;
  }
  return {
    error:
      'No search provider configured. Set search.provider or configure a provider with an API key.',
  };
}

export async function resolveFetchProviderForSession(
  settings: WebToolSettings,
  registry: RuntimeAuthRegistry,
): Promise<ProviderResolution | null> {
  const provider = settings.fetch?.provider;
  if (!provider) return null;
  return resolveProviderForSession(provider, settings, registry);
}
