import { beforeEach, describe, expect, test, vi } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

vi.mock('../config.js', () => ({
  loadChannelConfig: vi.fn(() => ({
    adapters: {
      webhook: { type: 'webhook' },
    },
    routes: {
      ops: { adapter: 'webhook', recipient: 'https://example.test/hook' },
    },
    bridge: { enabled: false },
  })),
  updateLocalChannelConfig: vi.fn((_cwd: string, update: (config: unknown) => unknown) => {
    update({
      adapters: {
        feishu: { type: 'feishu' },
      },
      routes: {
        ops: { adapter: 'feishu', recipient: '' },
      },
      bridge: { enabled: true },
    });
    return true;
  }),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const events = new Map<string, (raw: unknown) => unknown>();
const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
const commands = new Map<
  string,
  { handler: (args: string | undefined, ctx: unknown) => Promise<void> }
>();

const mockPi = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(event, handler);
  }),
  events: {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (raw: unknown) => unknown) => {
      events.set(event, handler);
    }),
  },
  registerMcpServer: vi.fn(),
  registerTool: vi.fn(
    (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
    },
  ),
  registerCommand: vi.fn(
    (
      name: string,
      command: { handler: (args: string | undefined, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
  ),
};

const { default: piChannelsExtension } = await import('../index.js');
const configModule = await import('../config.js');

function mockCtx(projectTrusted = true) {
  return {
    cwd: '/workspace',
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

describe('piChannelsExtension', () => {
  beforeEach(() => {
    handlers.clear();
    events.clear();
    tools.clear();
    commands.clear();
    mockPi.on.mockClear();
    mockPi.events.emit.mockClear();
    mockPi.events.on.mockClear();
    mockPi.registerTool.mockClear();
    mockPi.registerCommand.mockClear();
    vi.mocked(configModule.loadChannelConfig).mockClear();
    vi.mocked(configModule.updateLocalChannelConfig).mockClear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    safeFetchMock.mockReset();
    safeFetchMock.mockImplementation((input, init) => globalThis.fetch(input, init));
  });

  test('registers lifecycle handlers, events, command, and notify tool', () => {
    piChannelsExtension(mockPi as never);

    expect(handlers.has('session_start')).toBe(true);
    expect(handlers.has('session_shutdown')).toBe(true);
    expect(events.has('channel:send')).toBe(true);
    expect(events.has('channel:register')).toBe(true);
    expect(events.has('channel:list')).toBe(true);
    expect(events.has('channel:status')).toBe(true);
    expect(events.has('channel:capture')).toBe(true);
    expect(events.has('channel:reload')).toBe(true);
    expect(commands.has('channel')).toBe(true);
    expect(tools.has('notify')).toBe(true);
  });

  test('notify list shows configured adapters and routes after session_start', async () => {
    piChannelsExtension(mockPi as never);
    const ctx = mockCtx();
    await handlers.get('session_start')?.({}, ctx);

    const result = (await tools.get('notify')?.execute('call-1', { action: 'list' })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toContain('webhook adapter');
    expect(result.content[0]!.text).toContain(
      'ops route -> webhook -> https://example.test/[redacted]',
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-channels', 'channels: 1');
  });

  test('notify list does not expose webhook path or query credentials', async () => {
    vi.mocked(configModule.loadChannelConfig).mockReturnValueOnce({
      adapters: { webhook: { type: 'webhook' } },
      routes: {
        ops: {
          adapter: 'webhook',
          recipient: 'https://example.test/hooks/path-secret?token=query-secret',
        },
      },
      bridge: { enabled: false },
    });
    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'list-routes',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toContain('https://example.test/[redacted]');
    expect(result.content[0]!.text).not.toContain('path-secret');
    expect(result.content[0]!.text).not.toContain('query-secret');
  });

  test('notify supports route and adapter list action aliases', async () => {
    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const routeResult = (await tools.get('notify')?.execute('call-1', {
      action: 'list-routes',
    })) as { content: Array<{ text: string }> };
    const adapterResult = (await tools.get('notify')?.execute('call-2', {
      action: 'list-adapters',
    })) as { content: Array<{ text: string }> };

    expect(routeResult.content[0]!.text).toContain(
      'ops route -> webhook -> https://example.test/[redacted]',
    );
    expect(routeResult.content[0]!.text).not.toContain('webhook adapter');
    expect(adapterResult.content[0]!.text).toContain('webhook adapter');
    expect(adapterResult.content[0]!.text).not.toContain('ops route');
  });

  test('channel:reload reloads config for the active session', async () => {
    const loadChannelConfig = vi.mocked(configModule.loadChannelConfig);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    const callback = vi.fn();
    events.get('channel:reload')?.({ callback });

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({ ok: true });
    });
    expect(loadChannelConfig).toHaveBeenCalledTimes(2);
  });

  test('channel:reload reports when no session is active', async () => {
    piChannelsExtension(mockPi as never);
    const callback = vi.fn();

    events.get('channel:reload')?.({ callback });

    expect(callback).toHaveBeenCalledWith({
      ok: false,
      error: 'pi-channels session is not active.',
    });
  });

  test('channel:reload can activate from a host-provided cwd', async () => {
    piChannelsExtension(mockPi as never);
    const callback = vi.fn();

    events.get('channel:reload')?.({ cwd: '/workspace', callback });

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({ ok: true });
    });
    const statusCallback = vi.fn();
    events.get('channel:status')?.({ callback: statusCallback });
    expect(statusCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        active: true,
        cwd: '/workspace',
      }),
    );
  });

  test('channel:send can send with scoped config without loading unrelated adapters', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    const callback = vi.fn();

    events.get('channel:send')?.({
      adapter: 'ops',
      recipient: '',
      text: 'hello',
      config: {
        adapters: {
          webhook: { type: 'webhook' },
          broken: { type: 'missing-adapter' },
        },
        routes: {
          ops: { adapter: 'webhook', recipient: 'https://example.test/hook' },
          brokenOps: { adapter: 'broken', recipient: 'unused' },
        },
      },
      cwd: '/workspace',
      callback,
    });

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({ ok: true });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('channel:status reports active session health', async () => {
    piChannelsExtension(mockPi as never);
    const inactiveCallback = vi.fn();

    events.get('channel:status')?.({ callback: inactiveCallback });

    expect(inactiveCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        active: false,
        bridgeActive: false,
      }),
    );

    await handlers.get('session_start')?.({}, mockCtx());
    const activeCallback = vi.fn();

    events.get('channel:status')?.({ callback: activeCallback });

    expect(activeCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        active: true,
        cwd: '/workspace',
        bridgeActive: false,
        adapterStates: expect.objectContaining({
          webhook: expect.objectContaining({ state: 'connected' }),
        }),
      }),
    );
    expect(activeCallback.mock.calls[0]?.[0]).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'webhook', type: 'adapter' }),
        expect.objectContaining({ name: 'ops', type: 'route' }),
      ]),
    });
  });

  test('session_start can skip channel autostart when managed by the host app', async () => {
    vi.stubEnv('PI_CHANNELS_DISABLE_SESSION_AUTOSTART', '1');
    piChannelsExtension(mockPi as never);

    await handlers.get('session_start')?.({}, mockCtx());
    const callback = vi.fn();
    events.get('channel:status')?.({ callback });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        active: false,
        bridgeActive: false,
      }),
    );
    expect(configModule.loadChannelConfig).not.toHaveBeenCalled();
  });

  test('channel:reload preserves project trust when session autostart is disabled', async () => {
    vi.stubEnv('PI_CHANNELS_DISABLE_SESSION_AUTOSTART', '1');
    piChannelsExtension(mockPi as never);

    await handlers.get('session_start')?.({}, mockCtx(true));
    const callback = vi.fn();
    events.get('channel:reload')?.({ callback });

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({ ok: true });
    });
    expect(configModule.loadChannelConfig).toHaveBeenCalledWith('/workspace', true);
  });

  test('channel:capture resolves with matching incoming token', async () => {
    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    const callback = vi.fn();

    events.get('channel:capture')?.({
      adapter: 'feishu',
      captureToken: 'capture-token',
      timeoutMs: 5_000,
      callback,
    });
    events.get('channel:register')?.({
      name: 'feishu',
      adapter: {
        direction: 'bidirectional',
        start: (onMessage: (message: unknown) => void) => {
          onMessage({
            adapter: 'feishu',
            sender: 'oc_group',
            text: 'hello capture-token',
            metadata: {
              chatId: 'oc_group',
            },
          });
          return Promise.resolve();
        },
      },
    });

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({
        ok: true,
        message: expect.objectContaining({
          adapter: 'feishu',
          sender: 'oc_group',
          text: 'hello capture-token',
        }),
      });
    });
  });

  test('emits channel:turn for incoming bridge messages', async () => {
    vi.mocked(configModule.loadChannelConfig).mockReturnValueOnce({
      adapters: {
        feishu: { type: 'feishu' },
      },
      routes: {},
      bridge: { enabled: true },
    });
    const send = vi.fn(() => Promise.resolve());

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    events.get('channel:register')?.({
      name: 'feishu',
      adapter: {
        direction: 'bidirectional',
        send,
        start: (onMessage: (message: unknown) => void) => {
          onMessage({
            adapter: 'feishu',
            sender: 'oc_group:user',
            text: '/status',
            metadata: {
              chatId: 'oc_group',
              chatName: '测试群',
            },
          });
          return Promise.resolve();
        },
      },
    });

    await vi.waitFor(() => {
      expect(mockPi.events.emit).toHaveBeenCalledWith(
        'channel:turn',
        expect.objectContaining({
          sessionId: 'oc_group',
          adapter: 'feishu',
          recipient: 'oc_group',
          userMessage: '/status',
          title: '测试群',
        }),
      );
    });
  });

  test('notify send routes through webhook aliases', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: 'ops',
      text: 'hello',
      source: 'unit',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe('Sent via "ops".');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      text: 'hello',
      source: 'unit',
      timestamp: expect.any(String),
    });
  });

  test('reports a missing raw payload without attempting webhook delivery', async () => {
    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')!({}, mockCtx());
    const result = await tools
      .get('notify')!
      .execute('notify', { action: 'send', adapter: 'ops', payloadMode: 'raw', method: 'POST' });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          text: '[invalid_request] The request was rejected before sending. Set json for a webhook raw payload or use envelope mode.',
        },
      ],
      structuredContent: { error: { code: 'invalid_request' } },
    });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('notify rejects local channels plugin selector as a send target', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: '@local:channels',
      text: 'hello',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe(
      '[invalid_adapter] @local:channels selects the plugin, not a route. Use one of these channel route mentions: @local:channels_webhook:ops.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('notify maps provider-scoped local channel route mentions to route aliases', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: '@local:channels_webhook:ops',
      text: 'hello',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe('Sent via "ops".');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('notify maps split local channel provider and recipient route aliases to routes', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: 'local:channels_webhook',
      recipient: 'ops',
      text: 'hello',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe('Sent via "ops" to ops.');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('notify maps adapter plus recipient route aliases to routes', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: 'webhook',
      recipient: 'ops',
      text: 'hello',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe('Sent via "ops" to ops.');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('notify rejects provider-scoped local channel route mentions with the wrong adapter', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: '@local:channels_wecom:ops',
      text: 'hello',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe(
      '[invalid_adapter] Channel route "ops" uses adapter "webhook", not "wecom".',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('channel:register can add runtime adapters and channel:send can use them', async () => {
    const send = vi.fn(() => Promise.resolve());
    const callback = vi.fn();

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    events.get('channel:register')?.({
      name: 'custom',
      adapter: { direction: 'outgoing', send },
      callback,
    });

    expect(callback).toHaveBeenCalledWith(true);
    await events.get('channel:send')?.({
      adapter: 'custom',
      recipient: 'room',
      text: 'hello',
      callback,
    });

    expect(send).toHaveBeenCalledWith({
      adapter: 'custom',
      recipient: 'room',
      text: 'hello',
    });
  });

  test('incoming messages fill the only empty route recipient for that adapter', async () => {
    const updateLocalChannelConfig = vi.mocked(configModule.updateLocalChannelConfig);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    events.get('channel:register')?.({
      name: 'feishu',
      adapter: {
        direction: 'bidirectional',
        start: (onMessage: (message: unknown) => void) => {
          onMessage({
            adapter: 'feishu',
            sender: 'oc_group',
            text: 'hello',
            metadata: {
              chatId: 'oc_group',
            },
          });
          return Promise.resolve();
        },
      },
    });

    expect(updateLocalChannelConfig).toHaveBeenCalled();
    const update = updateLocalChannelConfig.mock.calls.at(-1)?.[1];
    expect(
      update?.({
        adapters: {
          feishu: { type: 'feishu' },
        },
        routes: {
          ops: { adapter: 'feishu', recipient: '' },
        },
        bridge: { enabled: true },
      }),
    ).toMatchObject({
      routes: {
        ops: { adapter: 'feishu', recipient: 'oc_group', capture: false },
      },
    });
  });

  test('incoming messages fill the pending capture route when multiple routes are empty', async () => {
    const updateLocalChannelConfig = vi.mocked(configModule.updateLocalChannelConfig);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    events.get('channel:register')?.({
      name: 'feishu',
      adapter: {
        direction: 'bidirectional',
        start: (onMessage: (message: unknown) => void) => {
          onMessage({
            adapter: 'feishu',
            sender: 'oc_group_2',
            text: 'hello',
            metadata: {
              chatId: 'oc_group_2',
              chatName: '二号群',
            },
          });
          return Promise.resolve();
        },
      },
    });

    const update = updateLocalChannelConfig.mock.calls.at(-1)?.[1];
    expect(
      update?.({
        adapters: {
          feishu: { type: 'feishu' },
        },
        routes: {
          ops: { adapter: 'feishu', recipient: '' },
          ops2: { adapter: 'feishu', recipient: '', capture: true },
        },
        bridge: { enabled: true },
      }),
    ).toMatchObject({
      routes: {
        ops: { adapter: 'feishu', recipient: '' },
        ops2: {
          adapter: 'feishu',
          recipient: 'oc_group_2',
          name: '二号群',
          capture: false,
        },
      },
    });
  });
});
