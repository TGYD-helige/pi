import {
  BaseProvider,
  getEnvironmentContext,
  SEARCH_SYSTEM_PROMPT,
  timeoutSignal,
} from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse, SearchResult } from './index.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export class MimoProvider extends BaseProvider {
  readonly id = 'mimo' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Mimo API key not configured. Set MIMO_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: provider.model ?? 'mimo-v2.5-pro',
      messages: [
        { role: 'system', content: SEARCH_SYSTEM_PROMPT },
        { role: 'user', content: `${getEnvironmentContext()}\n\n${params.query}` },
      ],
      tools: [{ type: 'web_search', max_keyword: 3, force_search: true }],
      max_completion_tokens: 2048,
      temperature: 1.0,
      top_p: 0.95,
      stream: false,
      thinking: { type: 'disabled' },
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'api-key': provider.apiKey,
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
      throw new Error(`Mimo API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string;
          annotations?: Array<{ type: string; url: string; title: string; summary: string }>;
        };
      }>;
    };
    const choice = data.choices[0];
    if (!choice) throw new Error('Mimo API returned empty response');

    const results: SearchResult[] = (choice.message.annotations ?? [])
      .filter((a) => a.type === 'url_citation')
      .map((a) => ({ title: a.title, url: a.url, content: a.summary }));

    return { provider: provider.id, query: params.query, answer: choice.message.content, results };
  }
}
