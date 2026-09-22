import type { ResolvedProvider, SearchParams, SearchResponse, SearchResult } from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class BraveProvider extends BaseProvider {
  readonly id = 'brave' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Brave Search API key not configured. Set BRAVE_API_KEY env var or configure in settings.json.',
      );
    }

    const searchParams = new URLSearchParams();
    searchParams.set('q', params.query);
    searchParams.set('count', String(params.maxResults ?? 5));

    if (params.topic === 'news') {
      searchParams.set('result_filter', 'news');
    }

    if (params.timeRange) {
      const freshnessMap: Record<string, string> = {
        day: 'pd',
        week: 'pw',
        month: 'pm',
        year: 'py',
      };
      searchParams.set('freshness', freshnessMap[params.timeRange]!);
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/res/v1/web/search?${searchParams.toString()}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': provider.apiKey,
      ...provider.headers,
    };

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: timeoutSignal(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brave Search API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      query?: { original?: string };
      web?: {
        results?: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
        }>;
      };
      news?: {
        results?: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
        }>;
      };
    };

    const rawResults =
      params.topic === 'news' ? (data.news?.results ?? []) : (data.web?.results ?? []);

    const results: SearchResult[] = rawResults.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.description,
    }));

    return {
      provider: provider.id,
      query: data.query?.original ?? params.query,
      results,
    };
  }
}
