import { BaseProvider, getEnvironmentContext, SEARCH_SYSTEM_PROMPT } from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse, SearchResult } from './index.js';

const DEFAULT_TIMEOUT_MS = 60_000;

const VARIANTS = {
  openai: { name: 'OpenAI', envVar: 'OPENAI_API_KEY', model: 'gpt-5.5' },
  deepseek: { name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-flash' },
  dashscope: { name: 'DashScope', envVar: 'DASHSCOPE_API_KEY', model: 'qwen3.8-flash' },
} as const;

export interface ResponsesApiStatus {
  status?: string;
  error?: { message?: string } | null;
}

export class OpenAIProvider extends BaseProvider {
  protected readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS;

  constructor(readonly id: keyof typeof VARIANTS = 'openai') {
    super();
  }

  protected get defaultModel(): string {
    return VARIANTS[this.id].model;
  }

  /** POST the Responses API with shared auth, HTTP-error, and failed-status handling. */
  protected async postResponses<T extends ResponsesApiStatus>(
    provider: ResolvedProvider,
    body: unknown,
  ): Promise<T> {
    const variant = VARIANTS[this.id];
    const name = variant.name;
    if (!provider.apiKey) {
      throw new Error(
        `${name} API key not configured. Set ${variant.envVar} or configure settings.json.`,
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/responses`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(provider.timeoutMs ?? this.defaultTimeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${name} API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as T;
    if (data.status === 'failed') {
      const detail = (data.error?.message ?? 'unknown error').slice(0, 300);
      console.error(`[pi-web-access] ${name} response failed: ${detail}`);
      throw new Error(`${name} API response failed.`);
    }
    return data;
  }

  override async search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse> {
    const name = VARIANTS[this.id].name;

    const tool: Record<string, unknown> = { type: 'web_search' };
    // DashScope's Responses API supports only basic web_search; domain filters are unsupported.
    if (
      this.id !== 'dashscope' &&
      (params.includeDomains?.length || params.excludeDomains?.length)
    ) {
      const filters: Record<string, unknown> = {};
      if (params.includeDomains?.length) filters.allowed_domains = params.includeDomains;
      if (params.excludeDomains?.length) filters.blocked_domains = params.excludeDomains;
      tool.filters = filters;
    }

    const data = await this.postResponses<{
      status?: string;
      error?: { message?: string } | null;
      incomplete_details?: { reason?: string } | null;
      output?: Array<{
        type: string;
        status?: string;
        content?: Array<{
          type: string;
          text: string;
          annotations?: Array<{ type: string; url?: string; title?: string }>;
        }>;
        action?: { type: string; url?: string };
      }>;
    }>(provider, {
      model: provider.model ?? this.defaultModel,
      instructions: SEARCH_SYSTEM_PROMPT,
      input: `${getEnvironmentContext()}\n\n${params.query}`,
      tools: [tool],
    });

    let answer = '';
    const results: SearchResult[] = [];
    const seen = new Map<string, SearchResult>();
    const addResult = (title: string, url: string) => {
      const existing = seen.get(url);
      if (existing) {
        // Annotations carry real titles but arrive after web_search_call items.
        if (existing.title === existing.url && title !== url) existing.title = title;
        return;
      }
      const result: SearchResult = { title, url, content: '' };
      seen.set(url, result);
      results.push(result);
    };

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.type === 'output_text') {
            answer += block.text;
            if (block.annotations) {
              for (const ann of block.annotations) {
                if (ann.type === 'url_citation' && ann.url)
                  addResult(ann.title ?? ann.url, ann.url);
              }
            }
          }
        }
      }
      // DeepSeek never emits url_citation annotations; opened pages are the only source trail.
      // DeepSeek appends a tracking fragment (#ws_call_id=...) that must be stripped.
      if (
        item.type === 'web_search_call' &&
        item.status !== 'failed' &&
        item.action?.type === 'open_page' &&
        item.action.url
      ) {
        const url = item.action.url.split('#ws_call_id=')[0]!;
        addResult(url, url);
      }
    }

    if (!answer && data.status && data.status !== 'completed') {
      const reason = (data.incomplete_details?.reason ?? 'unknown').slice(0, 300);
      console.error(`[pi-web-access] ${name} response ${data.status}: ${reason}`);
      throw new Error(`${name} API response did not produce an answer (status: ${data.status}).`);
    }

    if (!answer) {
      const types = (data.output ?? [])
        .map((i) => i.type)
        .join(',')
        .slice(0, 200);
      console.error(
        `[pi-web-access] ${name} response returned no answer (status: ${data.status ?? 'unknown'}, output types: ${types})`,
      );
    }

    return {
      provider: provider.id,
      query: params.query,
      answer: answer || undefined,
      results: results.slice(0, params.maxResults ?? 5),
    };
  }
}
