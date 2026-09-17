import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, test, vi } from 'vitest';

const mockClientConnect = vi.fn(() => Promise.resolve());
const mockClientClose = vi.fn(() => Promise.resolve());
const mockClientPing = vi.fn(() => Promise.resolve({}));
const mockTransports: Array<{
  onclose?: () => void;
  onerror?: (error: Error) => void;
  opts?: { command?: string; args?: string[]; env?: Record<string, string> };
  stderr?: PassThrough;
}> = [];
let _listToolsCalls = 0;
const mockListTools = vi.fn((opts?: { cursor?: string }) => {
  _listToolsCalls++;
  if (!opts?.cursor) {
    return Promise.resolve({
      tools: [{ name: 'click', description: 'Click', inputSchema: {} }],
      nextCursor: 'page2',
    });
  }
  return Promise.resolve({
    tools: [{ name: 'fill', description: 'Fill', inputSchema: {} }],
    nextCursor: undefined,
  });
});
const mockCallTool = vi.fn((_req: { name: string; arguments: Record<string, unknown> }) =>
  Promise.resolve({ content: [{ type: 'text', text: 'done' }] }),
);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockClientConnect;
    ping = mockClientPing;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClientClose;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    stderr = new PassThrough();
    constructor(public opts: { command?: string; args?: string[]; env?: Record<string, string> }) {
      mockTransports.push(this);
    }
  },
}));

const { DevToolsClient } = await import('../index.js');
const { BrowserCredentialGate } = await import('../credential-auth.js');

