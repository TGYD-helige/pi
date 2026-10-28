const { piVersion } = vi.hoisted(() => ({ piVersion: { value: '1.2.0' } }));

import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';

// --- Mocks ---

const mockPrepareBrowserProfile = vi.hoisted(() => vi.fn());

vi.mock('../profile.js', () => ({ prepareBrowserProfile: mockPrepareBrowserProfile }));

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
  prepareLoadout?: (loadout: {
    declared: { name: string }[];
  }) => { hiddenDeclarations: readonly string[] } | undefined;
  exposure?: string;
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
const activeTools: string[] = [];

const mockPi = {
  registerTool: vi.fn((tool: RegisteredTool) => {
    registeredTools.set(tool.name, tool);
    // Mirror the runtime: newly registered tools become active by default.
    if (
      (!tool.exposure || tool.exposure === 'direct' || tool.exposure === 'model-only') &&
      !activeTools.includes(tool.name)
    )
      activeTools.push(tool.name);
  }),
  registerCommand: vi.fn(),
  on: vi.fn((event: string, handler: (...args: any[]) => Promise<void>) => {
    if (event === 'session_start') sessionStartHandlers.push(handler);
    if (event === 'session_shutdown') sessionShutdownHandlers.push(handler);
  }),
  getAllTools: () =>
    [...registeredTools.values()].map(({ exposure, ...tool }) => ({
      ...tool,
      ...(piVersion.value === '1.2.0' ? { exposure: exposure ?? 'direct' } : {}),
    })),
  getActiveTools: vi.fn(() => [...activeTools]),
  setActiveTools: vi.fn((names: string[]) => {
    activeTools.length = 0;
    activeTools.push(...names);
  }),
};

const { default: browserUseExtension, BrowserSessionClient } = await import('../index.js');
const fs = await import('node:fs');

