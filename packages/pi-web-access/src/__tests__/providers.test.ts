import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('search - all providers', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('gemini: calls generateContent with google_search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'gemini' },
      providers: { gemini: { apiKey: 'gemini-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: 'Gemini answer' }], role: 'model' },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
            },
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('gemini');
    expect(result.answer).toBe('Gemini answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://example.com');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(opts.headers['x-goog-api-key']).toBe('gemini-key');
  });

  it('perplexity: calls agent API with web_search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'perplexity' },
      providers: { perplexity: { apiKey: 'pplx-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'search_results',
            results: [
              { id: 1, url: 'https://example.com', title: 'Result', snippet: 'snippet text' },
            ],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Perplexity answer' }],
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('perplexity');
    expect(result.answer).toBe('Perplexity answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.content).toBe('snippet text');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
    expect(opts.headers.Authorization).toBe('Bearer pplx-key');
  });

  it('openrouter: calls chat completions with openrouter:web_search', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'openrouter' },
      providers: { openrouter: { apiKey: 'or-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'OpenRouter answer',
              annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Source' }],
            },
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('openrouter');
    expect(result.answer).toBe('OpenRouter answer');
    expect(result.results).toHaveLength(1);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('xai: calls responses API with web_search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'xai' },
      providers: { xai: { apiKey: 'xai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'xAI answer' }],
          },
        ],
        citations: [{ url: 'https://x.com/post', title: 'X Post' }],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('xai');
    expect(result.answer).toBe('xAI answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://x.com/post');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/responses');
    expect(opts.headers.Authorization).toBe('Bearer xai-key');
  });

  it('openai: calls responses API with web_search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'openai' },
      providers: { openai: { apiKey: 'oai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'OpenAI answer',
                annotations: [{ type: 'url_citation', url: 'https://openai.com', title: 'OpenAI' }],
              },
            ],
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('openai');
    expect(result.answer).toBe('OpenAI answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://openai.com');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(opts.headers.Authorization).toBe('Bearer oai-key');
  });

  it('anthropic: calls messages API with web_search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'anthropic' },
      providers: { anthropic: { apiKey: 'ant-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: 'Anthropic answer',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://anthropic.com',
                title: 'Anthropic',
                cited_text: 'cited',
              },
            ],
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('anthropic');
    expect(result.answer).toBe('Anthropic answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://anthropic.com');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('ant-key');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('firecrawl: calls v2/search API with Bearer token', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'fc-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          web: [
            {
              title: 'Result 1',
              url: 'https://example.com',
              description: 'Example description',
              position: 1,
            },
            {
              title: 'Result 2',
              url: 'https://other.com',
              description: 'Other description',
              position: 2,
            },
          ],
        },
      }),
    });

    const result = await search({ query: 'test query' }, settings);

    expect(result.provider).toBe('firecrawl');
    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.title).toBe('Result 1');
    expect(result.results[0]!.url).toBe('https://example.com');
    expect(result.results[0]!.content).toBe('Example description');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.firecrawl.dev/v2/search');
    expect(opts.headers.Authorization).toBe('Bearer fc-key');
    const body = JSON.parse(opts.body);
    expect(body.query).toBe('test query');
    expect(body.sources).toEqual(['web']);
  });

  it('firecrawl: maps timeRange to tbs and passes limit', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { web: [] } }),
    });

    await search({ query: 'test', timeRange: 'week', maxResults: 10 }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tbs).toBe('qdr:w');
    expect(body.limit).toBe(10);
  });

  it('firecrawl: uses news source and snippet when topic is news', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          news: [{ title: 'News Item', url: 'https://news.com', snippet: 'Breaking news' }],
        },
      }),
    });

    const result = await search({ query: 'test', topic: 'news' }, settings);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe('News Item');
    expect(result.results[0]!.content).toBe('Breaking news');

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.sources).toEqual(['news']);
  });

  it('firecrawl: passes domain filters', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { web: [] } }),
    });

    await search({ query: 'test', includeDomains: ['example.com'] }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.includeDomains).toEqual(['example.com']);
  });

  it('firecrawl: throws on HTTP error', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => 'Payment required',
    });

    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Firecrawl Search API error 402',
    );
  });

  it('brave: calls web search API with X-Subscription-Token', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'brave' },
      providers: { brave: { apiKey: 'brave-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: { original: 'test query' },
        web: {
          results: [
            { title: 'Result 1', url: 'https://example.com', description: 'Example description' },
            { title: 'Result 2', url: 'https://other.com', description: 'Other description' },
          ],
        },
      }),
    });

    const result = await search({ query: 'test query' }, settings);

    expect(result.provider).toBe('brave');
    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.title).toBe('Result 1');
    expect(result.results[0]!.url).toBe('https://example.com');
    expect(result.results[0]!.content).toBe('Example description');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(url).toContain('q=test+query');
    expect(opts.headers['X-Subscription-Token']).toBe('brave-key');
  });

  it('brave: passes freshness for timeRange', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'brave' },
      providers: { brave: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await search({ query: 'test', timeRange: 'week' }, settings);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('freshness=pw');
  });

  it('brave: uses news results when topic is news', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'brave' },
      providers: { brave: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        news: {
          results: [{ title: 'News Item', url: 'https://news.com', description: 'Breaking news' }],
        },
      }),
    });

    const result = await search({ query: 'test', topic: 'news' }, settings);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe('News Item');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('result_filter=news');
  });

  it('brave: passes count parameter', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'brave' },
      providers: { brave: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await search({ query: 'test', maxResults: 10 }, settings);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('count=10');
  });

  it('openrouter: passes domain filters', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'openrouter' },
      providers: { openrouter: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    await search({ query: 'test', includeDomains: ['example.com'] }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].parameters.allowed_domains).toEqual(['example.com']);
  });

  it('openai: passes domain filters', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'openai' },
      providers: { openai: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      }),
    });

    await search({ query: 'test', excludeDomains: ['reddit.com'] }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].filters.blocked_domains).toEqual(['reddit.com']);
  });

  it('xai: passes allowed_domains via filters', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'xai' },
      providers: { xai: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output: [], citations: [] }),
    });

    await search({ query: 'test', includeDomains: ['x.com'] }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].filters.allowed_domains).toEqual(['x.com']);
  });

  it('gemini: uses custom model from settings', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'gemini' },
      providers: { gemini: { apiKey: 'key', model: 'gemini-3.5-flash' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' } }] }),
    });

    await search({ query: 'test' }, settings);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/models/gemini-3.5-flash:generateContent');
  });

  it('perplexity: uses custom model from settings', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'perplexity' },
      providers: { perplexity: { apiKey: 'key', model: 'sonar-pro' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      }),
    });

    await search({ query: 'test' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.model).toBe('sonar-pro');
  });

  it('dashscope: calls responses API with web_search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'dashscope' },
      providers: { dashscope: { apiKey: 'dashscope-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'DashScope answer',
                annotations: [{ type: 'url_citation', url: 'https://aliyun.com', title: 'Aliyun' }],
              },
            ],
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('dashscope');
    expect(result.answer).toBe('DashScope answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://aliyun.com');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/responses');
    expect(opts.headers.Authorization).toBe('Bearer dashscope-key');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('qwen3.8-flash');
    expect(body.tools[0].type).toBe('web_search');
  });

  it('dashscope: omits domain filters (unsupported by the DashScope Responses API)', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'dashscope' },
      providers: { dashscope: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'completed', output: [] }),
    });

    await search({ query: 'test', includeDomains: ['example.com'] }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].filters).toBeUndefined();
  });
});

