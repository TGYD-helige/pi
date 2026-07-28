import { beforeEach, describe, expect, it, vi } from 'vitest';
import piWebToolExtension from '../index.js';

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
  const tools: Array<{ name: string }> = [];
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
    async triggerSessionStart(cwd = '/test', context: Record<string, unknown> = {}) {
      const ctx = { cwd, ...context } as any;
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

  it('registers web_search with runtime auth from the session model registry', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: { kimi: { runtimeAuthProvider: 'amaster' } },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart('/test', {
      modelRegistry: {
        getAll: () => [{ provider: 'amaster', baseUrl: 'https://company-a.example/v1' }],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'company-a-key' }),
      },
    });

    expect(pi.tools.map((t) => t.name)).toContain('web_search');
  });

  it('does not register runtime-auth search when session auth is unavailable', async () => {
    mockLoadSettings.mockReturnValue({
      search: { provider: 'kimi' },
      providers: {
        kimi: {
          apiKey: 'stale-shared-key',
          runtimeAuthProvider: 'amaster',
        },
      },
    });

    const pi = createMockPi();
    piWebToolExtension(pi as any);
    await pi.triggerSessionStart('/test', {
      modelRegistry: {
        getAll: () => [],
        getApiKeyAndHeaders: vi.fn(),
      },
    });

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