/** Register the extension and fire session_start. */
async function startExtension(config?: Record<string, unknown>) {
  if (config) {
    const fs = await import('node:fs');
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify({ 'pi-browser-use': config }),
    );
  }

  activeTools.length = 0;
  activeTools.push('read', 'bash');
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
    vi.mocked(fs.readFileSync)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('ENOENT');
      });
    piVersion.value = '1.2.0';
    registeredTools.clear();
    sessionStartHandlers.length = 0;
    sessionShutdownHandlers.length = 0;
    mockPi.registerTool.mockClear();
    mockPi.registerCommand.mockClear();
    mockPi.on.mockClear();
    mockConnect.mockClear();
    mockCallTool.mockClear();
    mockClose.mockClear();
    mockComplete.mockClear();
    mockListAllTools.mockClear();
    mockPrepareBrowserProfile.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

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
  });

  describe('tool registration (session_start)', () => {
    it('hides session controls after switching from enabled to disabled sessions', async () => {
      vi.spyOn(BrowserSessionClient.prototype, 'connect').mockResolvedValue();
      vi.spyOn(BrowserSessionClient.prototype, 'listAllTools').mockImplementation(mockListAllTools);
      vi.spyOn(BrowserSessionClient.prototype, 'close').mockResolvedValue();
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          'pi-browser-use': { session: { enabled: true, key: 'switch-test', retentionMs: 1000 } },
        }),
      );
      await startExtension();
      expect(mockPi.getActiveTools()).toContain('browser_session');

      await shutdownExtension();
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ 'pi-browser-use': { session: { enabled: false } } }),
      );
      await sessionStartHandlers[0]!({ type: 'session_start' }, { cwd: process.cwd() });

      expect(mockPi.getActiveTools()).not.toContain('browser_session');
      expect(registeredTools.get('browser_session')!.prepareLoadout?.({ declared: [] })).toEqual({
        hiddenDeclarations: ['browser_session'],
      });
    });

    it('cancels slash-command session operations with the Pi context signal', async () => {
      vi.spyOn(BrowserSessionClient.prototype, 'connect').mockResolvedValue();
      vi.spyOn(BrowserSessionClient.prototype, 'listAllTools').mockImplementation(mockListAllTools);
      vi.spyOn(BrowserSessionClient.prototype, 'control').mockImplementation((_action, signal) => {
        if (!signal) return Promise.resolve({ state: 'retained' });
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          'pi-browser-use': { session: { enabled: true, key: 'command-test', retentionMs: 1000 } },
        }),
      );
      await startExtension();
      const command = mockPi.registerCommand.mock.calls.find(
        ([name]) => name === 'browser-session',
      );
      const controller = new AbortController();
      const notify = vi.fn();
      const result = command![1].handler('retain', {
        signal: controller.signal,
        ui: { notify },
      });
      controller.abort();

      await expect(result).rejects.toBe(controller.signal.reason);
      expect(notify).not.toHaveBeenCalled();
    });

    it('keeps session controls disabled for ordinary direct browser connections', async () => {
      await startExtension();
      expect(registeredTools.has('browser_session')).toBe(false);
      expect(mockPi.registerCommand.mock.calls.some(([name]) => name === 'browser-session')).toBe(
        false,
      );
    });

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

    test('registers lighthouse_audit but defers it into its tool group', async () => {
      await startExtension();

      expect(registeredTools.has('browser_lighthouse_audit')).toBe(true);
      expect(mockPi.getActiveTools()).not.toContain('browser_lighthouse_audit');
    });

    describe('deferred tool groups', () => {
      it('keeps manual activation on legacy Pi', async () => {
        piVersion.value = '0.85.1';
        await startExtension();
        expect(registeredTools.get('browser_lighthouse_audit')).not.toHaveProperty('exposure');
        await registeredTools
          .get('browser_tools')!
          .execute('id', { group: 'debugging' }, undefined, undefined, {});
        expect(mockPi.getActiveTools()).toContain('browser_lighthouse_audit');
      });

      it('hides manual discovery only while native tool_search is active', async () => {
        await startExtension();
        const prepare = registeredTools.get('browser_tools')!.prepareLoadout!;
        expect(prepare({ declared: [] })).toBeUndefined();
        expect(prepare({ declared: [{ name: 'tool_search' }] })).toEqual({
          hiddenDeclarations: ['browser_tools'],
        });
        expect(prepare({ declared: [] })).toBeUndefined();
      });

      it('makes optional browser tools natively discoverable without activating them', async () => {
        await startExtension();
        expect(registeredTools.get('browser_lighthouse_audit')).toMatchObject({
          exposure: 'deferred',
          namespace: { name: 'browser' },
        });
        expect(registeredTools.get('browser_click')).toMatchObject({
          exposure: 'direct',
          namespace: { name: 'browser' },
        });
        expect(mockPi.getActiveTools()).not.toContain('browser_lighthouse_audit');
      });
      it('activates only the core profile by default', async () => {
        await startExtension();

        const active = mockPi.getActiveTools();
        expect(active).toContain('browser_click');
        expect(active).toContain('browser_navigate_page');
        expect(active).toContain('browser_take_snapshot');
        expect(active).toContain('browser_tools');
        expect(active).not.toContain('browser_lighthouse_audit');
        expect(active).toContain('read');
        expect(active).toContain('bash');
      });

      it('keeps every upstream tool active with toolProfile full', async () => {
        await startExtension({ toolProfile: 'full' });

        expect(mockPi.getActiveTools()).toContain('browser_lighthouse_audit');
      });

      it('keeps every slim-mode tool active regardless of the profile', async () => {
        mockListAllTools.mockReturnValueOnce(
          Promise.resolve([
            { name: 'navigate', description: 'Navigate.', inputSchema: { type: 'object' } },
            { name: 'evaluate', description: 'Evaluate.', inputSchema: { type: 'object' } },
          ]) as any,
        );
        await startExtension({ slim: true });

        const active = mockPi.getActiveTools();
        expect(active).toContain('browser_navigate');
        expect(active).toContain('browser_evaluate');
      });

      it('lists groups without activating when no group is given', async () => {
        await startExtension();

        const result = (await registeredTools
          .get('browser_tools')!
          .execute('id', {}, undefined, undefined, {})) as any;

        expect(result.isError).not.toBe(true);
        expect(result.content[0].text).toContain('debugging');
        expect(mockPi.getActiveTools()).not.toContain('browser_lighthouse_audit');
      });

      it('activates a group for the following turns', async () => {
        await startExtension();

        const result = (await registeredTools
          .get('browser_tools')!
          .execute('id', { group: 'debugging' }, undefined, undefined, {})) as any;

        expect(result.isError).not.toBe(true);
        expect(result.content[0].text).toContain('browser_lighthouse_audit');
        expect(mockPi.getActiveTools()).toContain('browser_lighthouse_audit');
      });

      it('errors on an unknown group', async () => {
        await startExtension();

        const result = (await registeredTools
          .get('browser_tools')!
          .execute('id', { group: 'nope' }, undefined, undefined, {})) as any;

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unknown group');
      });

      it('activates a group via the slash command', async () => {
        await startExtension();
        const command = mockPi.registerCommand.mock.calls.find((c) => c[0] === 'browser-tools');
        const notify = vi.fn();

        await (command![1] as any).handler('debugging', { ui: { notify } });

        expect(mockPi.getActiveTools()).toContain('browser_lighthouse_audit');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('debugging'), 'info');
      });
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