describe('XaiProvider.xsearch', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('calls xAI responses API with x_search tool type', async () => {
    const { XaiProvider } = await import('../providers/xai.js');
    const provider = new XaiProvider();
    const resolved = { id: 'xai' as const, baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-key' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'People are excited about xAI' }],
          },
        ],
        citations: [{ url: 'https://x.com/elonmusk/status/123', title: 'Elon on xAI' }],
      }),
    });

    const result = await provider.xsearch({ query: 'xAI news' }, resolved);

    expect(result.answer).toBe('People are excited about xAI');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toContain('x.com');

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].type).toBe('x_search');
  });

  it('passes allowedHandles filter', async () => {
    const { XaiProvider } = await import('../providers/xai.js');
    const provider = new XaiProvider();
    const resolved = { id: 'xai' as const, baseUrl: 'https://api.x.ai/v1', apiKey: 'key' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output: [], citations: [] }),
    });

    await provider.xsearch({ query: 'test', allowedHandles: ['elonmusk'] }, resolved);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].allowed_x_handles).toEqual(['elonmusk']);
  });

  it('passes excludedHandles filter', async () => {
    const { XaiProvider } = await import('../providers/xai.js');
    const provider = new XaiProvider();
    const resolved = { id: 'xai' as const, baseUrl: 'https://api.x.ai/v1', apiKey: 'key' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output: [], citations: [] }),
    });

    await provider.xsearch({ query: 'test', excludedHandles: ['bot'] }, resolved);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].excluded_x_handles).toEqual(['bot']);
  });

  it('passes date range filters', async () => {
    const { XaiProvider } = await import('../providers/xai.js');
    const provider = new XaiProvider();
    const resolved = { id: 'xai' as const, baseUrl: 'https://api.x.ai/v1', apiKey: 'key' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output: [], citations: [] }),
    });

    await provider.xsearch(
      { query: 'test', fromDate: '2025-10-01', toDate: '2025-10-10' },
      resolved,
    );

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools[0].from_date).toBe('2025-10-01');
    expect(body.tools[0].to_date).toBe('2025-10-10');
  });

  it('throws on missing API key', async () => {
    const { XaiProvider } = await import('../providers/xai.js');
    const provider = new XaiProvider();
    const resolved = { id: 'xai' as const, baseUrl: 'https://api.x.ai/v1' };

    await expect(provider.xsearch({ query: 'test' }, resolved)).rejects.toThrow(
      'xAI API key not configured',
    );
  });

  it('throws on HTTP error', async () => {
    const { XaiProvider } = await import('../providers/xai.js');
    const provider = new XaiProvider();
    const resolved = { id: 'xai' as const, baseUrl: 'https://api.x.ai/v1', apiKey: 'key' };

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    await expect(provider.xsearch({ query: 'test' }, resolved)).rejects.toThrow(
      'xAI API error 429',
    );
  });
});

