import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

const mockFetch = vi.fn();
const settings: WebToolSettings = {
  search: { provider: 'cloudflare' },
  providers: { cloudflare: { apiKey: 'cf-token', accountId: 'account-123' } },
};

describe('Cloudflare search', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('routes search through the default gateway and returns normalized results', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ url: 'https://example.com', title: 'Example', description: 'A useful result' }],
          metadata: { requestId: 'request-123' },
        }),
      ),
    );
    const result = await search({ query: 'Cloudflare Workers' }, settings);
    expect(result).toEqual({
      provider: 'cloudflare',
      query: 'Cloudflare Workers',
      results: [{ url: 'https://example.com', title: 'Example', content: 'A useful result' }],
    });
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account-123/ai/websearch/');
    expect(options.headers.Authorization).toBe('Bearer cf-token');
    expect(JSON.parse(options.body)).toEqual({
      query: 'Cloudflare Workers',
      provider: 'ceramic',
      limit: 5,
      options: { gateway: { id: 'default' } },
    });
  });

  it('bounds external results and snippets', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: Array.from({ length: 20 }, () => ({
            title: '标题'.repeat(5000),
            url: 'https://example.com',
            description: '内容\n'.repeat(10000),
          })),
        }),
      ),
    );
    const result = await search({ query: 'test', maxResults: 20 }, settings);
    expect(result.results).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(45_000);
    expect(result.results[0]!.content.split('\n').length).toBeLessThanOrEqual(41);
    expect(JSON.parse(mockFetch.mock.calls[0]![1].body).limit).toBe(10);
  });

  it('uses the configured endpoint, gateway, provider, BYOK alias, and headers', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    const result = await search(
      { query: 'test' },
      {
        ...settings,
        providers: {
          cloudflare: {
            apiKey: 'custom-token',
            accountId: 'custom-account',
            baseUrl: 'https://proxy.example/v4/',
            gatewayId: 'my-gateway',
            searchProvider: 'exa',
            byokAlias: 'my-key',
            headers: { 'X-Custom': 'value' },
          },
        },
      },
    );
    expect(result.results).toEqual([]);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://proxy.example/v4/accounts/custom-account/ai/websearch/');
    expect(options.headers['X-Custom']).toBe('value');
    expect(JSON.parse(options.body)).toEqual({
      query: 'test',
      provider: 'exa',
      limit: 5,
      byokAlias: 'my-key',
      options: { gateway: { id: 'my-gateway' } },
    });
  });

  it('propagates caller cancellation', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const result = search({ query: 'test' }, settings, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
    expect(mockFetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it('sanitizes HTTP and network errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response('secret-token upstream-body', { status: 403 }));
    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Cloudflare Web Search API error (HTTP 403).',
    );
    expect(log).toHaveBeenCalledWith('[pi-web-access] Cloudflare Web Search API error (HTTP 403)');
    mockFetch.mockRejectedValueOnce(new Error('secret-token network details'));
    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Cloudflare search request failed or was cancelled.',
    );
  });

  it.each([
    { apiKey: 123 },
    { accountId: 123 },
    { gatewayId: { secret: 'invalid-value' } },
    { byokAlias: 123 },
    { accountId: '' },
    { accountId: '../bad' },
    { searchProvider: 'unknown' },
    { gatewayId: '' },
    { byokAlias: 'invalid key' },
  ])('rejects invalid configuration before sending a request: %j', async (config) => {
    await expect(
      search({ query: 'test' }, {
        ...settings,
        providers: { cloudflare: { ...settings.providers!.cloudflare, ...config } },
      } as WebToolSettings),
    ).rejects.toThrow('Cloudflare');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['', ' '.repeat(10), 'q'.repeat(1025)])('rejects invalid queries', async (query) => {
    await expect(search({ query }, settings)).rejects.toThrow('1–1024');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { items: [{}] },
    { success: false },
    { items: [{ title: 'A', url: 'https://example.com', description: null }] },
  ])('rejects malformed responses without exposing their contents', async (data) => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(data)));
    await expect(search({ query: 'test' }, settings)).rejects.toThrow('invalid search response');
  });

  it.each([
    0,
    -1,
    1.5,
    20.5,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid result counts', async (maxResults) => {
    await expect(search({ query: 'test', maxResults }, settings)).rejects.toThrow(
      'positive integer',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requires an API token', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    await expect(
      search(
        { query: 'test' },
        {
          search: { provider: 'cloudflare' },
          providers: { cloudflare: { accountId: 'account-123' } },
        },
      ),
    ).rejects.toThrow('Cloudflare API token not configured');
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it.each([
    {},
    { metadata: { requestId: 'request-123' } },
  ])('accepts an omitted results array', async (data) => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(data)));
    await expect(search({ query: 'test' }, settings)).resolves.toMatchObject({ results: [] });
  });

  it('preserves useful prefixes when single-line titles and descriptions exceed the byte budget', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              title: `标题前缀${'长'.repeat(5000)}`,
              url: 'https://example.com',
              description: `摘要前缀${'长'.repeat(5000)}`,
            },
          ],
        }),
      ),
    );
    const result = await search({ query: 'test' }, settings);
    expect(result.results[0]!.title).toMatch(/^标题前缀/);
    expect(result.results[0]!.content).toMatch(/^摘要前缀/);
    expect(Buffer.byteLength(result.results[0]!.title)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(result.results[0]!.content)).toBeLessThanOrEqual(2000);
  });

  it('counts Unicode query characters rather than UTF-16 units', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    await expect(search({ query: '😀'.repeat(1024) }, settings)).resolves.toMatchObject({
      results: [],
    });
    await expect(search({ query: '😀'.repeat(1025) }, settings)).rejects.toThrow('1–1024');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { success: false },
    { errors: [{ message: 'secret upstream error' }] },
    { items: null },
    { items: {} },
  ])('logs malformed or failed response diagnostics without exposing response contents', async (data) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(new Response(JSON.stringify(data)));
    await expect(search({ query: 'test' }, settings)).rejects.toThrow('invalid search response');
    expect(log).toHaveBeenCalledWith(
      '[pi-web-access] Cloudflare returned an invalid search response',
    );
  });
});
