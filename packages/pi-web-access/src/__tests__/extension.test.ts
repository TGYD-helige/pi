import { beforeEach, describe, expect, it, vi } from 'vitest';
import piWebToolExtension from '../index.js';

const mockWebFetch = vi.hoisted(() =>
  vi.fn(async ({ url }: { url: string }) => ({
    url,
    title: 'Private Page',
    content: 'sensitive source body',
  })),
);

vi.mock('../fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fetch.js')>()),
  webFetch: mockWebFetch,
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadWebToolSettings: vi.fn(),
  };
});

import { loadWebToolSettings } from '../config.js';

const mockLoadSettings = vi.mocked(loadWebToolSettings);

function createMockPi() {
  const tools: Array<{
    name: string;
    execute?: (...args: any[]) => Promise<unknown>;
  }> = [];
  // biome-ignore lint/complexity/noBannedTypes: mock helper
  const listeners: Record<string, Function> = {};
  return {
    tools,
    listeners,
    registerTool(tool: { name: string }) {
      tools.push(tool);
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
  });

  it('returns a content-free observation receipt for source retention mode', async () => {
    mockLoadSettings.mockReturnValue({
      fetch: {
        mode: 'local_only',
        provider: 'zai',
        observation: { runId: 'run-1', retention: 'source_summary_only_v1' },
      },
      providers: { zai: { apiKey: 'configured' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();
    const fetchTool = pi.tools.find((tool) => tool.name === 'web_fetch')!;
    const result = (await fetchTool.execute!(
      'call-1',
      { url: 'https://example.com/private?token=secret', prompt: 'summarize' },
      undefined,
      undefined,
      {},
    )) as { details: Record<string, unknown> };

    expect(result.details).toMatchObject({
      version: 'source_observation_v1',
      runId: 'run-1',
      toolName: 'web_fetch',
      requestedLocator: 'https://example.com/private',
    });
    expect(JSON.stringify(result.details)).not.toContain('secret');
  });

  it('registers web_fetch when fetch.summary is configured (no fetch.provider)', async () => {
    mockLoadSettings.mockReturnValue({
      fetch: { summary: { provider: 'amaster', model: 'deepseek-v4-flash' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart();

    expect(pi.tools.map((t) => t.name)).toContain('web_fetch');
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
});
