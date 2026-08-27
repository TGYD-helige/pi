import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'click', description: 'Click', inputSchema: { type: 'object' } },
        { name: 'take_snapshot', description: 'Snapshot', inputSchema: { type: 'object' } },
      ],
      nextCursor: undefined,
    }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  complete: vi.fn().mockResolvedValue({ text: 'mock' }),
}));

vi.mock('../packages/pi-browser-use/src/profile.js', () => ({
  prepareBrowserProfile: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

interface MockExtensionAPI {
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerProvider: ReturnType<typeof vi.fn>;
  unregisterProvider: ReturnType<typeof vi.fn>;
  registerShortcut: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
}

function createMockExtensionAPI(): MockExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerShortcut: vi.fn(),
    appendEntry: vi.fn(),
    exec: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  };
}

function eventsRegistered(pi: MockExtensionAPI): string[] {
  return pi.on.mock.calls.map((c: unknown[]) => c[0] as string);
}

function commandsRegistered(pi: MockExtensionAPI): string[] {
  return pi.registerCommand.mock.calls.map((c: unknown[]) => c[0] as string);
}

function toolsRegistered(pi: MockExtensionAPI): string[] {
  return pi.registerTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
}

const EXTENSIONS_DIR = join(__dirname, '..', 'packages');

const EXTENSION_PACKAGES = [
  'pi-attachments',
  'pi-browser-use',
  'pi-channels',
  'pi-computer-use',
  'pi-dingtalk',
  'pi-image-gen',
  'pi-lark',
  'pi-memory',
  'pi-memory-mem0',
  'pi-security',
  'pi-task-scheduler',
  'pi-teamwork',
  'pi-telemetry',
  'pi-web-access',
  'pi-wecom',
] as const;

async function loadExtension(
  pkgName: string,
): Promise<(pi: MockExtensionAPI) => void | Promise<void>> {
  const mod = await import(join(EXTENSIONS_DIR, pkgName, 'src', 'index.ts'));
  // biome-ignore lint/suspicious/noExplicitAny: extension default export shape varies
  return mod.default as any;
}

describe('Extension loading contract', () => {
  for (const pkgName of EXTENSION_PACKAGES) {
    describe(pkgName, () => {
      const pkgDir = join(EXTENSIONS_DIR, pkgName);
      const pkgJsonPath = join(pkgDir, 'package.json');

      it('declares "pi" field with extensions in package.json', () => {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        expect(pkgJson.pi).toBeDefined();
        expect(pkgJson.pi.extensions).toBeInstanceOf(Array);
        expect(pkgJson.pi.extensions.length).toBeGreaterThan(0);
      });

      it('exports a default function (extension factory)', async () => {
        const factory = await loadExtension(pkgName);
        expect(typeof factory).toBe('function');
      });

      it('calls factory without throwing', async () => {
        const factory = await loadExtension(pkgName);
        const pi = createMockExtensionAPI();
        // biome-ignore lint/suspicious/noExplicitAny: mock API
        expect(() => factory(pi as any)).not.toThrow();
      });
    });
  }

  describe('pi-attachments registrations', () => {
    it('hooks the input event to intercept @-mentions and uploads', async () => {
      const factory = await loadExtension('pi-attachments');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(eventsRegistered(pi)).toContain('input');
    });
  });

  describe('pi-browser-use registrations', () => {
    it('registers session_start and session_shutdown handlers', async () => {
      const factory = await loadExtension('pi-browser-use');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      const onCalls = eventsRegistered(pi);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('session_shutdown');
    });

    it('registers browser_ prefixed tools after session_start', { timeout: 15000 }, async () => {
      const mod = await import(join(EXTENSIONS_DIR, 'pi-browser-use', 'src', 'index.ts'));
      const upstreamTools = [
        { name: 'click', description: 'Click', inputSchema: { type: 'object' } },
        { name: 'take_snapshot', description: 'Snapshot', inputSchema: { type: 'object' } },
      ] as unknown as Awaited<ReturnType<typeof mod.DevToolsClient.prototype.listAllTools>>;
      const connectSpy = vi
        .spyOn(mod.DevToolsClient.prototype, 'connect')
        .mockResolvedValue(undefined);
      const listToolsSpy = vi
        .spyOn(mod.DevToolsClient.prototype, 'listAllTools')
        .mockResolvedValue(upstreamTools);
      const pi = createMockExtensionAPI();
      try {
        // biome-ignore lint/suspicious/noExplicitAny: mock API
        mod.default(pi as any);

        const sessionStartHandler = pi.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'session_start',
        )?.[1] as (...args: unknown[]) => Promise<void>;
        expect(sessionStartHandler).toBeDefined();

        await sessionStartHandler(
          { type: 'session_start', reason: 'startup' },
          { cwd: process.cwd() },
        );

        expect(pi.registerTool).toHaveBeenCalled();
        const toolNames = toolsRegistered(pi);
        expect(toolNames).toContain('browser_click');
        expect(toolNames).toContain('browser_take_snapshot');
      } finally {
        connectSpy.mockRestore();
        listToolsSpy.mockRestore();
      }
    });
  });

  describe('pi-channels registrations', () => {
    it('registers /channel command and notify tool at top level', async () => {
      const factory = await loadExtension('pi-channels');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(commandsRegistered(pi)).toContain('channel');
      expect(toolsRegistered(pi)).toContain('notify');
    });
  });

  describe('pi-computer-use registrations', () => {
    it('registers session_start and session_shutdown handlers', async () => {
      const factory = await loadExtension('pi-computer-use');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      const onCalls = eventsRegistered(pi);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('session_shutdown');
    });
  });

  describe('pi-dingtalk registrations', () => {
    it('hooks session_start and resources_discover (skills bridge only)', async () => {
      const factory = await loadExtension('pi-dingtalk');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      const onCalls = eventsRegistered(pi);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('resources_discover');
      expect(toolsRegistered(pi)).toEqual([]);
      expect(commandsRegistered(pi)).toEqual([]);
    });
  });

  describe('pi-image-gen registrations', () => {
    it('registers /image-gen command at top level and image_generate tool after session_start', async () => {
      const factory = await loadExtension('pi-image-gen');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(commandsRegistered(pi)).toContain('image-gen');
      // The tool registers inside session_start so its schema can be shaped for
      // the provider resolved from just-loaded settings (see pi-web-access).
      expect(eventsRegistered(pi)).toContain('session_start');
      const sessionStartHandler = pi.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'session_start',
      )?.[1] as (...args: unknown[]) => Promise<void>;
      expect(sessionStartHandler).toBeDefined();
      await sessionStartHandler({ type: 'session_start', reason: 'startup' }, { cwd: process.cwd() });
      expect(toolsRegistered(pi)).toContain('image_generate');
    });
  });

  describe('pi-lark registrations', () => {
    it('hooks session_start (skills bridge only — no tools/commands at top level)', async () => {
      const factory = await loadExtension('pi-lark');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(eventsRegistered(pi)).toContain('session_start');
      expect(toolsRegistered(pi)).toEqual([]);
      expect(commandsRegistered(pi)).toEqual([]);
    });
  });

  describe('pi-memory registrations', () => {
    it('registers /memory command at top level', async () => {
      const factory = await loadExtension('pi-memory');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(commandsRegistered(pi)).toContain('memory');
      expect(eventsRegistered(pi)).toContain('session_start');
    });
  });

  describe('pi-memory-mem0 registrations', () => {
    it('registers /mem0 command at top level', async () => {
      const factory = await loadExtension('pi-memory-mem0');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(commandsRegistered(pi)).toContain('mem0');
      expect(eventsRegistered(pi)).toContain('session_start');
    });
  });

  describe('pi-security registrations', () => {
    it('registers tool_call + user_bash handlers and 3 commands', async () => {
      const factory = await loadExtension('pi-security');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);

      const onCalls = eventsRegistered(pi);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('session_shutdown');
      expect(onCalls).toContain('tool_call');
      expect(onCalls).toContain('user_bash');

      const cmdNames = commandsRegistered(pi);
      expect(cmdNames).toContain('pi-security-status');
      expect(cmdNames).toContain('pi-security-audit');
      expect(cmdNames).toContain('pi-security-reset');
    });
  });

  describe('pi-task-scheduler registrations', () => {
    it('registers /cron command at top level', async () => {
      const factory = await loadExtension('pi-task-scheduler');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(commandsRegistered(pi)).toContain('cron');
      expect(eventsRegistered(pi)).toContain('session_start');
    });
  });

  describe('pi-teamwork registrations', () => {
    it('registers /teamwork-status command at top level', async () => {
      const factory = await loadExtension('pi-teamwork');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(commandsRegistered(pi)).toContain('teamwork-status');
      expect(eventsRegistered(pi)).toContain('session_start');
    });
  });

  describe('pi-telemetry registrations', () => {
    it('registers all lifecycle event handlers', async () => {
      const factory = await loadExtension('pi-telemetry');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);

      const onCalls = eventsRegistered(pi);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('input');
      expect(onCalls).toContain('turn_start');
      expect(onCalls).toContain('agent_end');
      expect(onCalls).toContain('tool_execution_start');
      expect(onCalls).toContain('tool_execution_end');
      expect(onCalls).toContain('before_provider_request');
      expect(onCalls).toContain('after_provider_response');
      expect(onCalls).toContain('message_end');
      expect(onCalls).toContain('model_select');
      expect(onCalls).toContain('session_compact');
      expect(onCalls).toContain('session_shutdown');
    });
  });

  describe('pi-web-access registrations', () => {
    it('hooks session_start (no tools/commands without provider config)', async () => {
      const factory = await loadExtension('pi-web-access');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      // Tools register inside session_start, gated on resolved provider keys.
      // Without env config, baseline registers 0 tools — but the session hook must exist.
      expect(eventsRegistered(pi)).toContain('session_start');
      expect(commandsRegistered(pi)).toEqual([]);
    });
  });

  describe('pi-wecom registrations', () => {
    it('hooks session_start (skills bridge only — no tools/commands at top level)', async () => {
      const factory = await loadExtension('pi-wecom');
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      factory(pi as any);
      expect(eventsRegistered(pi)).toContain('session_start');
      expect(toolsRegistered(pi)).toEqual([]);
      expect(commandsRegistered(pi)).toEqual([]);
    });
  });
});
