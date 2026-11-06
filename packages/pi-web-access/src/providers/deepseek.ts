import { SafeToolError, ValidationError } from '@amaster.ai/pi-shared';
import type { FetchResponse, ResolvedProvider, SearchParams, SearchResponse } from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

export class DeepSeekProvider extends BaseProvider {
  readonly id = 'deepseek' as const;

  private async post<T>(
    endpoint: 'search' | 'fetch',
    body: unknown,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!provider.apiKey) {
      throw new ValidationError(
        'DeepSeek API key not configured. Set DEEPSEEK_API_KEY or configure settings.json.',
        'configuration_error',
      );
    }
    const requestSignal = timeoutSignal(provider.timeoutMs ?? 30_000, signal);
    try {
      const response = await fetch(
        `${provider.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/tools/${endpoint}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
            ...provider.headers,
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        },
      );
      if (!response.ok) throw new Error(`DeepSeek ${endpoint} API error ${response.status}.`);
      return (await response.json()) as T;
    } catch (error) {
      console.error(`[pi-web-access] DeepSeek ${endpoint} request failed`);
      requestSignal.throwIfAborted();
      if (
        error instanceof Error &&
        /^DeepSeek (search|fetch) API error \d+\.$/.test(error.message)
      ) {
        throw error;
      }
      throw new SafeToolError(`DeepSeek ${endpoint} request`, error);
    }
  }

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    let query = params.query;
    if (params.includeDomains?.length) {
      query += ` ${params.includeDomains.map((domain) => `site:${domain}`).join(' OR ')}`;
    }
    if (params.excludeDomains?.length) {
      query += ` ${params.excludeDomains.map((domain) => `-site:${domain}`).join(' ')}`;
    }
    if (params.timeRange) {
      const days = { day: 1, week: 7, month: 30, year: 365 }[params.timeRange];
      query += ` after:${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)}`;
    }
    if (!params.query.trim() || Array.from(query).length > 128) {
      throw new ValidationError(
        'DeepSeek search query must contain 1–128 Unicode characters, including filters.',
        'invalid_request',
      );
    }
    const count = params.maxResults ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ValidationError(
        'DeepSeek search maxResults must be an integer between 1 and 50.',
        'invalid_request',
      );
    }
    const data = await this.post<{
      results: Array<{
        title: string;
        url: string;
        summary: string;
        snippet: string;
        rerank_score: number;
      }>;
    }>('search', { query, count, need_content: false }, provider, signal);
    if (
      !Array.isArray(data?.results) ||
      data.results.some(
        (result) =>
          !result ||
          typeof result.title !== 'string' ||
          typeof result.url !== 'string' ||
          typeof result.summary !== 'string' ||
          typeof result.snippet !== 'string' ||
          !Number.isFinite(result.rerank_score),
      )
    )
      throw new Error('DeepSeek search returned an invalid response.');
    return {
      provider: provider.id,
      query: params.query,
      results: data.results.slice(0, count).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.summary || result.snippet || '',
        score: result.rerank_score,
      })),
    };
  }

  override async fetch(
    url: string,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    const data = await this.post<{ title: string; content: string }>(
      'fetch',
      { url },
      provider,
      signal,
    );
    if (typeof data?.content !== 'string' || !data.content.trim()) {
      throw new Error('DeepSeek fetch returned no page content.');
    }
    return {
      url,
      title: typeof data.title === 'string' ? data.title || url : url,
      content: data.content,
    };
  }
}
