import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import piWebToolExtension from '../index.js';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadWebToolSettings: vi.fn(),
  };
});

vi.mock('../search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../search.js')>();
  return {
    ...actual,
    search: vi.fn(),
  };
});

import { loadWebToolSettings } from '../config.js';
import { search } from '../search.js';

const mockLoadSettings = vi.mocked(loadWebToolSettings);
const mockSearch = vi.mocked(search);

function createMockPi() {
  const tools: Array<{ name: string; description: string }> = [];
  const commands: Map<string, unknown> = new Map();
  // biome-ignore lint/complexity/noBannedTypes: mock helper
  const listeners: Record<string, Function> = {};
  return {
    tools,
    commands,
    listeners,
    registerTool(tool: { name: string; description: string }) {
      tools.push(tool);
    },
    registerCommand(name: string, opts: unknown) {
      commands.set(name, opts);
    },
    // biome-ignore lint/complexity/noBannedTypes: mock helper
    on(event: string, handler: Function) {
      listeners[event] = handler;
    },
    async triggerSessionStart(cwd = '/test') {
      const ctx = { cwd } as any;
      await listeners.session_start!({}, ctx);
    },
  };
}

describe('piWebToolExtension - tool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['x_search', 'xai'],
    ['image_search', 'unsplash'],
    ['image_search', 'dashscope'],
  ] as const)('propagates %s cancellation through %s to fetch', async (name, provider) => {
    mockLoadSettings.mockReturnValue({
      imageSearch: { provider },
      providers: { [provider]: { apiKey: 'fixture' } },
    } as any);
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, options) => {
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetch);
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const tool = pi.tools.find((item) => item.name === name) as any;
    await expect(
      tool.execute('id', { query: 'Pi' }, controller.signal, undefined, {}),
    ).rejects.toBe(controller.signal.reason);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('propagates image-search command cancellation to the request', async () => {
    mockLoadSettings.mockReturnValue({
      imageSearch: { provider: 'unsplash' },
      providers: { unsplash: { apiKey: 'fixture' } },
    });
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        requestSignal = options.signal;
        return { ok: true, json: async () => ({ results: [] }) };
      }),
    );
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    await (pi.commands.get('image-search') as any).handler('Pi', {
      signal: controller.signal,
      ui: { notify: vi.fn() },
    });
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('sanitizes image-search command failures and logs a safe diagnostic', async () => {
    mockLoadSettings.mockReturnValue({
      imageSearch: { provider: 'unsplash' },
      providers: { unsplash: { apiKey: 'fixture' } },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Bearer private-token')));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pi = createMockPi();
      piWebToolExtension(pi as any);
      await pi.triggerSessionStart();
      const notify = vi.fn();
      await (pi.commands.get('image-search') as any).handler('Pi', { ui: { notify } });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('image-search failed'), 'error');
      expect(JSON.stringify(notify.mock.calls)).not.toContain('private-token');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[pi-web-access]'));
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    'web_search',
    'web_fetch',
    'x_search',
    'image_search',
  ])('preserves a safe timeout classification for %s', async (name) => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'tavily' },
      fetch: { provider: 'tavily' },
      imageSearch: { provider: 'unsplash' },
      providers: {
        tavily: { apiKey: 'fixture' },
        xai: { apiKey: 'fixture' },
        unsplash: { apiKey: 'fixture' },
      },
    });
    const error = new DOMException('private-token https://private.invalid', 'TimeoutError');
    mockSearch.mockRejectedValue(error);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pi = createMockPi();
      piWebToolExtension(pi as any);
      await pi.triggerSessionStart();
      const tool = pi.tools.find((item) => item.name === name) as any;
      const result = await tool.execute(
        'id',
        { query: 'Pi', url: 'https://1.1.1.1/fixture', prompt: 'full' },
        undefined,
        undefined,
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent.errorCategory).toBe('timeout');
      expect(result.content[0].text).toContain('timed out');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('category=timeout'));
      expect(JSON.stringify([result, log.mock.calls])).not.toMatch(
        /private-token|private\.invalid/,
      );
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    [new Error('Tavily API error 429: private-token'), 'http_error', 429],
    [new Error('HTTP 401: private-token'), 'http_error', 401],
    [new Error('Tavily API error 503: private-token'), 'http_error', 503],
    [new Error('private-token'), 'request_failed', undefined],
    [new Error('private-token timeout in a response body'), 'request_failed', undefined],
    ['private-token', 'request_failed', undefined],
    [Object.assign(new Error('private-token'), { code: 'ETIMEDOUT' }), 'timeout', undefined],
    [
      new TypeError('private-token', {
        cause: Object.assign(new Error('private-token'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      }),
      'timeout',
      undefined,
    ],
  ])('classifies search failures without exposing raw data (%s)', async (error, category, status) => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'fixture' } },
    });
    mockSearch.mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pi = createMockPi();
      piWebToolExtension(pi as any);
      await pi.triggerSessionStart();
      const result = await (pi.tools.find((tool) => tool.name === 'web_search') as any).execute(
        'id',
        { query: 'Pi' },
        undefined,
        undefined,
        {},
      );
      expect(result.structuredContent.errorCategory).toBe(category);
      expect(result.structuredContent.httpStatus).toBe(status);
      expect(JSON.stringify([result, log.mock.calls])).not.toContain('private-token');
      if (category !== 'timeout') expect(result.content[0].text).not.toContain('timed out');
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    'tavily',
    'cloudflare',
  ])('classifies the actual %s request deadline at the tool boundary', async (provider) => {
    mockLoadSettings.mockReturnValue({
      search: { provider },
      timeoutMs: 1,
      providers: { [provider]: { apiKey: 'fixture', accountId: 'fixture' } },
    } as any);
    const actual = await vi.importActual<typeof import('../search.js')>('../search.js');
    mockSearch.mockImplementationOnce(actual.search);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pi = createMockPi();
      piWebToolExtension(pi as any);
      await pi.triggerSessionStart();
      const result = await (pi.tools.find((tool) => tool.name === 'web_search') as any).execute(
        'id',
        { query: 'Pi' },
        undefined,
        undefined,
        {},
      );
      expect(result.structuredContent.errorCategory).toBe('timeout');
      expect(result.content[0].text).toContain('timed out');
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    'web-search',
    'web-fetch',
    'image-search',
  ])('reports request timeouts through /%s', async (name) => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'tavily' },
      fetch: { provider: 'tavily' },
      imageSearch: { provider: 'unsplash' },
      providers: { tavily: { apiKey: 'fixture' }, unsplash: { apiKey: 'fixture' } },
    });
    const reason = new DOMException('private-token', 'TimeoutError');
    mockSearch.mockRejectedValue(reason);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(reason));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pi = createMockPi();
      piWebToolExtension(pi as any);
      await pi.triggerSessionStart();
      const notify = vi.fn();
      await (pi.commands.get(name) as any).handler(
        name === 'web-fetch' ? 'https://1.1.1.1/fixture' : 'Pi',
        { ui: { notify } },
      );
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'error');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('category=timeout'));
      expect(JSON.stringify([notify.mock.calls, log.mock.calls])).not.toContain('private-token');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the exact safe remediation for missing provider configuration', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'cloudflare' },
      providers: { cloudflare: { apiKey: 'fixture' } },
    });
    const actual = await vi.importActual<typeof import('../search.js')>('../search.js');
    mockSearch.mockImplementationOnce(actual.search);
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const result = await (pi.tools.find((tool) => tool.name === 'web_search') as any).execute(
      'id',
      { query: 'Pi' },
      undefined,
      undefined,
      {},
    );
    expect(result.structuredContent.errorCategory).toBe('configuration_error');
    expect(result.content[0].text).toContain('CLOUDFLARE_ACCOUNT_ID');
  });

  it('returns search objects alongside readable source links', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'cloudflare' },
      providers: { cloudflare: { apiKey: 'key', accountId: 'account' } },
    });
    mockSearch.mockResolvedValue({
      provider: 'cloudflare',
      query: 'Pi',
      results: [{ title: 'Pi docs', url: 'https://pi.dev', content: 'Extensions' }],
    });
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const tool = pi.tools.find((item) => item.name === 'web_search') as any;
    const result = await tool.execute('id', { query: 'Pi' }, undefined, undefined, {});
    expect(tool.outputSchema).toBeDefined();
    expect(result.structuredContent).toEqual({
      provider: 'cloudflare',
      query: 'Pi',
      results: [{ title: 'Pi docs', url: 'https://pi.dev', content: 'Extensions' }],
      truncated: false,
    });
    expect(result.content[0].text).toContain('[Pi docs](https://pi.dev)');
  });
  it('keeps a long fetched body in readable output as well as structured content', async () => {
    mockLoadSettings.mockReturnValue({
      fetch: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'fixture' } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ url: 'https://1.1.1.1/fixture', raw_content: 'fetch '.repeat(10000) }],
          failed_results: [],
        }),
      }),
    );
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const result = await (pi.tools.find((item) => item.name === 'web_fetch') as any).execute(
      'id',
      { url: 'https://1.1.1.1/fixture', prompt: 'full' },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain('fetch fetch');
    expect(result.structuredContent.content).toMatch(/^fetch /);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
  });

  it('keeps long single-line search snippets in both readable and structured results', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'cloudflare' },
      providers: { cloudflare: { apiKey: 'fixture', accountId: 'fixture' } },
    });
    mockSearch.mockResolvedValue({
      provider: 'cloudflare',
      query: 'Pi',
      answer: 'answer '.repeat(1000),
      results: [
        { title: 'title '.repeat(100), url: 'https://pi.dev', content: 'snippet '.repeat(300) },
      ],
    });
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const result = await (pi.tools.find((item) => item.name === 'web_search') as any).execute(
      'id',
      { query: 'Pi' },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain('snippet snippet');
    expect(result.content[0].text).toContain('answer answer');
    expect(result.structuredContent.results[0].content).toMatch(/^snippet /);
    expect(result.structuredContent.results[0].title).toMatch(/^title /);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
  });

  it('propagates cancellation instead of returning a structured failure', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'cloudflare' },
      providers: { cloudflare: { apiKey: 'key', accountId: 'account' } },
    });
    const controller = new AbortController();
    controller.abort();
    mockSearch.mockRejectedValue(controller.signal.reason);
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const tool = pi.tools.find((item) => item.name === 'web_search') as any;
    await expect(
      tool.execute('id', { query: 'Pi' }, controller.signal, undefined, {}),
    ).rejects.toBe(controller.signal.reason);
  });
  it('returns safe structured errors without raw provider data', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'key' } },
    });
    mockSearch.mockRejectedValue(new Error('HTTP 401: Bearer private-token'));
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const result = await (pi.tools.find((item) => item.name === 'web_search') as any).execute(
      'id',
      { query: 'Pi' },
      undefined,
      undefined,
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('HTTP 401');
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('registers web_search when search.provider is configured with key', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('web_search');
  });

  it('enables Cloudflare search and a matching slash command', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'cloudflare' },
      providers: { cloudflare: { apiKey: 'cf-token', accountId: 'account-123' } },
    });
    mockSearch.mockResolvedValue({ provider: 'cloudflare', query: 'Workers', results: [] });
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    expect(pi.tools.map((tool) => tool.name)).toContain('web_search');
    const command = pi.commands.get('web-search') as {
      handler: (args: string, ctx: any) => Promise<void>;
    };
    expect(command).toBeDefined();
    const notify = vi.fn();
    const signal = new AbortController().signal;
    await command.handler('Workers', { ui: { notify }, signal });
    expect(mockSearch).toHaveBeenCalledWith({ query: 'Workers' }, expect.any(Object), signal);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('cloudflare'), 'info');
  });

  it('does not register web_search when no provider configured', async () => {
    mockLoadSettings.mockReturnValue({});

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).not.toContain('web_search');
  });

  it('does not register web_search when provider has no key', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'tavily' },
      providers: { tavily: {} },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).not.toContain('web_search');
  });

  it('registers web_fetch when fetch.provider is configured', async () => {
    mockLoadSettings.mockReturnValue({
      fetch: { provider: 'zai' },
      providers: { zai: { apiKey: 'key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('web_fetch');
    expect(pi.tools.find((t) => t.name === 'web_fetch')!.description).toContain(
      'prompt is not applied',
    );
  });

  it('offers web-fetch with bounded output and sanitized failures', async () => {
    mockLoadSettings.mockReturnValue({
      fetch: { provider: 'deepseek' },
      providers: { deepseek: { apiKey: 'fixture' } },
    });
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'Page', content: 'Body'.repeat(20000) }),
    });
    vi.stubGlobal('fetch', request);
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const command = pi.commands.get('web-fetch') as {
      handler: (args: string, ctx: any) => Promise<void>;
    };
    const notify = vi.fn();
    await command.handler('', { ui: { notify } });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('Usage:'), 'warning');
    await command.handler('https://93.184.216.34 Explain this page', { ui: { notify } });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('Page'), 'info');
    expect(Buffer.byteLength(notify.mock.calls.at(-1)![0])).toBeLessThan(20000);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      request.mockRejectedValueOnce(new Error('private-token'));
      await command.handler('https://93.184.216.34', { ui: { notify } });
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringContaining('DeepSeek fetch request failed.'),
        'error',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
    } finally {
      log.mockRestore();
    }
  });

  it('registers web_fetch when fetch.summary is configured (no fetch.provider)', async () => {
    mockLoadSettings.mockReturnValue({
      fetch: { summary: { provider: 'amaster', model: 'deepseek-v4-flash' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('web_fetch');
    expect(pi.tools.find((t) => t.name === 'web_fetch')!.description).toContain(
      'configured summary model',
    );
  });

  it('does not register web_fetch when fetch is empty', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).not.toContain('web_fetch');
  });

  it('does not register web_fetch when nothing configured', async () => {
    mockLoadSettings.mockReturnValue({});

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).not.toContain('web_fetch');
  });

  it('registers both tools when both configured', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      fetch: { provider: 'zai', summary: { provider: 'amaster', model: 'deepseek-v4-flash' } },
      providers: {
        kimi: { apiKey: 'kimi-key' },
        zai: { apiKey: 'zai-key' },
      },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('web_search');
    expect(pi.tools.map((t) => t.name)).toContain('web_fetch');
  });

  it('registers no tools when settings is empty', async () => {
    mockLoadSettings.mockReturnValue({});

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools).toHaveLength(0);
  });

  it('registers x_search when xai provider has key', async () => {
    mockLoadSettings.mockReturnValue({
      providers: { xai: { apiKey: 'xai-key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('x_search');
  });

  it('does not register x_search when xai has no key', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).not.toContain('x_search');
  });

  it('registers x_search alongside web_search when both configured', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: {
        kimi: { apiKey: 'kimi-key' },
        xai: { apiKey: 'xai-key' },
      },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('web_search');
    expect(pi.tools.map((t) => t.name)).toContain('x_search');
  });

  it('registers image_search when dashscope provider has key', async () => {
    mockLoadSettings.mockReturnValue({
      providers: { dashscope: { apiKey: 'dashscope-key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('image_search');
    expect(pi.commands.has('image-search')).toBe(true);
  });

  it('registers image_search when unsplash provider has key', async () => {
    mockLoadSettings.mockReturnValue({
      providers: { unsplash: { apiKey: 'unsplash-key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('image_search');
    expect(pi.commands.has('image-search')).toBe(true);
  });

  it('does not register image_search when dashscope has no key', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'key' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).not.toContain('image_search');
    expect(pi.commands.has('image-search')).toBe(false);
  });
});

describe('piWebToolExtension - web_search output formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSettings.mockReturnValue({
      search: { provider: 'deepseek' },
      providers: { deepseek: { apiKey: 'key' } },
    });
  });

  async function executeWebSearch() {
    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const tool = pi.tools.find((t) => t.name === 'web_search') as any;
    const result = await tool.execute('id', { query: 'q' }, undefined, undefined, {});
    return result.content[0].text as string;
  }

  it('states explicitly when the provider returns no answer and no results', async () => {
    mockSearch.mockResolvedValue({
      provider: 'deepseek',
      query: 'q',
      answer: undefined,
      results: [],
    });

    const text = await executeWebSearch();

    expect(text).toContain('## Web Search Results (deepseek)');
    expect(text).toContain('No results returned by the provider');
  });

  it('notes the missing answer when only sources were gathered', async () => {
    mockSearch.mockResolvedValue({
      provider: 'deepseek',
      query: 'q',
      answer: undefined,
      results: [{ title: 'https://example.com/', url: 'https://example.com/', content: '' }],
    });

    const text = await executeWebSearch();

    expect(text).toContain('did not generate an answer');
    expect(text).toContain('### Sources');
    expect(text).toContain('[https://example.com/](https://example.com/)');
  });
});
