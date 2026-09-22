import type {
  FetchResponse,
  ResolvedProvider,
  SearchParams,
  SearchResponse,
  SearchResult,
} from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

const DEFAULT_TIMEOUT_MS = 60_000;

// Map SearchParams.timeRange → Firecrawl `tbs` (query-date-range) value.
const TBS_MAP: Record<string, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

interface FirecrawlWebResult {
  url: string;
  title?: string;
  description?: string;
  position?: number;
}

/**
 * Firecrawl provider — https://docs.firecrawl.dev
 *
 * - search: POST /v2/search (grouped-by-source response, we use `web`)
 * - fetch:  POST /v2/scrape (markdown format, clean LLM-ready content)
 */
export class FirecrawlProvider extends BaseProvider {
  readonly id = 'firecrawl' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Firecrawl API key not configured. Set FIRECRAWL_API_KEY env var or configure in settings.json.',
      );
    }

    const body: Record<string, unknown> = {
      query: params.query,
      limit: params.maxResults ?? 5,
      sources: [params.topic === 'news' ? 'news' : 'web'],
    };
    if (params.timeRange) body.tbs = TBS_MAP[params.timeRange];
    if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
    if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;

    const url = `${provider.baseUrl.replace(/\/$/, '')}/v2/search`;
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
      throw new Error(`Firecrawl Search API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      success?: boolean;
      error?: string;
      data?: {
        web?: FirecrawlWebResult[];
        news?: Array<{ url: string; title?: string; snippet?: string }>;
      };
    };

    if (data.success === false) {
      throw new Error(`Firecrawl Search failed: ${data.error ?? 'unknown error'}`);
    }

    let results: SearchResult[];
    if (params.topic === 'news') {
      results = (data.data?.news ?? []).map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        content: r.snippet ?? '',
      }));
    } else {
      results = (data.data?.web ?? []).map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        content: r.description ?? '',
      }));
    }

    return { provider: provider.id, query: params.query, results };
  }

  override async fetch(url: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Firecrawl API key not configured. Set FIRECRAWL_API_KEY env var or configure in settings.json.',
      );
    }

    const endpoint = `${provider.baseUrl.replace(/\/$/, '')}/v2/scrape`;
    const body = { url, formats: ['markdown'], onlyMainContent: true };
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
      throw new Error(`Firecrawl Scrape API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      success?: boolean;
      error?: string;
      data?: {
        markdown?: string;
        metadata?: { title?: string; sourceURL?: string };
      };
    };

    if (data.success === false || !data.data) {
      throw new Error(`Firecrawl Scrape failed: ${data.error ?? 'no content returned'}`);
    }

    const title = data.data.metadata?.title ?? url;
    const sourceUrl = data.data.metadata?.sourceURL ?? url;
    return { url: sourceUrl, title, content: data.data.markdown ?? '' };
  }
}
