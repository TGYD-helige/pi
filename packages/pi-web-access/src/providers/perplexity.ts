import type {
  FetchResponse,
  ResolvedProvider,
  SearchParams,
  SearchResponse,
  SearchResult,
} from './base.js';
import {
  BaseProvider,
  getEnvironmentContext,
  SEARCH_SYSTEM_PROMPT,
  timeoutSignal,
} from './base.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export class PerplexityProvider extends BaseProvider {
  readonly id = 'perplexity' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Perplexity API key not configured. Set PERPLEXITY_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/agent`;
    const tool: Record<string, unknown> = { type: 'web_search', search_context_size: 'high' };
    const filters: Record<string, unknown> = {};
    if (params.includeDomains?.length) filters.search_domain_filter = params.includeDomains;
    if (params.excludeDomains?.length)
      filters.search_domain_filter = params.excludeDomains.map((d) => `-${d}`);
    if (params.timeRange) filters.search_recency_filter = params.timeRange;
    if (Object.keys(filters).length > 0) tool.filters = filters;

    const body = {
      model: provider.model ?? 'openai/gpt-5.5',
      instructions: SEARCH_SYSTEM_PROMPT,
      input: `${getEnvironmentContext()}\n\n${params.query}`,
      tools: [tool],
    };
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
      throw new Error(`Perplexity API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      output: Array<{
        type: string;
        results?: Array<{ title: string; url: string; snippet: string }>;
        content?: Array<{ type: string; text: string }>;
      }>;
    };

    let answer: string | undefined;
    const results: SearchResult[] = [];
    for (const item of data.output) {
      if (item.type === 'search_results' && item.results) {
        for (const r of item.results)
          results.push({ title: r.title, url: r.url, content: r.snippet });
      }
      if (item.type === 'message' && item.content) {
        answer = item.content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('');
      }
    }

    return { provider: provider.id, query: params.query, answer, results };
  }

  override async fetch(targetUrl: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Perplexity API key not configured. Set PERPLEXITY_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/agent`;
    const body = {
      model: provider.model ?? 'openai/gpt-5.5',
      input: `Fetch and summarize the content of this URL: ${targetUrl}`,
      tools: [{ type: 'fetch_url' }],
      instructions: 'Fetch the URL and return its full content.',
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Perplexity API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      output: Array<{
        type: string;
        contents?: Array<{ url: string; title: string; snippet: string }>;
        content?: Array<{ type: string; text: string }>;
      }>;
    };

    let content = '';
    let title = targetUrl;
    for (const item of data.output) {
      if (item.type === 'fetch_url_results' && item.contents?.length) {
        title = item.contents[0]!.title || targetUrl;
        content = item.contents[0]!.snippet;
      }
      if (item.type === 'message' && item.content) {
        const text = item.content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('');
        if (text) content = text;
      }
    }

    return { url: targetUrl, title, content };
  }
}
