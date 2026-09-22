import type {
  FetchResponse,
  ResolvedProvider,
  SearchParams,
  SearchResponse,
  SearchResult,
} from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class TavilyProvider extends BaseProvider {
  readonly id = 'tavily' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Tavily API key not configured. Set TAVILY_API_KEY env var or configure in settings.json.',
      );
    }

    const body: Record<string, unknown> = {
      query: params.query,
      max_results: params.maxResults ?? 5,
      include_answer: true,
    };
    if (params.topic) body.topic = params.topic;
    if (params.timeRange) body.time_range = params.timeRange;
    if (params.includeDomains?.length) body.include_domains = params.includeDomains;
    if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains;

    const url = `${provider.baseUrl.replace(/\/$/, '')}/search`;
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
      throw new Error(`Tavily API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      query: string;
      answer?: string;
      results: Array<{ title: string; url: string; content: string; score: number }>;
    };

    const results: SearchResult[] = data.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    }));

    return { provider: provider.id, query: data.query, answer: data.answer, results };
  }

  override async fetch(url: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Tavily API key not configured. Set TAVILY_API_KEY env var or configure in settings.json.',
      );
    }

    const endpoint = `${provider.baseUrl.replace(/\/$/, '')}/extract`;
    const body = { urls: [url], format: 'markdown' };
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
      throw new Error(`Tavily Extract API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      results: Array<{ url: string; raw_content: string }>;
      failed_results: Array<{ url: string; error: string }>;
    };

    if (data.failed_results.length > 0) {
      const err = data.failed_results[0]!;
      throw new Error(`Tavily failed to extract ${err.url}: ${err.error}`);
    }

    const result = data.results[0];
    if (!result) throw new Error('Tavily Extract returned no results');

    return { url: result.url, title: url, content: result.raw_content };
  }
}
