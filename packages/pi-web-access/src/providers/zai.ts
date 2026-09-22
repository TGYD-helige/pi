import type {
  FetchResponse,
  ResolvedProvider,
  SearchParams,
  SearchResponse,
  SearchResult,
} from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const TIME_RANGE_MAP: Record<string, string> = {
  day: 'oneDay',
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
};

export class ZaiProvider extends BaseProvider {
  readonly id = 'zai' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Z.AI API key not configured. Set ZAI_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/api/paas/v4/web_search`;
    const body: Record<string, unknown> = {
      search_engine: 'search-prime',
      search_query: params.query,
    };
    if (params.maxResults) body.count = params.maxResults;
    if (params.timeRange)
      body.search_recency_filter = TIME_RANGE_MAP[params.timeRange] ?? 'noLimit';
    if (params.includeDomains?.length) body.search_domain_filter = params.includeDomains[0];

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
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
      throw new Error(`Z.AI API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      search_result: Array<{ title: string; content: string; link: string }>;
    };
    const results: SearchResult[] = (data.search_result ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      content: r.content,
    }));

    return { provider: provider.id, query: params.query, results };
  }

  override async fetch(targetUrl: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Z.AI API key not configured. Set ZAI_API_KEY env var or configure in settings.json.',
      );
    }

    const endpoint = `${provider.baseUrl.replace(/\/$/, '')}/api/paas/v4/reader`;
    const body = { url: targetUrl, return_format: 'markdown', retain_images: false };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
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
      throw new Error(`Z.AI Reader API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      reader_result: { content: string; title: string; url: string };
    };
    return {
      url: data.reader_result.url,
      title: data.reader_result.title,
      content: data.reader_result.content,
    };
  }
}
