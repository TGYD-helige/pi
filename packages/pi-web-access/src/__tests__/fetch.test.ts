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

describe('webFetch', () => {
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

  it('fetches via zai when configured as default', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'zai' },
      providers: { zai: { apiKey: 'zai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reader_result: {
          content: '# Hello\nWorld',
          description: 'A test page',
          title: 'Test Page',
          url: 'https://example.com',
        },
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.title).toBe('Test Page');
    expect(result.content).toBe('# Hello\nWorld');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.z.ai/api/paas/v4/reader');
    expect(opts.headers.Authorization).toBe('Bearer zai-key');
  });

  it('fetches via tavily when configured as default', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'tavily-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ url: 'https://example.com', raw_content: '# Extracted content' }],
        failed_results: [],
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.content).toBe('# Extracted content');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.tavily.com/extract');
  });

  it('uses zai when fetch.provider is zai', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'zai' },
      providers: {
        zai: { apiKey: 'zai-key' },
        tavily: { apiKey: 'tavily-key' },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reader_result: {
          content: 'zai wins',
          description: '',
          title: 'T',
          url: 'https://example.com',
        },
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);
    expect(result.content).toBe('zai wins');
  });

  it('uses tavily when fetch.provider is tavily', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'tavily-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ url: 'https://example.com', raw_content: 'tavily content' }],
        failed_results: [],
      }),
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);
    expect(result.content).toBe('tavily content');
  });

  it('tries jina reader first when fetch.provider not set', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '# Jina Title\n\nRendered content from Jina',
    });

    const result = await webFetch({ url: 'https://example.com' }, {}, publicLookup);

    expect(result.title).toBe('Jina Title');
    expect(result.content).toContain('Rendered content from Jina');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://r.jina.ai/https://example.com');
  });

  it('falls back to local fetch when jina reader fails', async () => {
    // Jina fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    // Local fetch succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'text/html']]),
      text: async () =>
        '<html><head><title>Local Page</title></head><body><h1>Hello</h1><p>World</p></body></html>',
    });

    const result = await webFetch({ url: 'https://example.com' }, {}, publicLookup);

    expect(result.title).toBe('Local Page');
    expect(result.content).toContain('Hello');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toBe('https://r.jina.ai/https://example.com');
    expect(mockFetch.mock.calls[1]![0]).toBe('https://example.com/');
  });

  it('uses only the local safe fetch path in local_only mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers([['content-type', 'text/html']]),
      text: async () =>
        '<html><head><title>Private Page</title></head><body>Authenticated content</body></html>',
    });

    const result = await webFetch(
      { url: 'https://example.com/private?token=secret' },
      {
        fetch: { mode: 'local_only', provider: 'zai' },
        providers: { zai: { apiKey: 'configured-but-forbidden' } },
      },
      publicLookup,
    );

    expect(result.title).toBe('Private Page');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('https://example.com/private?token=secret');
  });

  it('blocks loopback URLs before either fetch path runs', async () => {
    const { safeFetch } =
      await vi.importActual<typeof import('@amaster.ai/pi-shared')>('@amaster.ai/pi-shared');
    safeFetchMock.mockImplementation(safeFetch);
    await expect(webFetch({ url: 'http://127.0.0.1/private' }, {})).rejects.toThrow(/public HTTP/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on HTTP error from zai', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'zai' },
      providers: { zai: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'Z.AI Reader API error 500',
    );
  });

  it('throws on tavily extract failure', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [],
        failed_results: [{ url: 'https://example.com', error: 'timeout' }],
      }),
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'Tavily failed to extract',
    );
  });

  it('uses custom baseUrl from settings', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'zai' },
      providers: { zai: { apiKey: 'key', baseUrl: 'https://my-proxy.com' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reader_result: { content: 'ok', description: '', title: 'T', url: 'https://example.com' },
      }),
    });

    await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://my-proxy.com/api/paas/v4/reader');
  });
});
