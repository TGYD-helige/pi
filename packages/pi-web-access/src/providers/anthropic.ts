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

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Anthropic API key not configured. Set ANTHROPIC_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/messages`;
    const tool: Record<string, unknown> = { type: 'web_search_20250305', name: 'web_search' };
    if (params.includeDomains?.length) tool.allowed_domains = params.includeDomains;
    if (params.excludeDomains?.length) tool.blocked_domains = params.excludeDomains;
    if (params.maxResults) tool.max_uses = params.maxResults;

    const body = {
      model: provider.model ?? 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${getEnvironmentContext()}\n\n${params.query}` }],
      tools: [tool],
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
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
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string;
        text?: string;
        citations?: Array<{ url?: string; title?: string; cited_text?: string }>;
      }>;
    };

    let answer = '';
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();
    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        answer += block.text;
        if (block.citations) {
          for (const cite of block.citations) {
            if (cite.url && !seenUrls.has(cite.url)) {
              seenUrls.add(cite.url);
              results.push({
                title: cite.title ?? cite.url,
                url: cite.url,
                content: cite.cited_text ?? '',
              });
            }
          }
        }
      }
    }

    return { provider: provider.id, query: params.query, answer: answer || undefined, results };
  }

  override async fetch(targetUrl: string, provider: ResolvedProvider): Promise<FetchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Anthropic API key not configured. Set ANTHROPIC_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/messages`;
    const body = {
      model: provider.model ?? 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: `Please fetch and return the full content at: ${targetUrl}` },
      ],
      tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
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
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
    let content = '';
    for (const block of data.content) {
      if (block.type === 'text' && block.text) content += block.text;
    }

    return { url: targetUrl, title: targetUrl, content };
  }
}
