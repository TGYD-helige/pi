import type { ResolvedProvider, SearchParams, SearchResponse, SearchResult } from './base.js';
import {
  BaseProvider,
  getEnvironmentContext,
  SEARCH_SYSTEM_PROMPT,
  timeoutSignal,
} from './base.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface XSearchParams {
  query: string;
  allowedHandles?: string[];
  excludedHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

export class XaiProvider extends BaseProvider {
  readonly id = 'xai' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'xAI API key not configured. Set XAI_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/responses`;
    const tool: Record<string, unknown> = { type: 'web_search' };
    if (params.includeDomains?.length) tool.filters = { allowed_domains: params.includeDomains };
    else if (params.excludeDomains?.length)
      tool.filters = { excluded_domains: params.excludeDomains };

    const body = {
      model: provider.model ?? 'grok-4.3',
      input: [
        { role: 'system', content: SEARCH_SYSTEM_PROMPT },
        { role: 'user', content: `${getEnvironmentContext()}\n\n${params.query}` },
      ],
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
      throw new Error(`xAI API error ${response.status}: ${text}`);
    }

    return this.parseResponse(params.query, provider, response);
  }

  async xsearch(params: XSearchParams, provider: ResolvedProvider): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'xAI API key not configured. Set XAI_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/responses`;
    const tool: Record<string, unknown> = { type: 'x_search' };
    if (params.allowedHandles?.length) tool.allowed_x_handles = params.allowedHandles;
    else if (params.excludedHandles?.length) tool.excluded_x_handles = params.excludedHandles;
    if (params.fromDate) tool.from_date = params.fromDate;
    if (params.toDate) tool.to_date = params.toDate;

    const body = {
      model: provider.model ?? 'grok-4.3',
      input: [
        { role: 'system', content: SEARCH_SYSTEM_PROMPT },
        { role: 'user', content: `${getEnvironmentContext()}\n\n${params.query}` },
      ],
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
      signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`xAI API error ${response.status}: ${text}`);
    }

    return this.parseResponse(params.query, provider, response);
  }

  private async parseResponse(
    query: string,
    provider: ResolvedProvider,
    response: Response,
  ): Promise<SearchResponse> {
    const data = (await response.json()) as {
      output: Array<{ type: string; content?: Array<{ type: string; text: string }> }>;
      citations?: Array<{ url: string; title?: string }>;
    };

    let answer = '';
    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        answer = item.content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('');
      }
    }
    const results: SearchResult[] = (data.citations ?? []).map((c) => ({
      title: c.title ?? c.url,
      url: c.url,
      content: '',
    }));

    return { provider: provider.id, query, answer: answer || undefined, results };
  }
}
