import {
  mergeRuntimeAuthHeaders,
  type RuntimeAuthRegistry,
  resolveRuntimeProviderAuth,
} from '@amaster.ai/pi-shared/runtime-auth';
import type {
  BuiltInProviderId,
  BuiltInProviderOverride,
  CustomImageProvider,
  ImageGenSettings,
} from './types.js';

type RuntimeProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  runtimeAuthProvider?: string;
};

async function materializeProvider<T extends RuntimeProviderConfig>(
  config: T,
  registry: RuntimeAuthRegistry,
): Promise<T> {
  const runtimeProvider = config.runtimeAuthProvider?.trim();
  if (!runtimeProvider) return { ...config };

  const headers = mergeRuntimeAuthHeaders(config.headers);
  const {
    apiKey: _staticApiKey,
    baseUrl: _staticBaseUrl,
    headers: _staticHeaders,
    ...provider
  } = config;
  const materialized = {
    ...provider,
    ...(headers ? { headers } : {}),
  } as T;
  const runtimeAuth = await resolveRuntimeProviderAuth(runtimeProvider, registry);
  if (!runtimeAuth.ok) return materialized;

  const runtimeHeaders = mergeRuntimeAuthHeaders(headers, runtimeAuth.headers);
  return {
    ...materialized,
    apiKey: runtimeAuth.apiKey,
    baseUrl: runtimeAuth.baseUrl,
    ...(runtimeHeaders ? { headers: runtimeHeaders } : {}),
  };
}

export async function materializeImageGenSettings(
  settings: ImageGenSettings,
  registry: RuntimeAuthRegistry,
): Promise<ImageGenSettings> {
  const providers: Partial<Record<BuiltInProviderId, BuiltInProviderOverride>> = {};
  for (const [name, config] of Object.entries(settings.providers ?? {})) {
    providers[name as BuiltInProviderId] = await materializeProvider(config, registry);
  }

  const customProviders: Record<string, CustomImageProvider> = {};
  for (const [name, config] of Object.entries(settings.customProviders ?? {})) {
    customProviders[name] = await materializeProvider(config, registry);
  }

  return {
    ...settings,
    ...(settings.providers ? { providers } : {}),
    ...(settings.customProviders ? { customProviders } : {}),
  };
}
