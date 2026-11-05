import { ValidationError } from '@amaster.ai/pi-shared';
import type { ImageSearchParams, ResolvedProvider, SearchResponse, SearchResult } from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PER_PAGE = 10;

interface UnsplashPhoto {
  alt_description?: string | null;
  description?: string | null;
  urls?: { regular?: string };
  links?: { html?: string };
  user?: { name?: string };
}

export class UnsplashProvider extends BaseProvider {
  readonly id = 'unsplash' as const;

  override async imageSearch(
    params: ImageSearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new ValidationError(
        'Unsplash API key not configured. Set UNSPLASH_ACCESS_KEY or configure settings.json.',
        'configuration_error',
      );
    }

    const url = new URL(`${provider.baseUrl.replace(/\/$/, '')}/search/photos`);
    url.searchParams.set('query', params.query);
    url.searchParams.set('per_page', String(PER_PAGE));

    const response = await fetch(url, {
      headers: {
        Authorization: `Client-ID ${provider.apiKey}`,
        ...provider.headers,
      },
      signal: timeoutSignal(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Unsplash API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as { results?: UnsplashPhoto[] };
    const results: SearchResult[] = [];
    for (const photo of data.results ?? []) {
      const imageUrl = photo.urls?.regular;
      if (!imageUrl) continue;
      const attribution = [
        photo.user?.name ? `Photo by ${photo.user.name} on Unsplash` : null,
        photo.links?.html ?? null,
      ]
        .filter(Boolean)
        .join(' — ');
      results.push({
        title: photo.alt_description ?? photo.description ?? 'Unsplash photo',
        url: imageUrl,
        content: attribution,
      });
    }

    return { provider: provider.id, query: params.query, results };
  }
}
