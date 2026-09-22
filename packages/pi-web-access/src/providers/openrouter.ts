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

export class OpenRouterProvider extends BaseProvider {
  readonly id = 'openrouter' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'OpenRouter API key not configured. Set OPENROUTER_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const tool: Record<string, unknown> = { type: 'openrouter:web_search' };
    const toolParams: Record<string, unknown> = {};
    if (params.maxResults) toolParams.max_results = params.maxResults;
    if (params.includeDomains?.length) toolParams.allowed_domains = params.includeDomains;
    if (params.excludeDomains?.length) toolParams.excluded_domains = params.excludeDomains;
    if (Object.keys(toolParams).length > 0) tool.parameters = toolParams;

    const body = {
      model: provider.model ?? 'openai/gpt-4.1-mini',
      messages: [
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
      throw new Error(`OpenRouter API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string;
          annotations?: Array<{ type: string; url?: string; title?: string; content?: string }>;
        };
      }>;
    };
    const choice = data.choices[0];
    if (!choice) throw new Error('OpenRouter API returned empty response');

    const results: SearchResult[] = (choice.message.annotations ?? [])
      .filter((a) => a.type === 'url_citation' && a.url)
      .map((a) => ({ title: a.title ?? a.url!, url: a.url!, content: a.content ?? '' }));

    return { provider: provider.id, query: params.query, answer: choice.message.content, results };
  }

  override async fetch(targetUrl: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'OpenRouter API key not configured. Set OPENROUTER_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: provider.model ?? 'openai/gpt-4.1-mini',
      messages: [
        { role: 'user', content: `Fetch and return the full content of this URL: ${targetUrl}` },
      ],
      tools: [{ type: 'openrouter:web_fetch' }],
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
      throw new Error(`OpenRouter API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const choice = data.choices[0];
    if (!choice) throw new Error('OpenRouter API returned empty response');

    return { url: targetUrl, title: targetUrl, content: choice.message.content };
  }
}
