import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webFetch } from '../fetch.js';
import type { WebToolSettings } from '../types.js';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

const mockFetch = vi.fn();
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
vi.stubGlobal('fetch', mockFetch);

describe('webFetch - all providers', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockFetch.mockReset();
    safeFetchMock.mockReset();
    safeFetchMock.mockImplementation((input, init) =>
      globalThis.fetch(new URL(input).toString(), init),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('perplexity: fetches via agent API with fetch_url tool', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'perplexity' },
      providers: { perplexity: { apiKey: 'pplx-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'fetch_url_results',
            contents: [{ url: 'https://example.com', title: 'Page', snippet: 'content here' }],
          },
          { type: 'message', content: [{ type: 'output_text', text: 'Summarized content' }] },
        ],
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.content).toBe('Summarized content');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
  });

  it('openrouter: fetches via chat completions with openrouter:web_fetch', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'openrouter' },
      providers: { openrouter: { apiKey: 'or-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: 'Fetched page content from OpenRouter' },
          },
        ],
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.content).toBe('Fetched page content from OpenRouter');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('anthropic: fetches via messages API with web_fetch tool', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'anthropic' },
      providers: { anthropic: { apiKey: 'ant-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Full article content from Anthropic' }],
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.content).toBe('Full article content from Anthropic');
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('ant-key');
  });

  it('jina reader: used as default when no fetch.provider', async () => {
    const settings: WebToolSettings = {};
    mockFetch.mockResolvedValueOnce(new Response('# Page Title\n\nContent from Jina Reader'));

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.title).toBe('Page Title');
    expect(result.content).toContain('Content from Jina Reader');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://r.jina.ai/https://example.com');
  });

  it('jina reader fails → falls back to local HTTP', async () => {
    const settings: WebToolSettings = {};
    // Jina fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Local succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(
        '<html><head><title>Fallback</title></head><body><p>Local content</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
    );

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.title).toBe('Fallback');
    expect(result.content).toContain('Local content');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('openrouter: throws on HTTP error', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'openrouter' },
      providers: { openrouter: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'OpenRouter API error 429',
    );
  });

  it('anthropic: throws on HTTP error', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'anthropic' },
      providers: { anthropic: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'Anthropic API error 401',
    );
  });

  it('perplexity: throws on HTTP error', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'perplexity' },
      providers: { perplexity: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'Perplexity API error 500',
    );
  });

  it('firecrawl: scrapes via v2/scrape API with markdown format', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'fc-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          markdown: '# Firecrawl\n\nScraped content',
          metadata: { title: 'Firecrawl Home', sourceURL: 'https://firecrawl.dev/' },
        },
      }),
    });

    const result = await webFetch({ url: 'https://firecrawl.dev' }, settings, publicLookup);

    expect(result.title).toBe('Firecrawl Home');
    expect(result.url).toBe('https://firecrawl.dev/');
    expect(result.content).toContain('Scraped content');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(opts.headers.Authorization).toBe('Bearer fc-key');
    const body = JSON.parse(opts.body);
    expect(body.url).toBe('https://firecrawl.dev');
    expect(body.formats).toEqual(['markdown']);
    expect(body.onlyMainContent).toBe(true);
  });

  it('firecrawl: throws on HTTP error', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'Firecrawl Scrape API error 500',
    );
  });

  it('rejects private URLs before invoking a configured provider', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { markdown: 'private' } }),
    });

    await expect(
      webFetch({ url: 'http://169.254.169.254/latest/meta-data' }, settings, publicLookup),
    ).rejects.toThrow('public HTTP(S)');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses custom baseUrl for fetch provider', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'openrouter' },
      providers: { openrouter: { apiKey: 'key', baseUrl: 'https://my-proxy.com/v1' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://my-proxy.com/v1/chat/completions');
  });

  it('unsupported fetch provider (kimi) throws error', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'key' } },
    };

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'does not support web_fetch',
    );
  });
});