describe('DashscopeProvider', () => {
  const resolved = {
    id: 'dashscope' as const,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'dashscope-key',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('search throws on missing API key', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    await expect(
      provider.search({ query: 'test' }, { id: 'dashscope', baseUrl: resolved.baseUrl }),
    ).rejects.toThrow('DashScope API key not configured');
  });

  it('fetch calls responses API with web_search and web_extractor tools', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'completed',
        output_text: 'summary',
        output: [
          { type: 'web_extractor_call', status: 'completed', output: 'extracted page content' },
          { type: 'message' },
        ],
      }),
    });

    const result = await provider.fetch('https://example.com', resolved);

    expect(result.url).toBe('https://example.com');
    expect(result.content).toBe('extracted page content');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/responses');
    expect(opts.headers.Authorization).toBe('Bearer dashscope-key');
    const body = JSON.parse(opts.body);
    expect(body.tools).toEqual([{ type: 'web_search' }, { type: 'web_extractor' }]);
    expect(body.input).toContain('https://example.com');
  });

  it('fetch falls back to output_text when no extractor output', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'completed', output_text: 'model answer', output: [] }),
    });

    const result = await provider.fetch('https://example.com', resolved);

    expect(result.content).toBe('model answer');
  });

  it('imageSearch parses web_search_image_call output', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'completed',
        output_text: 'found images',
        output: [
          {
            type: 'web_search_image_call',
            status: 'completed',
            output: JSON.stringify([
              { index: 1, title: 'Tech background', url: 'https://img.example.com/1.png' },
              { index: 2, title: 'Blue gradient', url: 'https://img.example.com/2.png' },
            ]),
          },
        ],
      }),
    });

    const result = await provider.imageSearch({ query: 'tech background' }, resolved);

    expect(result.provider).toBe('dashscope');
    expect(result.answer).toBe('found images');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: 'Tech background',
      url: 'https://img.example.com/1.png',
      content: '',
    });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools).toEqual([{ type: 'web_search_image' }]);
    expect(body.input).toBe('tech background');
  });

  it('imageSearch skips malformed tool output', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'completed',
        output: [{ type: 'web_search_image_call', output: 'not json' }],
      }),
    });

    const result = await provider.imageSearch({ query: 'test' }, resolved);

    expect(result.results).toHaveLength(0);
    expect(result.answer).toBeUndefined();
  });

  it('imageSearch throws on missing API key', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    await expect(
      provider.imageSearch({ query: 'test' }, { id: 'dashscope', baseUrl: resolved.baseUrl }),
    ).rejects.toThrow('DashScope API key not configured');
  });

  it('throws on HTTP error', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    await expect(provider.imageSearch({ query: 'test' }, resolved)).rejects.toThrow(
      'DashScope API error 429',
    );
  });

  it('throws when response status is failed', async () => {
    const { DashscopeProvider } = await import('../providers/dashscope.js');
    const provider = new DashscopeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'failed', error: { message: 'tool failed' } }),
    });

    await expect(provider.imageSearch({ query: 'test' }, resolved)).rejects.toThrow(
      'DashScope API response failed.',
    );
  });
});