describe('DevToolsClient', () => {
  beforeEach(() => {
    mockClientConnect.mockClear();
    mockClientClose.mockClear();
    mockClientPing.mockClear();
    mockListTools.mockClear();
    mockCallTool.mockClear();
    _listToolsCalls = 0;
    mockTransports.length = 0;
  });

  describe('connect()', () => {
    it('shares one connection attempt across concurrent callers', async () => {
      const client = new DevToolsClient();

      await Promise.all([client.connect(), client.connect()]);

      expect(mockClientConnect).toHaveBeenCalledTimes(1);
    });

    test('creates transport and connects client', async () => {
      const client = new DevToolsClient();
      await client.connect();
      expect(mockClientConnect).toHaveBeenCalledTimes(1);
    });

    test('connects with default config args', async () => {
      const client = new DevToolsClient();
      await client.connect();
      expect(mockClientConnect).toHaveBeenCalled();
    });

    test('connects with custom config', async () => {
      const client = new DevToolsClient({ headless: true, channel: 'canary' });
      await client.connect();
      expect(mockClientConnect).toHaveBeenCalled();
    });

    it('uses the installed chrome-devtools-mcp entrypoint when PATH has no npx', async () => {
      const originalPath = process.env.PATH;
      const originalNode = process.env.PI_BROWSER_USE_NODE;
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
      delete process.env.PI_BROWSER_USE_NODE;
      try {
        const client = new DevToolsClient({ headless: true });
        await client.connect();

        expect(mockTransports[0]!.opts).toMatchObject({ command: process.execPath });
        expect(mockTransports[0]!.opts!.args?.[0]).toMatch(
          /chrome-devtools-mcp[/\\]build[/\\]src[/\\]bin[/\\]chrome-devtools-mcp\.js$/,
        );
        expect(mockTransports[0]!.opts!.args).not.toContain('chrome-devtools-mcp@latest');
      } finally {
        process.env.PATH = originalPath;
        if (originalNode === undefined) {
          delete process.env.PI_BROWSER_USE_NODE;
        } else {
          process.env.PI_BROWSER_USE_NODE = originalNode;
        }
      }
    });

    it('uses the host-provided Node command when available', async () => {
      const originalNode = process.env.PI_BROWSER_USE_NODE;
      process.env.PI_BROWSER_USE_NODE = '/opt/pi-browser-use/node';
      try {
        const client = new DevToolsClient();
        await client.connect();

        expect(mockTransports[0]!.opts).toMatchObject({
          command: '/opt/pi-browser-use/node',
        });
      } finally {
        if (originalNode === undefined) {
          delete process.env.PI_BROWSER_USE_NODE;
        } else {
          process.env.PI_BROWSER_USE_NODE = originalNode;
        }
      }
    });

    it('uses the current Node and a minimal child environment in credential mode', async () => {
      const originalNode = process.env.PI_BROWSER_USE_NODE;
      const originalDebug = process.env.DEBUG;
      const originalNodeOptions = process.env.NODE_OPTIONS;
      const originalProxy = process.env.HTTPS_PROXY;
      process.env.PI_BROWSER_USE_NODE = '/tmp/untrusted-node-wrapper';
      process.env.DEBUG = 'mcp:*';
      process.env.NODE_OPTIONS = '--require=/tmp/untrusted-hook.cjs';
      process.env.HTTPS_PROXY = 'http://attacker.invalid:8080';
      try {
        const client = new DevToolsClient(
          {
            sessionMode: 'persistent',
            userDataDir: '/runtime/browser-profile',
            usageStatistics: false,
            categoryNetwork: false,
            experimentalPageIdRouting: true,
          },
          undefined,
          true,
        );
        await client.connect();

        expect(mockTransports[0]!.opts?.command).toBe(process.execPath);
        expect(mockTransports[0]!.opts?.args).toEqual([
          expect.stringMatching(
            /chrome-devtools-mcp[/\\]build[/\\]src[/\\]bin[/\\]chrome-devtools-mcp\.js$/,
          ),
          '--user-data-dir=/runtime/browser-profile',
          '--category-network=false',
          '--experimental-page-id-routing',
          '--no-usage-statistics',
        ]);
        expect(mockTransports[0]!.opts?.env).not.toHaveProperty('DEBUG');
        expect(mockTransports[0]!.opts?.env).not.toHaveProperty('NODE_OPTIONS');
        expect(mockTransports[0]!.opts?.env).not.toHaveProperty('PI_BROWSER_USE_NODE');
        expect(mockTransports[0]!.opts?.env).not.toHaveProperty('HTTPS_PROXY');
      } finally {
        if (originalNode === undefined) delete process.env.PI_BROWSER_USE_NODE;
        else process.env.PI_BROWSER_USE_NODE = originalNode;
        if (originalDebug === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = originalDebug;
        if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = originalNodeOptions;
        if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = originalProxy;
      }
    });

    it('preserves an allowlisted MCP subprocess error code when startup fails', async () => {
      mockClientConnect.mockImplementationOnce(async () => {
        mockTransports[0]!.stderr!.write('npm error code ENOTEMPTY path /private/cache\n');
        const error = new Error('MCP error -32000: Connection closed');
        error.name = 'McpError';
        throw error;
      });
      const client = new DevToolsClient({ headless: true });

      await expect(client.connect()).rejects.toThrow(
        'Browser connection failed. MCP subprocess failed (ENOTEMPTY).',
      );
    });

    it('does not expose arbitrary MCP subprocess stderr in connection errors', async () => {
      mockClientConnect.mockImplementationOnce(async () => {
        mockTransports[0]!.stderr!.write(
          'startup failed --ws-headers={"Authorization":"Bearer secret-token"}\n',
        );
        throw new Error('Connection closed');
      });
      const client = new DevToolsClient({ headless: true });

      const connection = client.connect();
      await expect(connection).rejects.toThrow(
        'Browser connection failed. MCP transport failed (Error).',
      );
      await expect(connection).rejects.not.toThrow('secret-token');
    });
  });

  describe('listAllTools()', () => {
    test('paginates through all tool pages', async () => {
      const client = new DevToolsClient();
      await client.connect();

      const tools = await client.listAllTools();

      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe('click');
      expect(tools[1]!.name).toBe('fill');
      expect(mockListTools).toHaveBeenCalledTimes(2);
    });

    it('connects on demand when listing tools', async () => {
      const client = new DevToolsClient();

      await client.listAllTools();

      expect(mockClientConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('callTool()', () => {
    it('enforces the credential gate before dispatching to MCP', async () => {
      const gate = new BrowserCredentialGate();
      const client = new DevToolsClient(undefined, gate);
      gate.seal();

      await expect(client.callTool('evaluate_script', { function: '() => 1' })).rejects.toThrow(
        'browser_auth_transaction_sealed',
      );
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('reconnects before the next tool call after the transport closes', async () => {
      const client = new DevToolsClient();
      await client.connect();
      mockTransports[0]!.onclose?.();

      await client.callTool('click', { uid: '1_2' });

      expect(mockClientConnect).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    test('calls upstream tool with name and args', async () => {
      const client = new DevToolsClient();
      await client.connect();

      const result = await client.callTool('click', { uid: '1_2' });

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: 'click', arguments: { uid: '1_2' } },
        undefined,
        { timeout: 60_000 },
      );
      expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    });

    it('connects on demand before the first tool call', async () => {
      const client = new DevToolsClient();

      await client.callTool('click', {});

      expect(mockClientConnect).toHaveBeenCalledTimes(1);
      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    it('checks connection health after the health interval', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
        const client = new DevToolsClient();
        await client.connect();
        vi.advanceTimersByTime(10_001);

        await client.callTool('click', {});

        expect(mockClientPing).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reconnects when a health check fails before dispatch', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
        const client = new DevToolsClient();
        await client.connect();
        vi.advanceTimersByTime(10_001);
        mockClientPing.mockRejectedValueOnce(new Error('transport closed'));

        await client.callTool('click', {});

        expect(mockClientConnect).toHaveBeenCalledTimes(2);
        expect(mockCallTool).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reconnects when concurrent health checks disagree', async () => {
      let now = 0;
      const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let rejectFirstPing!: (reason: Error) => void;
      let resolveSecondPing!: (value: object) => void;
      mockClientPing
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirstPing = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecondPing = resolve;
            }),
        );

      try {
        const client = new DevToolsClient();
        await client.connect();
        now = 10_001;

        const firstCall = client.callTool('click', { uid: '1_1' });
        const secondCall = client.callTool('click', { uid: '1_2' });
        await vi.waitFor(() => expect(mockClientPing).toHaveBeenCalledTimes(2));

        rejectFirstPing(new Error('transport closed'));
        resolveSecondPing({});

        await expect(Promise.all([firstCall, secondCall])).resolves.toHaveLength(2);
        expect(mockClientConnect).toHaveBeenCalledTimes(2);
        expect(mockCallTool).toHaveBeenCalledTimes(2);
      } finally {
        dateNow.mockRestore();
      }
    });

    it('passes the abort signal to the upstream request', async () => {
      const client = new DevToolsClient();
      const controller = new AbortController();

      await client.callTool('click', {}, controller.signal);

      expect(mockCallTool).toHaveBeenCalledWith({ name: 'click', arguments: {} }, undefined, {
        signal: controller.signal,
        timeout: 60_000,
      });
    });

    it('does not replay a tool that loses its connection during dispatch', async () => {
      const client = new DevToolsClient();
      await client.connect();
      mockCallTool.mockImplementationOnce(async () => {
        mockTransports[0]!.onclose?.();
        throw new Error('internal transport detail');
      });

      await expect(client.callTool('click', {})).rejects.toThrow(
        'Browser connection lost; retry the tool',
      );

      expect(mockCallTool).toHaveBeenCalledTimes(1);
      expect(client.getState()).toBe('disconnected');
    });

    it('sanitizes unexpected upstream request failures', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const client = new DevToolsClient();
        mockCallTool.mockRejectedValueOnce(new Error('secret response body'));

        await expect(client.callTool('click', {})).rejects.toThrow('Browser tool call failed.');

        expect(consoleError).toHaveBeenCalledWith(
          '[pi-browser-use] upstream tool call failed (Error)',
        );
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe('connection state', () => {
    it('tracks ready and disconnected transport states', async () => {
      const client = new DevToolsClient();
      expect(client.getState()).toBe('disconnected');

      await client.connect();
      expect(client.getState()).toBe('ready');

      mockTransports[0]!.onclose?.();
      expect(client.getState()).toBe('disconnected');
    });

    it('ignores a late close event from an old transport', async () => {
      const client = new DevToolsClient();
      await client.connect();
      const oldTransport = mockTransports[0]!;
      oldTransport.onclose?.();
      await client.callTool('click', {});

      oldTransport.onclose?.();

      expect(client.getState()).toBe('ready');
    });

    it('ignores a late error event from an old transport', async () => {
      const client = new DevToolsClient();
      await client.connect();
      const oldTransport = mockTransports[0]!;
      oldTransport.onclose?.();
      await client.callTool('click', {});

      oldTransport.onerror?.(new Error('late transport error'));

      expect(client.getState()).toBe('ready');
      expect(mockClientClose).not.toHaveBeenCalled();
    });

    it('can retry after an initial connection failure', async () => {
      mockClientConnect.mockRejectedValueOnce(new Error('startup failed'));
      const client = new DevToolsClient();

      await expect(client.connect()).rejects.toThrow('Browser connection failed.');
      expect(client.getState()).toBe('failed');

      await client.connect();
      expect(client.getState()).toBe('ready');
    });
  });

  describe('close()', () => {
    test('closes the client', async () => {
      const client = new DevToolsClient();
      await client.connect();
      await client.close();
      expect(mockClientClose).toHaveBeenCalledTimes(1);
    });

    test('no-ops when already closed', async () => {
      const client = new DevToolsClient();
      await client.close();
      expect(mockClientClose).not.toHaveBeenCalled();
    });

    test('subsequent callTool throws after close', async () => {
      const client = new DevToolsClient();
      await client.connect();
      await client.close();
      await expect(client.callTool('click', {})).rejects.toThrow('Client not connected');
    });
  });
});
