import { beforeEach, describe, expect, it, test, vi } from 'vitest';

// --- Mocks ---

const mockPrepareBrowserProfile = vi.hoisted(() => vi.fn());
const mockStartBrowserReadSession = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));

vi.mock('../profile.js', () => ({ prepareBrowserProfile: mockPrepareBrowserProfile }));
vi.mock('../browser-read-session.js', () => ({
  startBrowserReadSession: mockStartBrowserReadSession,
}));

const mockListAllTools = vi.fn(() =>
  Promise.resolve([
    {
      name: 'click',
      description: 'Click an element.',
      inputSchema: {
        type: 'object' as const,
        properties: { pageId: { type: 'number' as const } },
        required: ['pageId'],
      },
    },
    {
      name: 'take_snapshot',
      description: 'Take snapshot.',
      inputSchema: { type: 'object' as const },
    },
    {
      name: 'take_screenshot',
      description: 'Take screenshot.',
      inputSchema: { type: 'object' as const },
    },
    {
      name: 'lighthouse_audit',
      description: 'Run audit.',
      inputSchema: { type: 'object' as const },
    },
    {
      name: 'navigate_page',
      description: 'Navigate.',
      inputSchema: { type: 'object' as const },
    },
  ]),
);

const mockCallTool = vi.fn((_name: string, _args: Record<string, unknown>, _signal?: AbortSignal) =>
  Promise.resolve({
    content: [{ type: 'text', text: 'Tool result' }],
  }),
);

const mockConnect = vi.fn(() => Promise.resolve());
const mockClose = vi.fn(() => Promise.resolve());
const mockComplete = vi.fn((..._args: any[]) =>
  Promise.resolve({ content: [{ type: 'text', text: 'Visual result' }] }),
);

vi.mock('@earendil-works/pi-ai/compat', () => ({ complete: mockComplete }));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    listTools = vi.fn(() => mockListAllTools().then((tools) => ({ tools, nextCursor: undefined })));
    callTool = vi.fn(
      (
        req: { name: string; arguments: Record<string, unknown> },
        _schema: unknown,
        options?: { signal?: AbortSignal },
      ) => mockCallTool(req.name, req.arguments, options?.signal),
    );
    ping = vi.fn(() => Promise.resolve({}));
    close = mockClose;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    onerror: unknown;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
  };
});

// --- Helpers ---

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}

const registeredTools = new Map<string, RegisteredTool>();
const sessionStartHandlers: Array<(...args: any[]) => Promise<void>> = [];
const sessionShutdownHandlers: Array<() => Promise<void>> = [];

const mockPi = {
  registerTool: vi.fn((tool: RegisteredTool) => {
    registeredTools.set(tool.name, tool);
  }),
  on: vi.fn((event: string, handler: (...args: any[]) => Promise<void>) => {
    if (event === 'session_start') sessionStartHandlers.push(handler);
    if (event === 'session_shutdown') sessionShutdownHandlers.push(handler);
  }),
};

const { default: browserUseExtension } = await import('../index.js');

/** Register the extension and fire session_start. */
async function startExtension(config?: Record<string, unknown>) {
  if (config) {
    const fs = await import('node:fs');
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify({ 'pi-browser-use': config }),
    );
  }

  browserUseExtension(mockPi as any);

  const fakeEvent = { type: 'session_start', reason: 'startup' };
  const fakeCtx = { cwd: process.cwd() };
  for (const handler of sessionStartHandlers) {
    await handler(fakeEvent, fakeCtx);
  }
}

/** Fire all session_shutdown handlers. */
async function shutdownExtension() {
  for (const handler of sessionShutdownHandlers) {
    await handler();
  }
}

// --- Tests ---

