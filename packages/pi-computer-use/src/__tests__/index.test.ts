const { piVersion } = vi.hoisted(() => ({ piVersion: { value: '1.2.0' } }));

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toolManifest from '../generated/cua-driver-tools.js';

Object.defineProperty(process, 'platform', { value: 'darwin' });

type UpstreamResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type LiveTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

function abortableDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let markStarted!: () => void;
  let signal: AbortSignal | undefined;
  let aborted = false;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const started = new Promise<void>((resolveStarted) => {
    markStarted = resolveStarted;
  });
  return {
    started,
    wait(nextSignal?: AbortSignal) {
      signal = nextSignal;
      const onAbort = () => {
        aborted = true;
        reject(signal?.reason);
      };
      signal?.aborted ? onAbort() : signal?.addEventListener('abort', onAbort, { once: true });
      markStarted();
      return promise;
    },
    resolve,
    get aborted() {
      return aborted;
    },
  };
}

let mockConfigContent: string | null = null;
let mockConnect: (signal?: AbortSignal) => Promise<void> = async () => {};
let mockCallTool: (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => UpstreamResult | Promise<UpstreamResult> = () => ({
  content: [{ type: 'text', text: 'Action executed.' }],
});
let mockLiveTools: readonly LiveTool[] = toolManifest.tools;
let lastTransportOptions: Record<string, unknown> | undefined;
let lastRequestOptions: Record<string, unknown> | undefined;
let lastTransport: { onclose?: () => void; onerror?: (error: Error) => void } | undefined;
let closeCount = 0;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect(_transport: unknown, options?: { signal?: AbortSignal }) {
      return mockConnect(options?.signal);
    }
    async close() {
      closeCount++;
    }
    async listTools() {
      return { tools: mockLiveTools, nextCursor: undefined };
    }
    async callTool(
      request: { name: string; arguments?: Record<string, unknown> },
      _schema: unknown,
      options: Record<string, unknown> | undefined,
    ) {
      lastRequestOptions = options;
      return mockCallTool(
        request.name,
        request.arguments ?? {},
        options?.signal as AbortSignal | undefined,
      );
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class MockTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    constructor(options: Record<string, unknown>) {
      lastTransportOptions = options;
      lastTransport = this;
    }
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.emit('spawn');
      child.stderr.emit('data', 'daemon listening on');
      child.emit('exit', 0);
    });
    return child;
  }),
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, { stdout: '', stderr: '' });
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(() => {
      if (mockConfigContent !== null) return mockConfigContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
  };
});

vi.mock('../vision.js', () => ({
  createPiVisionCaller: () => async () => 'vision analysis',
}));

interface RegisteredTool {
  prepareLoadout?: (loadout: {
    declared: { name: string }[];
  }) => { hiddenDeclarations: readonly string[] } | undefined;
  exposure?: string;
  name: string;
  description: string;
  parameters?: { properties?: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: typeof mockCtx,
  ) => Promise<unknown>;
}

interface RegisteredCommand {
  handler: (args: unknown, ctx: typeof mockCtx) => Promise<void>;
}

const tools = new Map<string, RegisteredTool>();
const commands = new Map<string, RegisteredCommand>();
const handlers: Record<string, Array<(event: unknown, ctx: typeof mockCtx) => Promise<void>>> = {};
const notify = vi.fn();
const activeTools: string[] = [];
const mockCtx = {
  cwd: '/tmp',
  signal: undefined as AbortSignal | undefined,
  hasUI: true,
  ui: { notify, confirm: vi.fn().mockResolvedValue(true) },
  modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
};
const mockPi = {
  registerTool: vi.fn((tool: RegisteredTool) => {
    tools.set(tool.name, tool);
    // Mirror the runtime: newly registered tools become active by default.
    if (
      (!tool.exposure || tool.exposure === 'direct' || tool.exposure === 'model-only') &&
      !activeTools.includes(tool.name)
    )
      activeTools.push(tool.name);
  }),
  registerCommand: vi.fn((name: string, command: RegisteredCommand) => commands.set(name, command)),
  on: vi.fn((event: string, handler: (event: unknown, ctx: typeof mockCtx) => Promise<void>) => {
    handlers[event] ??= [];
    handlers[event].push(handler);
  }),
  getAllTools: () =>
    [...tools.values()].map(({ exposure, ...tool }) => ({
      ...tool,
      ...(piVersion.value === '1.2.0' ? { exposure: exposure ?? 'direct' } : {}),
    })),
  getActiveTools: vi.fn(() => [...activeTools]),
  setActiveTools: vi.fn((names: string[]) => {
    activeTools.length = 0;
    activeTools.push(...names);
  }),
};

const { CuaDriverClient } = await import('../mcp-client.js');
const { default: computerUseExtension } = await import('../index.js');
const originalCallTool = CuaDriverClient.prototype.callTool;

async function start(config?: Record<string, unknown>, platform = 'darwin') {
  Object.defineProperty(process, 'platform', { value: platform });
  mockConfigContent = config ? JSON.stringify({ 'pi-computer-use': config }) : null;
  tools.clear();
  commands.clear();
  activeTools.length = 0;
  activeTools.push('read', 'bash', 'edit');
  for (const key of Object.keys(handlers)) delete handlers[key];
  computerUseExtension(mockPi as never);
  for (const handler of handlers.session_start ?? []) await handler({}, mockCtx);
}

