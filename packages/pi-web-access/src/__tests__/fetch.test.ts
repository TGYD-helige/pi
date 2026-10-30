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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    'deepseek',
    'zai',
    'tavily',
    'dashscope',
    'anthropic',
    'firecrawl',
    'you',
    'openrouter',
    'perplexity',
    undefined,
  ] as const)('cancels %s fetching without falling back after caller abort', async (provider) => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async (_url, options) => {
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      throw controller.signal.reason;
    });
    const settings: WebToolSettings = provider
      ? {
          fetch: { provider },
          providers: { [provider]: { apiKey: 'fixture' } },
        }
      : {};
    await expect(
      webFetch({ url: 'https://example.com' }, settings, publicLookup, controller.signal),
    ).rejects.toThrow('aborted');
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'caller',
    'deadline',
  ] as const)('cancels pending destination DNS on %s abort', async (source) => {
    const controller = new AbortController();
    const deadline = new AbortController();
    if (source === 'deadline') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let rejected = false;
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(() => {}));
    void webFetch({ url: 'https://example.com' }, {}, lookup, controller.signal).catch(() => {
      rejected = true;
    });
    (source === 'caller' ? controller : deadline).abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rejected).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shares one deadline across Jina timeout and local fallback', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('deadline exceeded')), ms);
      return controller.signal;
    });
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
    );
    const started = Date.now();
    const result = expect(
      webFetch({ url: 'https://example.com' }, { timeoutMs: 100 }, publicLookup),
    ).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(100);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![1].signal.aborted).toBe(true);
    await result;
    expect(Date.now() - started).toBe(100);
  });

  it('stops reading an oversized local response before converting HTML', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    mockFetch.mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'text/html' } }),
    );
    await expect(webFetch({ url: 'https://example.com' }, {}, publicLookup)).rejects.toThrow(
      'size ceiling',
    );
    expect(cancel).toHaveBeenCalledOnce();
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
    mockFetch.mockResolvedValueOnce(new Response('# Jina Title\n\nRendered content from Jina'));

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
    mockFetch.mockResolvedValueOnce(
      new Response(
        '<html><head><title>Local Page</title></head><body><h1>Hello</h1><p>World</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
    );

    const result = await webFetch({ url: 'https://example.com' }, {}, publicLookup);

    expect(result.title).toBe('Local Page');
    expect(result.content).toContain('Hello');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toBe('https://r.jina.ai/https://example.com');
    expect(mockFetch.mock.calls[1]![0]).toBe('https://example.com/');
  });

  it('blocks loopback URLs before either fetch path runs', async () => {
    const { safeFetch } =
      await vi.importActual<typeof import('@amaster.ai/pi-shared')>('@amaster.ai/pi-shared');
    safeFetchMock.mockImplementation(safeFetch);
    await expect(webFetch({ url: 'http://127.0.0.1/private' }, {})).rejects.toThrow(/public HTTP/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes configured provider hosts as trustedHosts to the local fetch', async () => {
    const settings: WebToolSettings = {
      providers: { deepseek: { apiKey: 'k', baseUrl: 'https://gateway.internal.example/v1' } },
    };
    // Jina fails → local fallback goes through safeFetch.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    mockFetch.mockResolvedValueOnce(
      new Response('<html><body>ok</body></html>', { headers: { 'content-type': 'text/html' } }),
    );

    await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://example.com',
      expect.anything(),
      expect.objectContaining({ trustedHosts: ['gateway.internal.example'] }),
    );
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

  it('fetches via you contents API when configured', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'you' },
      providers: { you: { apiKey: 'you-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { url: 'https://example.com', title: 'Example Page', markdown: '# Extracted content' },
      ],
    });

    const result = await webFetch({ url: 'https://example.com' }, settings, publicLookup);

    expect(result.title).toBe('Example Page');
    expect(result.content).toBe('# Extracted content');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://ydc-index.io/v1/contents');
    expect(opts.headers['X-API-Key']).toBe('you-key');
    const body = JSON.parse(opts.body);
    expect(body.urls).toEqual(['https://example.com']);
    expect(body.formats).toEqual(['markdown']);
  });

  it('throws when you contents returns null markdown', async () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'you' },
      providers: { you: { apiKey: 'you-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ url: 'https://example.com', title: 'T', markdown: null }],
    });

    await expect(webFetch({ url: 'https://example.com' }, settings, publicLookup)).rejects.toThrow(
      'You.com failed to extract',
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
