import type {
  FetchResponse,
  ResolvedProvider,
  SearchParams,
  SearchResponse,
  SearchResult,
} from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class YouProvider extends BaseProvider {
  readonly id = 'you' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'You.com API key not configured. Set YDC_API_KEY env var or configure in settings.json.',
      );
    }

    const body: Record<string, unknown> = {
      query: params.query,
      count: params.maxResults ?? 5,
    };
    if (params.topic === 'news') body.freshness = 'week';
    else if (params.timeRange) body.freshness = params.timeRange;
    if (params.includeDomains?.length) body.include_domains = params.includeDomains;
    if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains;

    const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/search`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': provider.apiKey,
      ...provider.headers,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeoutSignal(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`You.com API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      results?: {
        web?: Array<{ url: string; title: string; description?: string; snippets?: string[] }>;
        news?: Array<{ url: string; title: string; description?: string; snippets?: string[] }>;
      };
    };

    const hits = data.results?.web ?? [];
    const news = params.topic === 'news' ? (data.results?.news ?? []) : [];
    const results: SearchResult[] = [...news, ...hits].map((r) => ({
      title: r.title,
      url: r.url,
      content: r.snippets?.join('\n') || r.description || '',
    }));

    return { provider: provider.id, query: params.query, results };
  }

  override async fetch(url: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'You.com API key not configured. Set YDC_API_KEY env var or configure in settings.json.',
      );
    }

    const endpoint = `${provider.baseUrl.replace(/\/$/, '')}/v1/contents`;
    const body = { urls: [url], formats: ['markdown'] };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': provider.apiKey,
      ...provider.headers,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`You.com Contents API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as Array<{
      url: string;
      title?: string;
      markdown?: string | null;
    }>;

    const result = data[0];
    if (!result || result.markdown == null) {
      throw new Error(`You.com failed to extract ${url}`);
    }

    return { url: result.url, title: result.title ?? url, content: result.markdown };
  }
}