describe('computerUseExtension', () => {
  beforeEach(() => {
    piVersion.value = '1.2.0';
    mockConnect = async () => {};
    mockCallTool = (name) =>
      name === 'check_permissions'
        ? {
            content: [{ type: 'text', text: 'Permissions granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          }
        : { content: [{ type: 'text', text: 'Action executed.' }] };
    mockLiveTools = toolManifest.tools;
    lastRequestOptions = undefined;
    lastTransport = undefined;
    closeCount = 0;
    notify.mockClear();
    mockCtx.ui.confirm.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handler of handlers.session_shutdown ?? []) await handler({}, mockCtx);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  it('registers the pinned Rust tool manifest on macOS', async () => {
    await start();

    expect(tools.size).toBe(toolManifest.tools.length + 1);
    expect(tools.has('computer_use_tools')).toBe(true);
    expect(tools.has('computer_use_start_session')).toBe(true);
    expect(tools.has('computer_use_health_report')).toBe(true);
    expect(tools.has('computer_use_get_accessibility_tree')).toBe(true);
    expect(tools.has('computer_use_screenshot')).toBe(false);
  });

  it('declares the visual parser kinds as an explicit string array for model providers', async () => {
    await start();

    expect(tools.get('computer_use_parse_visual_regions')?.parameters).toMatchObject({
      properties: {
        options: {
          properties: {
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['text', 'icon'] },
            },
          },
        },
      },
    });
  });

  it('keeps optional perception hints focused on each tool', async () => {
    await start();

    const parser = tools.get('computer_use_parse_visual_regions')?.description;
    expect(parser).toContain('Requires optional Perception');
    expect(parser).toContain('not_installed');
    expect(parser).toContain('computer_use_install_extension');
    const installer = tools.get('computer_use_install_extension')?.description;
    expect(installer).toContain('local signed catalog');
    expect(installer).toContain('does not download artifacts');
    expect(installer).toContain('README.md#optional-local-perception');
  });

  it('passes the optional extension catalog and store to the macOS daemon and proxy', async () => {
    vi.stubEnv('CUA_DRIVER_PERCEPTION_CATALOG', '/reviewed/catalog.json');
    vi.stubEnv('CUA_DRIVER_RS_HOME', '/isolated/driver-home');
    try {
      await start();
      await tools.get('computer_use_get_config')!.execute('id', {}, undefined, undefined, mockCtx);
      const launch = vi
        .mocked(spawn)
        .mock.calls.findLast(([command]) => command === '/usr/bin/open');
      expect(launch?.[1]).toEqual(
        expect.arrayContaining([
          '--env',
          'CUA_DRIVER_PERCEPTION_CATALOG=/reviewed/catalog.json',
          '--env',
          'CUA_DRIVER_RS_HOME=/isolated/driver-home',
        ]),
      );
      expect(lastTransportOptions?.env).toMatchObject({
        CUA_DRIVER_PERCEPTION_CATALOG: '/reviewed/catalog.json',
        CUA_DRIVER_RS_HOME: '/isolated/driver-home',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not start the macOS driver to discover its live schema', async () => {
    let connects = 0;
    mockConnect = async () => {
      connects++;
    };
    mockLiveTools = [
      {
        name: 'platform_specific_tool',
        description: 'Live platform contract',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    await start();

    expect(connects).toBe(0);
    expect(tools.has('computer_use_platform_specific_tool')).toBe(false);
    expect(tools.has('computer_use_click')).toBe(true);
  });

  it.each([
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_navigate',
    'browser_pointer',
    'browser_set_input_files',
    'browser_download',
  ])('subscribes to dialogs before %s can open one', async (name) => {
    const calls: Array<{
      name: string;
      args: Record<string, unknown>;
      signal: AbortSignal | undefined;
    }> = [];
    const signal = new AbortController().signal;
    await start({ confirmDangerousActions: false });
    mockCallTool = (tool, args, signal) => {
      calls.push({ name: tool, args, signal });
      return tool === 'browser_dialog'
        ? { structuredContent: { status: 'ok', present: false } }
        : { content: [{ type: 'text', text: 'ok' }] };
    };
    await tools.get(`computer_use_${name}`)!.execute(
      'action',
      {
        session: 'test-session',
        target_id: 'bt-123',
        tab_id: 'tab-456',
      },
      signal,
      undefined,
      mockCtx,
    );
    const browserCalls = calls.filter((call) => call.name.startsWith('browser_'));
    expect(browserCalls.map((call) => call.name)).toEqual(['browser_dialog', name]);
    expect(browserCalls[0]).toEqual({
      name: 'browser_dialog',
      args: {
        session: 'test-session',
        target_id: 'bt-123',
        tab_id: 'tab-456',
        action: 'inspect',
      },
      signal,
    });
  });

  it('returns the current dialog capability without dispatching a blocked browser action', async () => {
    const calls: string[] = [];
    await start();
    mockCallTool = (name) => {
      calls.push(name);
      return name === 'browser_dialog'
        ? {
            content: [{ type: 'text', text: 'confirm dialog is open' }],
            structuredContent: {
              status: 'ok',
              present: true,
              dialog_id: 'dialog-41',
              kind: 'confirm',
            },
          }
        : { content: [{ type: 'text', text: 'ok' }] };
    };
    const result = await tools.get('computer_use_browser_click')!.execute(
      'action',
      {
        target_id: 'bt-123',
        tab_id: 'tab-456',
      },
      undefined,
      undefined,
      mockCtx,
    );
    expect(result).toMatchObject({ isError: true });
    expect(calls).not.toContain('browser_click');
    expect(JSON.stringify(result)).toContain('dialog-41');
    expect(result).toMatchObject({
      content: expect.arrayContaining([
        { type: 'text', text: expect.stringContaining('dialog-41') },
      ]),
    });
  });

  it('stops before dispatch when dialog observation is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('session stopped');
    const calls: string[] = [];
    await start();
    mockCallTool = (name) => {
      calls.push(name);
      if (name === 'browser_dialog') {
        controller.abort(reason);
        throw reason;
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    await expect(
      tools.get('computer_use_browser_click')!.execute(
        'action',
        {
          target_id: 'bt-123',
          tab_id: 'tab-456',
        },
        controller.signal,
        undefined,
        mockCtx,
      ),
    ).rejects.toBe(reason);
    expect(calls).not.toContain('browser_click');
  });

  it.each([
    undefined,
    true,
  ])('cleans failed dialog observations and preserves the not-executed hint: %s', async (isError) => {
    const calls: string[] = [];
    await start();
    mockCallTool = (name) => {
      calls.push(name);
      return {
        ...(isError === undefined ? {} : { isError }),
        content: [{ type: 'text', text: 'test-token dialog observation unavailable' }],
        structuredContent: {
          status: 'failed',
          code: 'browser_action_unavailable',
          secret: 'test-token',
        },
      };
    };
    const result = await tools.get('computer_use_browser_click')!.execute(
      'action',
      {
        target_id: 'bt-123',
        tab_id: 'tab-456',
      },
      undefined,
      undefined,
      mockCtx,
    );
    expect(result).toMatchObject({ isError: true });
    expect(calls).not.toContain('browser_click');
    expect(JSON.stringify(result)).not.toContain('test-token');
    expect(JSON.stringify(result)).toContain('was not executed');
    expect(JSON.stringify(result)).not.toContain('execution outcome is unknown');
  });

  it('requests macOS permissions once on the first computer-use call', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    mockCallTool = (name, args) => {
      calls.push({ name, args });
      return name === 'check_permissions'
        ? {
            content: [{ type: 'text', text: 'Permissions granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          }
        : { content: [{ type: 'text', text: 'ok' }] };
    };
    await start();

    const listApps = tools.get('computer_use_list_apps')!;
    await Promise.all([
      listApps.execute('first', {}, undefined, undefined, mockCtx),
      listApps.execute('second', {}, undefined, undefined, mockCtx),
    ]);

    expect(calls.filter((call) => call.name === 'check_permissions')).toEqual([
      { name: 'check_permissions', args: { prompt: true } },
    ]);
  });

  it('honors an explicit read-only macOS permission check', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    mockCallTool = (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    await start();

    await tools
      .get('computer_use_check_permissions')!
      .execute('check', { prompt: false }, undefined, undefined, mockCtx);

    expect(calls).toEqual([{ name: 'check_permissions', args: { prompt: false } }]);
  });

  it('lets tools report their own permission requirements', async () => {
    let actionCalled = false;
    mockCallTool = (name) => {
      if (name === 'check_permissions') {
        return { content: [{ type: 'text', text: 'Permission status unavailable.' }] };
      }
      actionCalled = true;
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    };
    await start();

    const result = (await tools
      .get('computer_use_list_apps')!
      .execute('list', {}, undefined, undefined, mockCtx)) as any;

    expect(actionCalled).toBe(true);
    expect(result.isError).not.toBe(true);
  });

  it('runs the requested tool when the macOS permission probe rejects', async () => {
    let permissionChecks = 0;
    let actionCalls = 0;
    mockCallTool = async (name) => {
      if (name === 'check_permissions') {
        permissionChecks++;
        throw new Error('permission dialog token=secret timed out');
      }
      actionCalls++;
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start();

    const listApps = tools.get('computer_use_list_apps')!;
    const firstResult = (await listApps.execute('first', {}, undefined, undefined, mockCtx)) as any;
    const secondResult = (await listApps.execute(
      'second',
      {},
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).not.toBe(true);
    expect(permissionChecks).toBe(1);
    expect(actionCalls).toBe(2);
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('macOS permission probe failed');
    expect(logged).not.toContain('token=secret');
  });

  it('lets one caller cancel without aborting another caller first connection', async () => {
    const connection = abortableDeferred<void>();
    mockConnect = connection.wait;
    await start();

    const controller = new AbortController();
    const listApps = tools.get('computer_use_list_apps')!;
    const cancelledCall = listApps.execute('cancelled', {}, controller.signal, undefined, mockCtx);
    await connection.started;
    const activeCall = listApps.execute('active', {}, undefined, undefined, mockCtx);
    controller.abort(new Error('cancelled by user'));

    await expect(cancelledCall).rejects.toThrow('cancelled by user');
    connection.resolve();
    const activeResult = (await activeCall) as any;
    expect(activeResult.isError).not.toBe(true);
  });

  it('keeps a shared reconnect alive when the first permission probe is cancelled', async () => {
    let connects = 0;
    const reconnect = abortableDeferred<void>();
    mockConnect = (signal) => {
      connects++;
      return connects === 1 ? Promise.resolve() : reconnect.wait(signal);
    };
    await start();

    let disconnectBeforePermission = true;
    vi.spyOn(CuaDriverClient.prototype, 'callTool').mockImplementation(function (
      this: InstanceType<typeof CuaDriverClient>,
      ...args
    ) {
      if (disconnectBeforePermission && args[0] === 'check_permissions') {
        disconnectBeforePermission = false;
        lastTransport?.onclose?.();
      }
      return originalCallTool.apply(this, args);
    });

    const controller = new AbortController();
    const listApps = tools.get('computer_use_list_apps')!;
    const cancelledCall = listApps.execute('cancelled', {}, controller.signal, undefined, mockCtx);
    await reconnect.started;
    const activeCall = listApps.execute('active', {}, undefined, undefined, mockCtx);
    await Promise.resolve();
    controller.abort(new Error('cancelled by user'));

    await expect(cancelledCall).rejects.toThrow('cancelled by user');
    expect(reconnect.aborted).toBe(false);
    reconnect.resolve();
    const activeResult = (await activeCall) as any;
    expect(activeResult.isError).not.toBe(true);
    expect(connects).toBe(2);
  });

  it('aborts an unowned first connection when its session shuts down', async () => {
    const connection = abortableDeferred<void>();
    mockConnect = connection.wait;
    await start();

    const call = tools
      .get('computer_use_list_apps')!
      .execute('active', {}, undefined, undefined, mockCtx);
    await connection.started;
    for (const handler of handlers.session_shutdown ?? []) await handler({}, mockCtx);

    expect(connection.aborted).toBe(true);
    const result = (await call) as any;
    expect(result.isError).toBe(true);
  });

  it('keeps and reuses the first connection when its only caller cancels', async () => {
    let connects = 0;
    const connection = abortableDeferred<void>();
    mockConnect = (signal) => {
      connects++;
      return connection.wait(signal);
    };
    await start();

    const controller = new AbortController();
    const listApps = tools.get('computer_use_list_apps')!;
    const call = listApps.execute('cancelled', {}, controller.signal, undefined, mockCtx);
    await connection.started;
    controller.abort(new Error('cancelled by user'));

    await expect(call).rejects.toThrow('cancelled by user');
    expect(connection.aborted).toBe(false);
    const retryCall = listApps.execute('retry', {}, undefined, undefined, mockCtx);
    connection.resolve();
    const retryResult = (await retryCall) as any;
    expect(retryResult.isError).not.toBe(true);
    expect(connects).toBe(1);
  });

  it('keeps and reuses the permission request when its only caller cancels', async () => {
    let permissionChecks = 0;
    const permission = abortableDeferred<UpstreamResult>();
    mockCallTool = (name, _args, signal) => {
      if (name !== 'check_permissions') {
        return { content: [{ type: 'text', text: 'Action executed.' }] };
      }
      permissionChecks++;
      return permission.wait(signal);
    };
    await start();

    const controller = new AbortController();
    const call = tools
      .get('computer_use_list_apps')!
      .execute('cancelled', {}, controller.signal, undefined, mockCtx);
    await permission.started;
    controller.abort(new Error('cancelled by user'));

    await expect(call).rejects.toThrow('cancelled by user');
    expect(permission.aborted).toBe(false);
    const retryCall = tools
      .get('computer_use_list_apps')!
      .execute('retry', {}, undefined, undefined, mockCtx);
    permission.resolve({
      content: [{ type: 'text', text: 'Permissions granted.' }],
      structuredContent: { accessibility: true, screen_recording: true },
    });
    const retryResult = (await retryCall) as any;
    expect(retryResult.isError).not.toBe(true);
    expect(permissionChecks).toBe(1);
  });

  it('keeps the permission request while another caller is waiting', async () => {
    const permission = abortableDeferred<UpstreamResult>();
    mockCallTool = (name, _args, signal) => {
      if (name !== 'check_permissions') {
        return { content: [{ type: 'text', text: 'Action executed.' }] };
      }
      return permission.wait(signal);
    };
    await start();

    const controller = new AbortController();
    const listApps = tools.get('computer_use_list_apps')!;
    const cancelledCall = listApps.execute('cancelled', {}, controller.signal, undefined, mockCtx);
    const activeCall = listApps.execute('active', {}, undefined, undefined, mockCtx);
    await permission.started;
    await Promise.resolve();
    controller.abort(new Error('cancelled by user'));

    await expect(cancelledCall).rejects.toThrow('cancelled by user');
    expect(permission.aborted).toBe(false);
    permission.resolve({
      content: [{ type: 'text', text: 'Permissions granted.' }],
      structuredContent: { accessibility: true, screen_recording: true },
    });
    const activeResult = (await activeCall) as any;
    expect(activeResult.isError).not.toBe(true);
  });

  it('aborts an active permission request when its session shuts down', async () => {
    const permission = abortableDeferred<UpstreamResult>();
    mockCallTool = (name, _args, signal) => {
      if (name !== 'check_permissions') {
        return { content: [{ type: 'text', text: 'Action executed.' }] };
      }
      return permission.wait(signal);
    };
    await start();

    const call = tools
      .get('computer_use_list_apps')!
      .execute('active', {}, undefined, undefined, mockCtx);
    await permission.started;
    for (const handler of handlers.session_shutdown ?? []) await handler({}, mockCtx);

    expect(permission.aborted).toBe(true);
    const result = (await call) as any;
    expect(result.isError).toBe(true);
  });

  it.each([
    'linux',
    'win32',
  ] as const)('uses the parameterless permission probe on %s', async (platform) => {
    let connects = 0;
    let permissionArgs: Record<string, unknown> | undefined;
    mockConnect = async () => {
      connects++;
    };
    mockCallTool = (name, args) => {
      if (name === 'check_permissions') permissionArgs = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    };

    await start({ mode: 'path', binaryPath: '/mock/cua-driver' }, platform);

    expect(connects).toBe(1);
    expect(permissionArgs).toEqual({});
  });

  it('registers only a recovery contract after failed platform discovery', async () => {
    let attempts = 0;
    mockConnect = async () => {
      attempts++;
      if (attempts === 1) throw new Error('connection refused');
    };
    mockLiveTools = [
      {
        name: 'platform_specific_tool',
        description: 'Live platform contract',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    await start(undefined, 'linux');

    expect(tools.has('computer_use_click')).toBe(false);
    expect(tools.has('computer_use_connect')).toBe(true);
    expect(commands.has('computer-use-connect')).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      'pi-computer-use: driver unavailable; use computer_use_connect to retry discovery.',
      'warning',
    );

    const result = (await tools
      .get('computer_use_connect')!
      .execute('retry', {}, undefined, undefined, mockCtx)) as any;
    expect(result.content[0].text).toContain('1 platform tools');
    expect(tools.has('computer_use_platform_specific_tool')).toBe(true);
  });

  it('forwards image content, structured output, and cancellation', async () => {
    await start();
    mockCallTool = (name) =>
      name === 'check_permissions'
        ? {
            content: [{ type: 'text', text: 'Permissions granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          }
        : {
            content: [
              { type: 'image', data: 'image-base64', mimeType: 'image/png' },
              { type: 'text', text: 'window state' },
            ],
            structuredContent: {
              snapshot_id: 'snapshot-1',
              elements: [{ element_token: 'token-1' }],
            },
          };
    const controller = new AbortController();

    const result = (await tools
      .get('computer_use_get_window_state')!
      .execute('id', { pid: 1, window_id: 2 }, controller.signal, undefined, mockCtx)) as any;

    const imageItems = result.content.filter((item: any) => item.type === 'image');
    expect(imageItems).toEqual([{ type: 'image', data: 'image-base64', mimeType: 'image/png' }]);
    const texts = result.content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text);
    expect(texts).toContain('window state');
    expect(texts.join('\n')).toContain('snapshot_id=snapshot-1');
    expect(result.details.snapshot_id).toBe('snapshot-1');
    expect(lastRequestOptions?.signal).toBe(controller.signal);
  });

  it.each([
    ['run_script', 125_000],
    ['run_steps', 65_000],
  ] as const)('allows the full %s runtime while preserving cancellation', async (name, timeout) => {
    await start({ confirmAppLaunch: false, confirmDangerousActions: false });
    const controller = new AbortController();
    await tools
      .get(`computer_use_${name}`)!
      .execute('id', {}, controller.signal, undefined, mockCtx);
    expect(lastRequestOptions).toMatchObject({ signal: controller.signal, timeout });
  });

  it('reports an unknown outcome without encouraging replay when an action response is lost', async () => {
    await start();
    await tools.get('computer_use_list_apps')!.execute('warmup', {}, undefined, undefined, mockCtx);
    const dispatch = vi.fn(() => {
      throw new Error('response lost after delivery: private upstream details');
    });
    mockCallTool = dispatch;

    const result = (await tools
      .get('computer_use_type_text')!
      .execute(
        'id',
        { element_token: 's1:1', text: 'Hello' },
        undefined,
        undefined,
        mockCtx,
      )) as any;

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    const text = result.content.map((item: { text: string }) => item.text).join('\n');
    expect(text).toMatch(/execution outcome is unknown/i);
    expect(text).toContain('Read the current target state before retrying any action');
    expect(text).not.toContain('retry the tool');
    expect(text).not.toContain('Failed to connect');
    expect(text).not.toContain('private upstream details');
    expect(notify).toHaveBeenCalledWith(expect.not.stringContaining('cannot connect'), 'warning');
  });

  it('reconnects after the MCP transport closes', async () => {
    let connects = 0;
    mockConnect = async () => {
      connects++;
    };
    await start();
    await tools
      .get('computer_use_click')!
      .execute('id', { pid: 1, x: 2, y: 3 }, undefined, undefined, mockCtx);
    lastTransport?.onclose?.();

    await tools
      .get('computer_use_click')!
      .execute('id', { pid: 1, x: 2, y: 3 }, undefined, undefined, mockCtx);

    expect(connects).toBe(2);
  });

  it.each([
    {
      label: 'macOS ordinary tools',
      config: undefined,
      platform: 'darwin',
      tool: 'computer_use_list_apps',
      params: {},
    },
    {
      label: 'macOS vision tools',
      config: { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      platform: 'darwin',
      tool: 'computer_use_analyze_screenshot',
      params: { pid: 1, window_id: 2 },
    },
    {
      label: 'Linux ordinary tools',
      config: undefined,
      platform: 'linux',
      tool: 'computer_use_list_apps',
      params: {},
    },
  ])('lets one caller cancel without aborting a shared $label reconnect', async (testCase) => {
    let connects = 0;
    mockConnect = async () => {
      connects++;
    };
    mockCallTool = (name) =>
      name === 'check_permissions'
        ? {
            content: [{ type: 'text', text: 'Permissions granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          }
        : name === 'get_window_state'
          ? {
              content: [{ type: 'image', data: 'image-base64', mimeType: 'image/png' }],
            }
          : { content: [{ type: 'text', text: 'Action executed.' }] };
    await start(testCase.config, testCase.platform);

    const tool = tools.get(testCase.tool)!;
    await tool.execute('warmup', testCase.params, undefined, undefined, mockCtx);

    let disconnectBeforeCall = true;
    const callToolSpy = vi
      .spyOn(CuaDriverClient.prototype, 'callTool')
      .mockImplementation(function (this: InstanceType<typeof CuaDriverClient>, ...args) {
        if (disconnectBeforeCall) {
          disconnectBeforeCall = false;
          lastTransport?.onclose?.();
        }
        return originalCallTool.apply(this, args);
      });
    const reconnect = abortableDeferred<void>();
    mockConnect = (signal) => {
      connects++;
      return reconnect.wait(signal);
    };

    const controller = new AbortController();
    const cancelledCall = tool.execute(
      'cancelled',
      testCase.params,
      controller.signal,
      undefined,
      mockCtx,
    );
    const activeCall = tool.execute('active', testCase.params, undefined, undefined, mockCtx);
    await reconnect.started;
    controller.abort(new Error('cancelled by user'));

    await expect(cancelledCall).rejects.toThrow('cancelled by user');
    expect(reconnect.aborted).toBe(false);
    reconnect.resolve();
    const activeResult = (await activeCall) as any;
    expect(activeResult.isError).not.toBe(true);
    expect(connects).toBe(2);
    callToolSpy.mockRestore();
  });

  it('preserves AbortSignal cancellation instead of rewriting it as a connection error', async () => {
    await start();
    const controller = new AbortController();
    controller.abort(new Error('cancelled by user'));
    mockCallTool = () => {
      throw new Error('transport aborted');
    };

    await expect(
      tools
        .get('computer_use_click')!
        .execute('id', { pid: 1, x: 2, y: 3 }, controller.signal, undefined, mockCtx),
    ).rejects.toThrow('cancelled by user');
  });

  it('returns platform guidance for permission errors', async () => {
    await start();
    mockCallTool = (name) =>
      name === 'check_permissions'
        ? {
            content: [{ type: 'text', text: 'Permissions granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          }
        : {
            content: [{ type: 'text', text: 'ax_not_granted: permission denied' }],
            isError: true,
          };

    const result = (await tools
      .get('computer_use_click')!
      .execute('id', { pid: 1 }, undefined, undefined, mockCtx)) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Accessibility permission not granted');
  });

  it('confirms each app target once before launching it', async () => {
    await start();

    const launch = tools.get('computer_use_launch_app')!;
    await launch.execute(
      'first',
      { bundle_id: 'com.apple.TextEdit' },
      undefined,
      undefined,
      mockCtx,
    );
    await launch.execute(
      'second',
      { bundle_id: 'com.apple.TextEdit' },
      undefined,
      undefined,
      mockCtx,
    );

    expect(mockCtx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      'Allow computer use?',
      expect.stringContaining('com.apple.TextEdit'),
    );
  });

  it('prompts again when launch arguments change for the same app', async () => {
    await start();
    const launch = tools.get('computer_use_launch_app')!;
    await launch.execute(
      'first',
      { bundle_id: 'com.apple.Safari', url: 'https://example.com/a' },
      undefined,
      undefined,
      mockCtx,
    );
    await launch.execute(
      'second',
      { bundle_id: 'com.apple.Safari', url: 'https://example.com/b' },
      undefined,
      undefined,
      mockCtx,
    );
    expect(mockCtx.ui.confirm).toHaveBeenCalledTimes(2);
  });

  it('previews optional extensions freely but gates installation on user confirmation', async () => {
    await start();
    const invoked: string[] = [];
    mockCallTool = (name) => {
      invoked.push(name);
      return { content: [{ type: 'text', text: 'plan' }] };
    };
    const install = tools.get('computer_use_install_extension')!;
    await install.execute('preview', { name: 'perception' }, undefined, undefined, mockCtx);
    expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
    expect(invoked).toContain('install_extension');
    invoked.length = 0;
    mockCtx.ui.confirm.mockResolvedValueOnce(false);

    const denied = await install.execute(
      'install',
      { name: 'perception', confirm: true },
      undefined,
      undefined,
      mockCtx,
    );
    expect(denied).toMatchObject({ isError: true });
    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(invoked).not.toContain('install_extension');

    const nonInteractive = await install.execute(
      'headless',
      { name: 'perception', confirm: true },
      undefined,
      undefined,
      { ...mockCtx, hasUI: false },
    );
    expect(nonInteractive).toMatchObject({ isError: true });
    expect(invoked).not.toContain('install_extension');
    const approved = await install.execute(
      'approved',
      { name: 'perception', confirm: true },
      undefined,
      undefined,
      mockCtx,
    );
    expect(approved).not.toMatchObject({ isError: true });
    expect(invoked).toContain('install_extension');
  });

  it('requires confirmation and a cwd-contained output for trajectory recording', async () => {
    let invoked = false;
    let recordingArgs: Record<string, unknown> | undefined;
    await start();
    mockCallTool = (name, args) => {
      if (name === 'start_recording') {
        invoked = true;
        recordingArgs = args;
      }
      return { content: [{ type: 'text', text: 'recording' }] };
    };
    mockCtx.ui.confirm.mockResolvedValueOnce(false);

    await tools
      .get('computer_use_start_recording')!
      .execute('record', { output_dir: `${mockCtx.cwd}/recording` }, undefined, undefined, mockCtx);
    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(invoked).toBe(false);

    mockCtx.ui.confirm.mockClear();
    await tools
      .get('computer_use_start_recording')!
      .execute('outside', { output_dir: '/var/tmp/recording' }, undefined, undefined, mockCtx);
    expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
    expect(invoked).toBe(false);

    mockCtx.ui.confirm.mockResolvedValueOnce(true);
    await tools
      .get('computer_use_start_recording')!
      .execute('inside', { output_dir: `${mockCtx.cwd}/recording` }, undefined, undefined, mockCtx);
    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(invoked).toBe(true);
    expect(recordingArgs?.output_dir).toBe(join(await realpath(mockCtx.cwd), 'recording'));
  });

  it('rejects a recording output symlink that escapes cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-computer-use-recording-'));
    const outside = await mkdtemp(join(tmpdir(), 'pi-computer-use-recording-outside-'));
    const previousCwd = mockCtx.cwd;
    try {
      await symlink(outside, join(cwd, 'recording'), 'dir');
      mockCtx.cwd = cwd;
      let invoked = false;
      await start();
      mockCallTool = () => {
        invoked = true;
        return { content: [{ type: 'text', text: 'recording' }] };
      };

      await tools
        .get('computer_use_start_recording')!
        .execute('record', { output_dir: join(cwd, 'recording') }, undefined, undefined, mockCtx);

      expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
      expect(invoked).toBe(false);
    } finally {
      mockCtx.cwd = previousCwd;
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe('recording output revalidation', () => {
    let cwd: string;
    let movedCwd: string;
    let outside: string;
    let previousCwd: string;

    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), 'pi-computer-use-recording-'));
      movedCwd = `${cwd}-moved`;
      outside = await mkdtemp(join(tmpdir(), 'pi-computer-use-recording-outside-'));
      previousCwd = mockCtx.cwd;
      mockCtx.cwd = cwd;
    });

    afterEach(async () => {
      mockCtx.cwd = previousCwd;
      await rm(cwd, { recursive: true, force: true });
      await rm(movedCwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    it.each([
      'output directory',
      'workspace root',
    ] as const)('rejects %s replacement during confirmation', async (replacement) => {
      const outputDir = join(cwd, 'recording');
      let invoked = false;
      await start();
      mockCallTool = () => {
        invoked = true;
        return { content: [{ type: 'text', text: 'recording' }] };
      };
      mockCtx.ui.confirm.mockImplementationOnce(async () => {
        if (replacement === 'output directory') {
          await symlink(outside, outputDir, 'dir');
        } else {
          await rename(cwd, movedCwd);
          await symlink(outside, cwd, 'dir');
        }
        return true;
      });

      await tools
        .get('computer_use_start_recording')!
        .execute('record', { output_dir: outputDir }, undefined, undefined, mockCtx);

      expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
      expect(invoked).toBe(false);
    });
  });

  it('keeps recording output containment enabled when confirmations are disabled', async () => {
    let invoked = false;
    await start({ confirmDangerousActions: false });
    mockCallTool = () => {
      invoked = true;
      return { content: [{ type: 'text', text: 'recording' }] };
    };

    const result = (await tools
      .get('computer_use_start_recording')!
      .execute(
        'outside',
        { output_dir: '/var/tmp/recording' },
        undefined,
        undefined,
        mockCtx,
      )) as any;

    expect(invoked).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('allows a dot-prefixed recording directory inside cwd', async () => {
    let recordingArgs: Record<string, unknown> | undefined;
    await start({ confirmDangerousActions: false });
    mockCallTool = (_name, args) => {
      recordingArgs = args;
      return { content: [{ type: 'text', text: 'recording' }] };
    };

    await tools
      .get('computer_use_start_recording')!
      .execute(
        'inside',
        { output_dir: join(mockCtx.cwd, '..recording') },
        undefined,
        undefined,
        mockCtx,
      );

    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(recordingArgs?.output_dir).toBe(join(await realpath(mockCtx.cwd), '..recording'));
  });

  it('still confirms recording when dangerous-action confirmations are disabled', async () => {
    let invoked = false;
    await start({ confirmDangerousActions: false });
    mockCtx.ui.confirm.mockResolvedValueOnce(false);
    mockCallTool = () => {
      invoked = true;
      return { content: [{ type: 'text', text: 'recording' }] };
    };

    await tools
      .get('computer_use_start_recording')!
      .execute(
        'inside',
        { output_dir: join(mockCtx.cwd, 'recording') },
        undefined,
        undefined,
        mockCtx,
      );

    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(invoked).toBe(false);
  });

  it('requires script approval when app launch confirmation is enabled', async () => {
    await start({ confirmDangerousActions: false, confirmAppLaunch: true });
    mockCtx.ui.confirm.mockResolvedValueOnce(false);
    const invoked = vi.fn(() => ({ content: [] }));
    mockCallTool = invoked;

    const result = (await tools
      .get('computer_use_run_script')!
      .execute(
        'id',
        { script: 'await cua.launch("Calculator")' },
        undefined,
        undefined,
        mockCtx,
      )) as any;

    expect(invoked).not.toHaveBeenCalled();
    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
  });

  it('does not invoke a high-risk tool when confirmation is declined', async () => {
    let invoked = false;
    mockCtx.ui.confirm.mockResolvedValueOnce(false);
    await start();
    mockCallTool = () => {
      invoked = true;
      return { content: [{ type: 'text', text: 'killed' }] };
    };

    const result = (await tools
      .get('computer_use_kill_app')!
      .execute('id', { pid: 42 }, undefined, undefined, mockCtx)) as any;

    expect(invoked).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires interactive user confirmation');
  });

  it.each([
    'clipboard_read',
    'clipboard_write',
    'run_steps',
    'run_script',
  ])('confirms the new %s capability', async (name) => {
    let invoked = false;
    mockCtx.ui.confirm.mockResolvedValueOnce(false);
    await start();
    mockCallTool = () => {
      invoked = true;
      return { content: [{ type: 'text', text: 'clipboard' }] };
    };

    const result = (await tools
      .get(`computer_use_${name}`)!
      .execute('id', {}, undefined, undefined, mockCtx)) as any;

    expect(invoked).toBe(false);
    expect(mockCtx.ui.confirm).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires interactive user confirmation');
  });

  it.each([
    'permissions_pending: test-token',
    'ax_not_granted test-token',
    'HTTP 403: test-token',
    'unknown test-token',
  ])('cleans all returned MCP error fields: %s', async (message) => {
    await start();
    mockCallTool = () => ({
      isError: true,
      content: [
        { type: 'text', text: message },
        { type: 'image', data: 'test-token', mimeType: 'image/png' },
      ],
      structuredContent: { hint: 'test-token', raw: 'private diagnostic' },
    });
    const result = await tools
      .get('computer_use_check_permissions')!
      .execute('id', { prompt: false }, undefined, undefined, mockCtx);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toMatch(/test-token|private diagnostic/);
    if (message.startsWith('permissions_pending'))
      expect(JSON.stringify(result)).toContain('permissions_pending');
    if (message.startsWith('ax_')) expect(JSON.stringify(result)).toContain('Accessibility');
  });

  it('uses get_window_state for optional vision analysis', async () => {
    let call: { name: string; args: Record<string, unknown> } | undefined;
    await start({ visionModel: { provider: 'openai', model: 'gpt-4o' } });
    mockCallTool = (name, args) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: 'Permissions granted.' }],
          structuredContent: { accessibility: true, screen_recording: true },
        };
      }
      call = { name, args };
      return { content: [{ type: 'image', data: 'image-base64', mimeType: 'image/png' }] };
    };

    const result = (await tools
      .get('computer_use_analyze_screenshot')!
      .execute('id', { pid: 12, window_id: 34 }, undefined, undefined, mockCtx)) as any;

    expect(call).toEqual({
      name: 'get_window_state',
      args: { pid: 12, window_id: 34, include_screenshot: true, max_elements: 1 },
    });
    expect(result.content[0].text).toBe('vision analysis');
  });

  it('isolates daemon state and first connection across sessions', async () => {
    let connects = 0;
    mockConnect = async () => {
      connects++;
    };

    await start();
    const firstTools = new Map(tools);
    const firstShutdownHandlers = [...(handlers.session_shutdown ?? [])];
    await start();

    await Promise.all([
      firstTools.get('computer_use_list_apps')!.execute('first', {}, undefined, undefined, mockCtx),
      tools.get('computer_use_list_apps')!.execute('second', {}, undefined, undefined, mockCtx),
    ]);

    expect(connects).toBe(2);
    for (const handler of firstShutdownHandlers) await handler({}, mockCtx);
    expect(closeCount).toBe(1);
    for (const handler of handlers.session_shutdown ?? []) await handler({}, mockCtx);
    expect(closeCount).toBe(2);
  });

  it('closes the MCP client on session shutdown after it was used', async () => {
    await start();
    await tools.get('computer_use_list_apps')!.execute('id', {}, undefined, undefined, mockCtx);
    for (const handler of handlers.session_shutdown ?? []) await handler({}, mockCtx);
    expect(closeCount).toBeGreaterThan(0);
  });

  describe('deferred tool groups', () => {
    it('hides manual discovery only while native tool_search is active', async () => {
      await start();
      const prepare = tools.get('computer_use_tools')!.prepareLoadout!;
      expect(prepare({ declared: [] })).toBeUndefined();
      expect(prepare({ declared: [{ name: 'tool_search' }] })).toEqual({
        hiddenDeclarations: ['computer_use_tools'],
      });
      expect(prepare({ declared: [] })).toBeUndefined();
    });

    it('exposes optional desktop tools through native discovery', async () => {
      await start();
      expect(tools.get('computer_use_browser_navigate')).toMatchObject({
        exposure: 'deferred',
        namespace: { name: 'computer_use' },
      });
      expect(tools.get('computer_use_click')).toMatchObject({
        exposure: 'direct',
        namespace: { name: 'computer_use' },
      });
    });
    it('defers every driver tool with the lazy profile on native Pi', async () => {
      await start({ toolProfile: 'lazy' });

      for (const tool of toolManifest.tools) {
        const name = `computer_use_${tool.name}`;
        expect(tools.get(name)).toMatchObject({
          exposure: 'deferred',
          namespace: { name: 'computer_use' },
        });
        expect(mockPi.getActiveTools()).not.toContain(name);
      }
      expect(mockPi.getActiveTools()).toEqual(expect.arrayContaining(['read', 'bash']));
    });

    it('falls back to core with the lazy profile on legacy Pi', async () => {
      piVersion.value = '0.85.1';
      await start({ toolProfile: 'lazy' });

      expect(tools.get('computer_use_click')).not.toHaveProperty('exposure');
      expect(tools.get('computer_use_browser_navigate')).not.toHaveProperty('exposure');
      expect(mockPi.getActiveTools()).toEqual(
        expect.arrayContaining(['computer_use_click', 'computer_use_list_apps', 'read', 'bash']),
      );
      expect(mockPi.getActiveTools()).not.toContain('computer_use_browser_navigate');
      await tools
        .get('computer_use_tools')!
        .execute('id', { group: 'browser' }, undefined, undefined, mockCtx);
      expect(mockPi.getActiveTools()).toContain('computer_use_browser_navigate');
    });

    it('keeps manual activation on legacy Pi', async () => {
      piVersion.value = '0.85.1';
      await start();
      expect(tools.get('computer_use_browser_navigate')).not.toHaveProperty('exposure');
      await tools
        .get('computer_use_tools')!
        .execute('id', { group: 'browser' }, undefined, undefined, mockCtx);
      expect(mockPi.getActiveTools()).toContain('computer_use_browser_navigate');
    });

    it('activates only the core profile by default', async () => {
      await start();

      const active = mockPi.getActiveTools();
      expect(
        toolManifest.tools.filter((tool) => active.includes(`computer_use_${tool.name}`)),
      ).toHaveLength(14);
      for (const tool of toolManifest.tools) {
        if (active.includes(`computer_use_${tool.name}`)) {
          expect(tools.get(`computer_use_${tool.name}`)?.exposure).toBe('direct');
        }
      }
      expect(active).toContain('computer_use_click');
      expect(active).toContain('computer_use_list_apps');
      expect(active).toContain('computer_use_verify_state');
      expect(active).toContain('computer_use_tools');
      expect(active).not.toContain('computer_use_browser_click');
      expect(active).not.toContain('computer_use_start_recording');
      expect(active).not.toContain('computer_use_kill_app');
      expect(active).toContain('read');
      expect(active).toContain('bash');
    });

    it('keeps every driver tool active with toolProfile full', async () => {
      await start({ toolProfile: 'full' });

      const active = mockPi.getActiveTools();
      for (const tool of toolManifest.tools) {
        expect(active).toContain(`computer_use_${tool.name}`);
        expect(tools.get(`computer_use_${tool.name}`)?.exposure).toBe('direct');
      }
      expect(active).toContain('computer_use_browser_click');
      expect(active).toContain('computer_use_start_recording');
      expect(active).toContain('computer_use_kill_app');
    });

    it('lists groups and status without activating when no group is given', async () => {
      await start();

      const result = (await tools
        .get('computer_use_tools')!
        .execute('id', {}, undefined, undefined, mockCtx)) as any;

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('browser');
      expect(result.content[0].text).toContain('recording');
      expect(mockPi.getActiveTools()).not.toContain('computer_use_browser_click');
    });

    it('activates a group for the following turns', async () => {
      await start();

      const result = (await tools
        .get('computer_use_tools')!
        .execute('id', { group: 'browser' }, undefined, undefined, mockCtx)) as any;

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('computer_use_browser_click');
      const active = mockPi.getActiveTools();
      expect(active).toContain('computer_use_browser_click');
      expect(active).toContain('computer_use_browser_navigate');
      expect(active).toContain('computer_use_browser_select');
      expect(active).not.toContain('computer_use_start_recording');
    });

    it('activates batch tools through the automation group', async () => {
      await start();
      expect(mockPi.getActiveTools()).not.toContain('computer_use_run_script');
      await commands.get('computer-use-tools')!.handler('automation', mockCtx);
      expect(mockPi.getActiveTools()).toContain('computer_use_run_script');
      expect(mockPi.getActiveTools()).toContain('computer_use_run_steps');
    });

    it('activates optional extensions and visual parsing through diagnostics', async () => {
      await start();
      expect(mockPi.getActiveTools()).not.toContain('computer_use_get_guide');
      expect(mockPi.getActiveTools()).not.toContain('computer_use_parse_visual_regions');
      expect(mockPi.getActiveTools()).not.toContain('computer_use_install_extension');

      await commands.get('computer-use-tools')!.handler('diagnostics', mockCtx);

      expect(mockPi.getActiveTools()).toContain('computer_use_get_guide');
      expect(mockPi.getActiveTools()).toContain('computer_use_parse_visual_regions');
      expect(mockPi.getActiveTools()).toContain('computer_use_install_extension');
    });

    it('reports group activation as idempotent', async () => {
      await start();
      const meta = tools.get('computer_use_tools')!;
      await meta.execute('first', { group: 'browser' }, undefined, undefined, mockCtx);

      const result = (await meta.execute(
        'second',
        { group: 'browser' },
        undefined,
        undefined,
        mockCtx,
      )) as any;

      expect(result.content[0].text).toContain('Already active');
    });

    it('activates a group via the slash command', async () => {
      await start();

      await commands.get('computer-use-tools')!.handler('recording', mockCtx);

      expect(mockPi.getActiveTools()).toContain('computer_use_start_recording');
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('recording'), 'info');
    });

    it('warns on an unknown group in the slash command', async () => {
      await start();

      await commands.get('computer-use-tools')!.handler('nope', mockCtx);

      expect(notify).toHaveBeenCalledWith(expect.stringContaining('unknown group'), 'warning');
      expect(mockPi.getActiveTools()).not.toContain('computer_use_nope');
    });

    it('points to computer_use_connect when the driver is unavailable', async () => {
      mockConnect = async () => {
        throw new Error('connection refused');
      };
      await start(undefined, 'linux');

      const result = (await tools
        .get('computer_use_tools')!
        .execute('id', { group: 'browser' }, undefined, undefined, mockCtx)) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('computer_use_connect');
      expect(mockPi.getActiveTools()).not.toContain('computer_use_browser_click');
    });

    it('errors when a group has no tools registered on this platform', async () => {
      mockLiveTools = [
        { name: 'click', description: 'Click', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'type_text',
          description: 'Type',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      await start(undefined, 'linux');

      const result = (await tools
        .get('computer_use_tools')!
        .execute('id', { group: 'browser' }, undefined, undefined, mockCtx)) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no tools registered on this platform');
    });

    it('narrows the profile again after recovery via the slash command', async () => {
      let attempts = 0;
      mockConnect = async () => {
        attempts++;
        if (attempts === 1) throw new Error('connection refused');
      };
      await start(undefined, 'linux');

      await commands.get('computer-use-connect')!.handler('', mockCtx);

      const active = mockPi.getActiveTools();
      expect(active).toContain('computer_use_click');
      expect(active).not.toContain('computer_use_browser_click');
    });

    it('narrows the profile again after a recovery reconnect', async () => {
      let attempts = 0;
      mockConnect = async () => {
        attempts++;
        if (attempts === 1) throw new Error('connection refused');
      };
      await start(undefined, 'linux');
      expect(mockPi.getActiveTools()).not.toContain('computer_use_click');

      await tools.get('computer_use_connect')!.execute('retry', {}, undefined, undefined, mockCtx);

      const active = mockPi.getActiveTools();
      expect(active).toContain('computer_use_click');
      expect(active).not.toContain('computer_use_browser_click');
    });
  });
});

describe('config', () => {
  it('defaults to the bundled driver', async () => {
    const { resolveConfig } = await import('../config.js');
    expect(resolveConfig().mode).toBe('bundled');
  });

  it('defaults to the core tool profile', async () => {
    const { resolveConfig } = await import('../config.js');
    expect(resolveConfig().toolProfile).toBe('core');
  });

  it.each(['full', 'lazy'] as const)('preserves the %s tool profile', async (toolProfile) => {
    const { resolveConfig } = await import('../config.js');
    expect(resolveConfig({ toolProfile }).toolProfile).toBe(toolProfile);
  });

  it('preserves a custom path and vision model', async () => {
    const { resolveConfig } = await import('../config.js');
    expect(
      resolveConfig({
        mode: 'path',
        binaryPath: '/opt/cua-driver',
        visionModel: { provider: 'openai', model: 'gpt-4o' },
      }),
    ).toMatchObject({
      mode: 'path',
      binaryPath: '/opt/cua-driver',
      visionModel: { provider: 'openai', model: 'gpt-4o' },
    });
  });
});
