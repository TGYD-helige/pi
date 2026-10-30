import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DevToolsClient } from '../index.js';
import { BrowserAcquisitionError, type ManagedBrowser } from '../session-backend.js';
import * as connectionModule from '../session-connection.js';
import { serveBrowserSession } from '../session-server.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('browser session shutdown', () => {
  it.each([
    'resolve',
    'reject',
  ] as const)('waits for candidate cleanup when connect ignores shutdown and later %ss', async (completion) => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const { promise: started, resolve: entered } = deferred();
    const pending = deferred();
    const cleanup = deferred();
    const cleaning = deferred();
    const createConnection = connectionModule.createBrowserConnection;
    const tunnels: Awaited<ReturnType<typeof createConnection>>[] = [];
    vi.spyOn(connectionModule, 'createBrowserConnection').mockImplementation(async (...args) => {
      const tunnel = await createConnection(...args);
      tunnels.push(tunnel);
      return tunnel;
    });
    const connect = vi.spyOn(DevToolsClient.prototype, 'connect').mockResolvedValue();
    const close = vi.spyOn(DevToolsClient.prototype, 'close').mockResolvedValue();
    const callTool = vi
      .spyOn(DevToolsClient.prototype, 'callTool')
      .mockResolvedValue({ content: [] });
    const onStop = vi.fn();
    const server = await serveBrowserSession(
      {
        wsEndpoint: 'ws://127.0.0.1:1',
        sessionMode: 'existing',
        session: { enabled: true, key: 'shutdown-candidate', retentionMs: 1000 },
      },
      token,
      { onStop },
    );
    let candidate: DevToolsClient | undefined;
    connect.mockImplementationOnce(function (this: DevToolsClient) {
      candidate = this;
      entered();
      return pending.promise;
    });
    close.mockImplementation(async function (this: DevToolsClient) {
      if (this === candidate) {
        cleaning.resolve();
        await cleanup.promise;
      }
    });
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    let stopped = false;
    try {
      await request('attach');
      const call = request('call', { name: 'list_pages', args: {} });
      await started;
      const shutdown = server.stop('lost').then(() => {
        stopped = true;
      });
      // Drain immediate cleanup so an early shutdown deterministically becomes visible.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      if (completion === 'resolve') pending.resolve();
      else pending.reject(new Error('late connect failure'));
      await cleaning.promise;
      expect(stopped).toBe(false);
      expect(onStop).not.toHaveBeenCalled();
      cleanup.resolve();
      await shutdown;
      expect((await call).status).toBe(409);
      expect(callTool).not.toHaveBeenCalled();
      expect(tunnels).toHaveLength(1);
      expect(tunnels[0]!.alive).toBe(false);
      expect(close.mock.contexts).toContain(candidate);
      expect(onStop).toHaveBeenCalledWith('lost');
    } finally {
      pending.resolve();
      cleanup.resolve();
      await server.stop();
      for (const tunnel of tunnels) await tunnel.close();
      vi.restoreAllMocks();
    }
  });
  it.each([
    'close',
    'connect',
  ] as const)('closes failed replacement tunnels before retrying after %s fails', async (failure) => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const createConnection = connectionModule.createBrowserConnection;
    const tunnels: Awaited<ReturnType<typeof createConnection>>[] = [];
    const factory = vi
      .spyOn(connectionModule, 'createBrowserConnection')
      .mockImplementation(async (...args) => {
        const tunnel = await createConnection(...args);
        tunnels.push(tunnel);
        return tunnel;
      });
    const connect = vi.spyOn(DevToolsClient.prototype, 'connect').mockResolvedValue();
    const close = vi.spyOn(DevToolsClient.prototype, 'close').mockResolvedValue();
    const call = vi.spyOn(DevToolsClient.prototype, 'callTool').mockResolvedValue({ content: [] });
    const server = await serveBrowserSession(
      {
        wsEndpoint: 'ws://127.0.0.1:1',
        sessionMode: 'existing',
        session: { enabled: true, key: 'replacement', retentionMs: 1000 },
      },
      token,
    );
    if (failure === 'close')
      close
        .mockRejectedValueOnce(new Error('close failed'))
        .mockRejectedValueOnce(new Error('close failed again'));
    else
      connect
        .mockRejectedValueOnce(new Error('connect failed'))
        .mockRejectedValueOnce(new Error('connect failed again'));
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await request('call', { name: 'list_pages', args: {} })).status).toBe(409);
        expect(tunnels.every((tunnel) => !tunnel.alive)).toBe(true);
      }
      expect((await request('call', { name: 'list_pages', args: {} })).status).toBe(200);
      await server.stop();
      expect(tunnels).toHaveLength(3);
      expect(tunnels.every((tunnel) => !tunnel.alive)).toBe(true);
    } finally {
      await server.stop();
      for (const tunnel of tunnels) await tunnel.close();
      factory.mockRestore();
      connect.mockRestore();
      close.mockRestore();
      call.mockRestore();
    }
  });
  it('ends a detached local session when its live marker disappears before retention expires', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    let alive = true;
    const call = vi
      .spyOn(DevToolsClient.prototype, 'callTool')
      .mockImplementation(async (name, args) => ({
        content: [
          {
            type: 'text',
            text: name === 'new_page' ? `2: ${args.url}` : `\`\`\`json\n${alive}\n\`\`\``,
          },
        ],
      }));
    const outcomes: string[] = [];
    const server = await serveBrowserSession(
      {
        headless: true,
        sessionMode: 'isolated',
        session: { enabled: true, key: 'local-lost', retentionMs: 30000 },
      },
      token,
      {
        onStop: async (reason) => {
          outcomes.push(reason);
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      await request('call', { name: 'list_pages', args: {} });
      expect((await request('retain')).status).toBe(200);
      await request('detach');
      alive = false;
      await vi.waitFor(() => expect(outcomes).toEqual(['lost']), { timeout: 2500 });
    } finally {
      await server.stop();
      call.mockRestore();
    }
  });

  it('reports reattachment and expired retention accurately before the sweep', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const call = vi
      .spyOn(DevToolsClient.prototype, 'callTool')
      .mockImplementation(async (name, args) => ({
        content: [
          { type: 'text', text: name === 'new_page' ? `2: ${args.url}` : '```json\ntrue\n```' },
        ],
      }));
    const server = await serveBrowserSession(
      {
        headless: true,
        sessionMode: 'isolated',
        session: { enabled: true, key: 'local-status', retentionMs: 30000 },
      },
      token,
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    let now: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await request('attach');
      await request('call', { name: 'list_pages', args: {} });
      const retained = (await (await request('retain')).json()) as {
        result: { expiresAt: string };
      };
      await request('detach');
      expect(await (await request('attach')).json()).toMatchObject({ result: { resumed: true } });
      now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(retained.result.expiresAt) + 1);
      expect(await (await request('status')).json()).toMatchObject({
        result: { state: 'expired', expiresAt: retained.result.expiresAt, resumed: true },
      });
    } finally {
      now?.mockRestore();
      await server.stop();
      call.mockRestore();
    }
  });
  it.each([
    '9999999999999',
    Number.MAX_VALUE,
  ])('rejects malformed programmatic retention deadlines: %j', async (invalid) => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const rawCall = vi
      .spyOn(DevToolsClient.prototype, 'callTool')
      .mockResolvedValue({ content: [] });
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'invalid-retain', retentionMs: 1000 } },
      token,
      {
        adapter: {
          async acquire() {
            return { id: 'retain-instance', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
          },
          async retain() {
            const result = { expiresAt: Date.now() + 1000 };
            Object.assign(result, { expiresAt: invalid });
            return result;
          },
          async release() {},
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      expect((await request('call', { name: 'list_pages', args: {} })).status).toBe(200);
      expect((await request('retain')).status).toBe(409);
    } finally {
      await server.stop();
      rawCall.mockRestore();
    }
  });

  it.each([
    { alive: 'false' },
    { alive: 1 },
    { alive: true, expiresAt: NaN },
    { alive: true, expiresAt: 'tomorrow' },
    { alive: true, expiresAt: Number.MAX_VALUE },
  ])('rejects malformed programmatic status before using the browser: %j', async (invalid) => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const rawCall = vi
      .spyOn(DevToolsClient.prototype, 'callTool')
      .mockResolvedValue({ content: [] });
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'invalid-status', retentionMs: 1000 } },
      token,
      {
        adapter: {
          async acquire() {
            return { id: 'status-instance', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
          },
          async describe() {
            const result = { alive: true };
            Object.assign(result, invalid);
            return result;
          },
          async release() {},
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      expect((await request('call', { name: 'list_pages', args: {} })).status).toBe(409);
      expect(rawCall).not.toHaveBeenCalled();
    } finally {
      await server.stop();
      rawCall.mockRestore();
    }
  });

  it.each([
    'null',
    '{}',
    '{ acquire() {} }',
    '{ acquire() {}, release() {}, describe: true }',
  ])('rejects malformed adapter factories before exposing a browser: %s', async (returned) => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-browser-use-invalid-adapter-'));
    const module = join(directory, 'adapter.mjs');
    try {
      await writeFile(
        module,
        `export function createBrowserLifecycleAdapter() { return ${returned}; }`,
      );
      await expect(
        serveBrowserSession(
          {
            session: {
              enabled: true,
              key: 'invalid-module',
              retentionMs: 1000,
              adapterModule: module,
            },
          },
          randomBytes(32).toString('hex'),
        ),
      ).rejects.toThrow('lifecycle adapter');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('unblocks the request queue when cancelled creation ignores its signal', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    let entered!: () => void;
    let complete!: (value: ManagedBrowser) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const acquired = new Promise<ManagedBrowser>((resolve) => {
      complete = resolve;
    });
    const browser = { id: 'late-instance', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
    const released: string[] = [];
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'cancelled-acquire', retentionMs: 1000 } },
      token,
      {
        adapter: {
          acquire() {
            entered();
            return acquired;
          },
          async release(value) {
            released.push(value.id);
          },
        },
      },
    );
    const request = (action: string, args: object = {}, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
        ...(signal ? { signal } : {}),
      });
    try {
      await request('attach');
      const controller = new AbortController();
      const call = request('call', { name: 'list_pages', args: {} }, controller.signal);
      const failed = call.catch(() => undefined);
      await started;
      controller.abort();
      await failed;
      expect((await request('status', {}, AbortSignal.timeout(1000))).status).toBe(200);
    } finally {
      complete(browser);
      await server.stop();
    }
    expect(released).toEqual([browser.id]);
  });

  it('bounds provider cleanup even when a programmatic adapter ignores cancellation', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const outcomes: string[] = [];
    let entered!: () => void;
    const releasing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'unresponsive-release', retentionMs: 1000 } },
      token,
      {
        adapter: {
          async acquire() {
            throw new BrowserAcquisitionError({ id: 'known-paid-instance', connection: {} });
          },
          release() {
            entered();
            return new Promise(() => {});
          },
        },
        async onStop(reason) {
          outcomes.push(reason);
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      await request('call', { name: 'list_pages', args: {} });
      vi.useFakeTimers();
      const stopping = server.stop();
      await releasing;
      await vi.advanceTimersByTimeAsync(15_000);
      await stopping;
      expect(outcomes).toEqual(['cleanup-failed']);
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });

  it('keeps an uncertain creation fence without releasing an invalid provider ID', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const release = vi.fn(async () => {});
    const outcomes: string[] = [];
    let creates = 0;
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'invalid-adapter-id', retentionMs: 1000 } },
      token,
      {
        adapter: {
          async acquire() {
            creates++;
            return { id: '', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
          },
          release,
        },
        async onStop(reason) {
          outcomes.push(reason);
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      for (let attempt = 0; attempt < 2; attempt++)
        expect((await request('call', { name: 'list_pages', args: {} })).status).toBe(409);
      await server.stop();
      expect(creates).toBe(1);
      expect(release).not.toHaveBeenCalled();
      expect(outcomes).toEqual(['cleanup-failed']);
    } finally {
      await server.stop();
    }
  });

  it.each([
    { connection: {} },
    { connection: { wsEndpoint: 'https://example.com' } },
    { connection: { wsEndpoint: 'ws://127.0.0.1:1' }, expiresAt: NaN },
    { connection: { wsEndpoint: 'ws://127.0.0.1:1' }, expiresAt: Number.MAX_VALUE },
  ])('rejects malformed programmatic connections without using local Chrome: %j', async (value) => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const browser = { id: 'known-programmatic-instance', ...value };
    const saved: string[] = [];
    const released: string[] = [];
    let creates = 0;
    const rawCall = vi
      .spyOn(DevToolsClient.prototype, 'callTool')
      .mockResolvedValue({ content: [] });
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'malformed-programmatic', retentionMs: 1000 } },
      token,
      {
        adapter: {
          async acquire() {
            creates++;
            return browser;
          },
          async release(value) {
            released.push(value.id);
          },
        },
        async onAcquire(value) {
          saved.push(value.id);
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request('call', { name: 'list_pages', args: {} });
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain(browser.id);
      }
      expect(rawCall).not.toHaveBeenCalled();
      expect(creates).toBe(1);
      expect(saved).toEqual([browser.id]);
      const status = await request('status');
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ result: { providerDeadlineKnown: false } });
      await server.stop();
      expect(released).toEqual([browser.id]);
    } finally {
      await server.stop();
      rawCall.mockRestore();
    }
  });

  it('uses only the managed connection when static settings point at another browser', async () => {
    let discoveries = 0;
    const provider = createServer((req, res) => {
      if (req.url === '/json/version') {
        discoveries++;
        res.writeHead(503).end();
      } else res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw Error('No provider address');
    const url = `http://127.0.0.1:${address.port}`;
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const server = await serveBrowserSession(
      {
        wsEndpoint: 'ws://127.0.0.1:1',
        session: {
          enabled: true,
          key: 'authoritative-binding',
          retentionMs: 1000,
          backend: { release: { url: `${url}/release` } },
        },
      },
      token,
      { browser: { id: 'instance-a', connection: { browserUrl: url } } },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      await request('call', { name: 'list_pages', args: {} });
      expect(discoveries).toBe(1);
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it('allows a new client to attach immediately after the previous client process dies', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await once(child, 'spawn');
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'dead-owner', retentionMs: 15000 } },
      token,
    );
    const attach = (identity: string, pid: number) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'attach', owner: identity, pid }),
      });
    try {
      expect((await attach(owner, child.pid!)).status).toBe(200);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      expect((await attach(randomBytes(32).toString('hex'), process.pid)).status).toBe(200);
    } finally {
      child.kill();
      await server.stop();
    }
  });

  it('persists and releases a known handle after a malformed creation response without creating twice', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const browser = { id: 'known-paid-session', connection: {} };
    const saved: string[] = [];
    const released: string[] = [];
    const outcomes: string[] = [];
    let creates = 0;
    const server = await serveBrowserSession(
      { session: { enabled: true, key: 'invalid-response', retentionMs: 1000 } },
      token,
      {
        adapter: {
          async acquire() {
            creates++;
            throw new BrowserAcquisitionError(browser);
          },
          async release(value) {
            released.push(value.id);
          },
        },
        async onAcquire(value) {
          saved.push(value.id);
        },
        async onStop(reason) {
          outcomes.push(reason);
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request('call', { name: 'list_pages', args: {} });
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain(browser.id);
      }
      await request('detach');
      expect(creates).toBe(1);
      expect(saved).toEqual([browser.id]);
      expect(released).toEqual([browser.id]);
      expect(outcomes).toEqual(['closed']);
    } finally {
      await server.stop();
    }
  });

  it('aborts pending creation and releases a browser returned during shutdown', async () => {
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    let complete!: (browser: ManagedBrowser) => void;
    let entered!: () => void;
    let acquireSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<ManagedBrowser>((resolve) => {
      complete = resolve;
    });
    const released: string[] = [];
    const outcomes: string[] = [];
    const server = await serveBrowserSession(
      {
        headless: true,
        sessionMode: 'isolated',
        session: { enabled: true, key: 'shutdown-test', retentionMs: 1000 },
      },
      token,
      {
        adapter: {
          acquire(_config, signal) {
            acquireSignal = signal;
            entered();
            return pending;
          },
          async release(browser) {
            released.push(browser.id);
          },
        },
        async onStop(reason) {
          outcomes.push(reason);
        },
      },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    await request('attach');
    const call = request('call', { name: 'list_pages', args: {} });
    await started;
    const shutdown = server.stop('lost');
    const browser = {
      id: 'created-while-stopping',
      connection: { browserUrl: 'http://127.0.0.1:1' },
    };
    try {
      expect(acquireSignal?.aborted).toBe(true);
      complete(browser);
      await shutdown;
      await call;
      expect(released).toEqual(['created-while-stopping']);
      expect(outcomes).toEqual(['lost']);
    } finally {
      complete(browser);
      await call;
      await shutdown;
    }
  });
});
