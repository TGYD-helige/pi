import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(pi.tools.find((t) => t.name === 'web_fetch')!.description).toContain(
      'prompt is not applied',
    );
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
