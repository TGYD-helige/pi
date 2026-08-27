import { resolveSearchProvider } from './config.js';
import type { SearchParams, SearchResponse } from './providers/index.js';
import { getProvider } from './providers/index.js';
import type { WebToolSettings } from './types.js';

export async function search(
  params: SearchParams,
  settings: WebToolSettings,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const resolved = resolveSearchProvider(settings);
  if ('error' in resolved) {
    throw new Error(resolved.error);
  }

  const provider = getProvider(resolved.id);
  if (!provider) {
    throw new Error(`Provider "${resolved.id}" is not registered.`);
  }

  return provider.search(params, resolved, signal);
}