describe('browserUseExtension', () => {
  beforeEach(() => {
    delete process.env.PI_BROWSER_USE_RUNTIME_READ_POLICY;
    registeredTools.clear();
    sessionStartHandlers.length = 0;
    sessionShutdownHandlers.length = 0;
    mockPi.registerTool.mockClear();
    mockPi.on.mockClear();
    mockConnect.mockClear();
    mockCallTool.mockClear();
    mockClose.mockClear();
    mockComplete.mockClear();
    mockListAllTools.mockClear();
    mockPrepareBrowserProfile.mockClear();
    mockStartBrowserReadSession.mockClear();
  });

  test('registers session_start and session_shutdown handlers', () => {
    browserUseExtension(mockPi as any);

    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  describe('config loading', () => {
    test('uses defaults when config.json is missing', async () => {
      await startExtension();
      // Should still register tools — no crash
      expect(registeredTools.size).toBeGreaterThan(0);
    });

    test('reads pi-browser-use section from config.json', async () => {
      await startExtension({ headless: true });
      expect(registeredTools.size).toBeGreaterThan(0);
    });

    it('prepares the resolved browser profile before connecting', async () => {
      await startExtension({ sessionMode: 'persistent', userDataDir: '/tmp/test-profile' });

      expect(mockPrepareBrowserProfile).toHaveBeenCalledWith(
        expect.objectContaining({ sessionMode: 'persistent', userDataDir: '/tmp/test-profile' }),
      );
    });

    it('fails closed when runtime read policy is required but absent', async () => {
      process.env.PI_BROWSER_USE_RUNTIME_READ_POLICY = 'required';

      await expect(startExtension()).rejects.toThrow('runtime browser read policy is required');
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  describe('tool registration (session_start)', () => {
    test('connects to chrome-devtools-mcp subprocess', async () => {
      await startExtension();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    test('prefixes all tools with browser_', async () => {
      await startExtension();

      for (const name of registeredTools.keys()) {
        expect(name.startsWith('browser_')).toBe(true);
      }
    });

    test('registers expected upstream tools', async () => {
      await startExtension();

      const names = [...registeredTools.keys()];
      expect(names).toContain('browser_click');
      expect(names).toContain('browser_take_snapshot');
      expect(names).toContain('browser_navigate_page');
    });

    it('preserves required pageId parameters from page-scoped upstream tools', async () => {
      await startExtension();

      const tool = registeredTools.get('browser_click')!;
      expect(tool.parameters).toMatchObject({
        properties: { pageId: { type: 'number' } },
        required: ['pageId'],
      });
      expect(tool.promptSnippet).toContain('browser_list_pages');
      expect(tool.promptGuidelines).toEqual(
        expect.arrayContaining([expect.stringContaining('pageId')]),
      );
    });

    test('excludes lighthouse_audit', async () => {
      await startExtension();

      const names = [...registeredTools.keys()];
      expect(names).not.toContain('browser_lighthouse_audit');
    });

    test('augments tool descriptions with usage hints', async () => {
      await startExtension();

      const clickTool = registeredTools.get('browser_click');
      expect(clickTool!.description).toContain('uid');

      const snapshotTool = registeredTools.get('browser_take_snapshot');
      expect(snapshotTool!.description).toContain('Call this FIRST');
    });

    test('registers analyze_screenshot when visionModel is configured', async () => {
      await startExtension({
        visionModel: { provider: 'openai', model: 'gpt-4o' },
      });

      const tool = registeredTools.get('browser_analyze_screenshot');
      expect(tool).toBeDefined();
      expect(tool!.parameters).toMatchObject({
        properties: { pageId: { type: 'number' } },
        required: ['pageId'],
      });
      expect(tool!.promptSnippet).toContain('browser_list_pages');
    });

    it('omits temperature when the configured vision model uses reasoning', async () => {
      await startExtension({
        visionModel: { provider: 'deepseek-integration', model: 'kimi-k2.6' },
      });
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      } as any);
      const tool = registeredTools.get('browser_analyze_screenshot')!;
      const ctx = {
        modelRegistry: {
          find: vi.fn(() => ({
            id: 'kimi-k2.6',
            provider: 'deepseek-integration',
            reasoning: true,
          })),
          getApiKeyAndHeaders: vi.fn(() => Promise.resolve({ ok: true, apiKey: 'key' })),
        },
      };

      await tool.execute('call-1', { pageId: 7 }, undefined, undefined, ctx);

      const options = mockComplete.mock.calls[0]![2] as Record<string, unknown>;
      expect(options).toMatchObject({ maxTokens: 2048 });
      expect(options).not.toHaveProperty('temperature');
    });

    test('does not register analyze_screenshot without visionModel', async () => {
      await startExtension();

      expect(registeredTools.has('browser_analyze_screenshot')).toBe(false);
    });

    it('returns visual analysis failures as tool errors', async () => {
      await startExtension({
        visionModel: { provider: 'openai', model: 'gpt-4o' },
      });
      const tool = registeredTools.get('browser_analyze_screenshot')!;

      const result = (await tool.execute('call-1', { pageId: 7 }, undefined, undefined, {})) as {
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
    });

    it('forwards the Pi abort signal during visual screenshot capture', async () => {
      await startExtension({
        visionModel: { provider: 'openai', model: 'gpt-4o' },
      });
      const tool = registeredTools.get('browser_analyze_screenshot')!;
      const controller = new AbortController();

      await tool.execute('call-1', { pageId: 7 }, controller.signal, undefined, {});

      expect(mockCallTool).toHaveBeenCalledWith(
        'take_screenshot',
        { pageId: 7 },
        controller.signal,
      );
    });
  });

  describe('tool execution (callTool)', () => {
    test('routes browser_click to upstream click', async () => {
      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      await clickTool.execute('call-1', { pageId: 7, uid: '1_2' }, undefined, undefined, {});

      expect(mockCallTool).toHaveBeenCalledWith('click', { pageId: 7, uid: '1_2' }, undefined);
    });

    it('forwards the Pi abort signal to the browser client', async () => {
      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;
      const controller = new AbortController();

      await clickTool.execute('call-1', {}, controller.signal, undefined, {});

      expect(mockCallTool).toHaveBeenCalledWith('click', {}, controller.signal);
    });

    test('returns upstream text content', async () => {
      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toBe('Tool result');
    });

    it('rejects browser navigation outside the signed read policy before MCP', async () => {
      await startExtension({
        sessionMode: 'existing',
        userDataDir: '/opaque/browser-profile',
        readPolicy: {
          version: 'browser_read_policy_v1',
          accessMode: 'authenticated',
          allowedTopLevelLocators: ['https://private.example/page'],
          allowedTopLevelOrigins: ['https://private.example'],
          subresources: 'public_or_same_origin',
          privateCrossOriginSubresources: 'deny',
          popups: 'deny',
          downloads: 'deny',
          newTargets: 'deny',
        },
      });
      const navTool = registeredTools.get('browser_navigate_page')!;

      await expect(
        navTool.execute(
          'call-1',
          { type: 'url', url: 'https://other.example/' },
          undefined,
          undefined,
          {},
        ),
      ).rejects.toThrow('outside the signed browser read scope');
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('attaches a content-free observation receipt to source read results', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'sensitive page snapshot' }],
      });
      await startExtension({
        sessionMode: 'existing',
        userDataDir: '/opaque/browser-profile',
        readPolicy: {
          version: 'browser_read_policy_v1',
          accessMode: 'authenticated',
          allowedTopLevelLocators: ['https://private.example/page'],
          allowedTopLevelOrigins: ['https://private.example'],
          subresources: 'public_or_same_origin',
          privateCrossOriginSubresources: 'deny',
          popups: 'deny',
          downloads: 'deny',
          newTargets: 'deny',
          observation: { runId: 'run-1', retention: 'source_summary_only_v1' },
        },
      });
      const snapshotTool = registeredTools.get('browser_take_snapshot')!;

      const result = (await snapshotTool.execute(
        'call-1',
        { pageId: 1 },
        undefined,
        undefined,
        {},
      )) as { details: Record<string, unknown> };

      expect(result.details).toMatchObject({
        version: 'source_observation_v1',
        runId: 'run-1',
        toolName: 'browser_take_snapshot',
      });
      expect(JSON.stringify(result.details)).not.toContain('sensitive page snapshot');
    });

    test('strips embedded page snapshot from non-snapshot results', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Clicked\n## Latest page snapshot\n<tree>data</tree>',
          },
        ],
      });

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toContain('Clicked');
      expect(result.content[0]!.text).not.toContain('Latest page snapshot');
    });

    test('returns fallback empty text when upstream returns no content', async () => {
      mockCallTool.mockResolvedValueOnce({ content: [] });

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toBe('');
    });
  });

  describe('tool execution edge cases', () => {
    test('passes isError through from upstream result', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Error: element not found' }],
        isError: true,
      } as any);

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.content[0]!.text).toContain('element not found');
      expect(result.isError).toBe(true);
    });

    test('appends overlay hint for click action blocked by overlay', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Element is not interactable' }],
      });

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toContain('overlay');
    });

    test('appends stale hint when result mentions stale element', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Error: stale element reference' }],
      });

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toContain('take_snapshot');
    });

    test('handles upstream result with multiple text items', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
      });

      await startExtension();
      const navTool = registeredTools.get('browser_navigate_page')!;

      const result = (await navTool.execute(
        'call-1',
        { url: 'http://x' },
        undefined,
        undefined,
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toHaveLength(2);
      expect(result.content[0]!.text).toBe('Line 1');
      expect(result.content[1]!.text).toBe('Line 2');
    });

    test('does not strip snapshot from take_snapshot result', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Snapshot\n## Latest page snapshot\n<tree>data</tree>' }],
      });

      await startExtension();
      const snapshotTool = registeredTools.get('browser_take_snapshot')!;

      const result = (await snapshotTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toContain('Latest page snapshot');
    });

    it('forwards screenshot image content to Pi', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      } as any);

      await startExtension();
      const screenshotTool = registeredTools.get('browser_take_screenshot')!;

      const result = (await screenshotTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; data: string; mimeType: string }>;
      };

      expect(result.content).toEqual([
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ]);
    });
  });

  describe('lifecycle (session_shutdown)', () => {
    test('closes the chrome-devtools-mcp subprocess', async () => {
      await startExtension();
      await shutdownExtension();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    test('no-ops when shutdown called without prior start', async () => {
      browserUseExtension(mockPi as any);

      // Fire shutdown without ever calling session_start
      await shutdownExtension();

      expect(mockClose).not.toHaveBeenCalled();
    });
  });
});