describe('UnsplashProvider.imageSearch', () => {
  const resolved = {
    id: 'unsplash' as const,
    baseUrl: 'https://api.unsplash.com',
    apiKey: 'unsplash-key',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls search/photos with Client-ID auth and parses results', async () => {
    const { UnsplashProvider } = await import('../providers/unsplash.js');
    const provider = new UnsplashProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total: 2,
        total_pages: 1,
        results: [
          {
            alt_description: 'a cat sitting on a table',
            urls: { regular: 'https://images.unsplash.com/photo-1?w=1080' },
            links: { html: 'https://unsplash.com/photos/1' },
            user: { name: 'Jane Doe' },
          },
          {
            alt_description: null,
            description: 'city skyline',
            urls: { regular: 'https://images.unsplash.com/photo-2?w=1080' },
            links: { html: 'https://unsplash.com/photos/2' },
            user: { name: 'John Roe' },
          },
        ],
      }),
    });

    const result = await provider.imageSearch({ query: 'cat' }, resolved);

    expect(result.provider).toBe('unsplash');
    expect(result.query).toBe('cat');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.title).toBe('a cat sitting on a table');
    expect(result.results[0]!.url).toBe('https://images.unsplash.com/photo-1?w=1080');
    expect(result.results[0]!.content).toBe(
      'Photo by Jane Doe on Unsplash — https://unsplash.com/photos/1',
    );
    expect(result.results[1]!.title).toBe('city skyline');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain('https://api.unsplash.com/search/photos');
    expect(String(url)).toContain('query=cat');
    expect(String(url)).toContain('per_page=10');
    expect(opts.headers.Authorization).toBe('Client-ID unsplash-key');
  });

  it('skips photos without a regular image URL', async () => {
    const { UnsplashProvider } = await import('../providers/unsplash.js');
    const provider = new UnsplashProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { alt_description: 'no url', urls: {} },
          { alt_description: 'has url', urls: { regular: 'https://images.unsplash.com/x' } },
        ],
      }),
    });

    const result = await provider.imageSearch({ query: 'test' }, resolved);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe('has url');
  });

  it('throws on missing API key', async () => {
    const { UnsplashProvider } = await import('../providers/unsplash.js');
    const provider = new UnsplashProvider();

    await expect(
      provider.imageSearch({ query: 'test' }, { id: 'unsplash', baseUrl: resolved.baseUrl }),
    ).rejects.toThrow('Unsplash API key not configured');
  });

  it('throws on HTTP error', async () => {
    const { UnsplashProvider } = await import('../providers/unsplash.js');
    const provider = new UnsplashProvider();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(provider.imageSearch({ query: 'test' }, resolved)).rejects.toThrow(
      'Unsplash API error 401',
    );
  });
});
