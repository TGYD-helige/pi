import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevToolsClient } from '../index.js';
import type { BrowserLifecycleAdapter } from '../session-backend.js';
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

async function openSession(
  handler: DevToolsClient['callTool'],
  overrides: Partial<BrowserLifecycleAdapter> = {},
) {
  const token = randomBytes(32).toString('hex');
  const owner = randomBytes(32).toString('hex');
  const state = vi.spyOn(DevToolsClient.prototype, 'getState').mockReturnValue('ready');
  const connect = vi.spyOn(DevToolsClient.prototype, 'connect').mockImplementation(async () => {
    state.mockReturnValue('ready');
  });
  vi.spyOn(DevToolsClient.prototype, 'ensureReady').mockResolvedValue();
  const close = vi.spyOn(DevToolsClient.prototype, 'close').mockResolvedValue();
  const call = vi.spyOn(DevToolsClient.prototype, 'callTool').mockImplementation(handler);
  const binding = { id: 'same-browser', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
  const acquire = vi.fn(async () => binding);
  const server = await serveBrowserSession(
    { session: { enabled: true, key: 'concurrent-test', retentionMs: 30000 } },
    token,
    { adapter: { acquire, async release() {}, ...overrides } },
  );
  const request = async (action: string, data: object = {}, signal = AbortSignal.timeout(2000)) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ owner, action, ...data }),
      signal,
    });
    return response.json();
  };
  await request('attach');
  return { server, request, state, connect, close, call, acquire, binding };
}

describe('browser session concurrency', () => {
  afterEach(() => vi.restoreAllMocks());

  it('acquires once when first calls arrive during browser creation', async () => {
    const acquiring = deferred();
    const acquired = deferred();
    const started = [deferred(), deferred()];
    const complete = deferred();
    const acquire = vi.fn(async () => {
      acquiring.resolve();
      await acquired.promise;
      return { id: 'same-browser', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
    });
    const session = await openSession(
      async (_name, args) => {
        started[Number(args.pageId) - 1]!.resolve();
        await complete.promise;
        return { content: [] };
      },
      { acquire },
    );
    const requests = [1, 2].map((pageId) =>
      session.request('call', { name: 'take_snapshot', args: { pageId } }),
    );
    try {
      await acquiring.promise;
      expect(await session.request('heartbeat')).toEqual({ result: {} });
      acquired.resolve();
      await Promise.all(started.map((item) => item.promise));
      expect(acquire).toHaveBeenCalledOnce();
      complete.resolve();
      await Promise.all(requests);
    } finally {
      acquired.resolve();
      complete.resolve();
      await Promise.allSettled(requests);
      await session.server.stop();
    }
  });

  it('bounds admitted tool work while keeping heartbeats responsive and acquisition single-flight', async () => {
    const pending = deferred();
    const started = Array.from({ length: 8 }, deferred);
    let calls = 0;
    const session = await openSession(async () => {
      started[calls++]?.resolve();
      await pending.promise;
      return { content: [] };
    });
    const requests: Promise<unknown>[] = [];
    try {
      for (let pageId = 1; pageId <= 8; pageId++) {
        requests.push(session.request('call', { name: 'take_snapshot', args: { pageId } }));
        await started[pageId - 1]!.promise;
      }
      expect(session.acquire).toHaveBeenCalledOnce();
      expect(await session.request('heartbeat')).toEqual({ result: {} });
      expect(
        await session.request('heartbeat', { owner: randomBytes(32).toString('hex') }),
      ).toMatchObject({ error: expect.stringContaining('not attached') });
      expect(
        await session.request('call', { name: 'click', args: { pageId: 1, uid: 'old' } }),
      ).toMatchObject({
        error: expect.stringContaining('was not dispatched'),
      });
      expect(calls).toBe(8);
      pending.resolve();
      await Promise.all(requests);
      expect(await session.request('call', { name: 'take_snapshot', args: { pageId: 1 } })).toEqual(
        { result: { content: [] } },
      );
    } finally {
      pending.resolve();
      await Promise.allSettled(requests);
      await session.server.stop();
    }
  });

  it('waits for earlier tools before retaining and skips a later call cancelled behind that barrier', async () => {
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const active = deferred();
    const activeStarted = deferred();
    const retaining = deferred();
    const retained = deferred();
    let activeFinished = false;
    const session = await openSession(
      async () => {
        activeStarted.resolve();
        await active.promise;
        activeFinished = true;
        return { content: [] };
      },
      {
        async retain(_browser, expiresAt) {
          expect(activeFinished).toBe(true);
          retaining.resolve();
          await retained.promise;
          return { expiresAt };
        },
      },
    );
    let first: Promise<unknown> | undefined;
    let retain: Promise<unknown> | undefined;
    let cancelled: Promise<unknown> | undefined;
    try {
      first = session.request('call', { name: 'wait_for', args: { pageId: 1, text: ['ready'] } });
      await activeStarted.promise;
      retain = session.request('retain');
      expect(await session.request('heartbeat')).toEqual({ result: {} });
      expect(activeFinished).toBe(false);
      active.resolve();
      await retaining.promise;
      const abort = new AbortController();
      cancelled = session
        .request('call', { name: 'click', args: { pageId: 2, uid: 'stale' } }, abort.signal)
        .catch(() => undefined);
      expect(await session.request('heartbeat')).toEqual({ result: {} });
      abort.abort();
      await cancelled;
      await vi.waitFor(() =>
        expect(diagnostics).toHaveBeenCalledWith(
          '[pi-browser-use] browser session operation failed (phase=queue, category=cancelled)',
        ),
      );
      retained.resolve();
      await Promise.all([first, retain]);
      await session.request('status');
      expect(session.call.mock.calls.map(([name]) => name)).toEqual(['wait_for']);
    } finally {
      active.resolve();
      retained.resolve();
      await Promise.allSettled([first, retain, cancelled]);
      await session.server.stop();
    }
  });

  it('cancels sibling tools before replacing a stalled transport and never replays the waiting action', async () => {
    const failed = deferred();
    const started = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    const session = await openSession(
      async (name, args, signal) => {
        if (name === 'list_pages') return { content: [] };
        const index = Number(args.pageId) - 1;
        signals[index] = signal!;
        started[index]!.resolve();
        if (index === 0) await failed.promise;
        else
          await new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
          );
        return { content: [] };
      },
      {
        async reconnect(browser) {
          expect(browser.id).toBe('same-browser');
          expect(signals[1]!.aborted).toBe(true);
          return { wsEndpoint: 'ws://127.0.0.1:1' };
        },
      },
    );
    const requests: Promise<unknown>[] = [];
    try {
      for (let pageId = 1; pageId <= 2; pageId++) {
        requests.push(
          session.request('call', { name: 'wait_for', args: { pageId, text: ['ready'] } }),
        );
        await started[pageId - 1]!.promise;
      }
      session.state.mockReturnValue('stalled');
      failed.reject(new DOMException('tool deadline', 'TimeoutError'));
      await Promise.all(requests);
      const result = await session.request('call', {
        name: 'click',
        args: { pageId: 1, uid: 'stale' },
      });
      expect(result).toMatchObject({
        error: expect.stringContaining('MCP subprocess was replaced'),
      });
      expect(session.call.mock.calls.map(([name]) => name)).toEqual([
        'wait_for',
        'wait_for',
        'list_pages',
      ]);
    } finally {
      failed.resolve();
      await session.server.stop();
      await Promise.allSettled(requests);
    }
  });

  it('rejects requests admitted before a transport replacement instead of using stale identifiers', async () => {
    const reconnecting = deferred();
    const reconnected = deferred();
    const session = await openSession(async () => ({ content: [] }), {
      async reconnect() {
        reconnecting.resolve();
        await reconnected.promise;
        return { wsEndpoint: 'ws://127.0.0.1:1' };
      },
    });
    const requests: Promise<unknown>[] = [];
    try {
      await session.request('call', { name: 'list_pages', args: {} });
      session.state.mockReturnValue('stalled');
      requests.push(session.request('call', { name: 'list_pages', args: {} }));
      await reconnecting.promise;
      for (let pageId = 1; pageId <= 7; pageId++)
        requests.push(session.request('call', { name: 'click', args: { pageId, uid: 'old_uid' } }));
      expect(
        await session.request('call', { name: 'click', args: { pageId: 8, uid: 'old_uid' } }),
      ).toMatchObject({ error: expect.stringContaining('was not dispatched') });
      reconnected.resolve();
      const [notice, ...stale] = await Promise.all(requests);
      expect(notice).toMatchObject({
        error: expect.stringContaining('MCP subprocess was replaced'),
      });
      for (const result of stale)
        expect(result).toMatchObject({ error: expect.stringContaining('was not dispatched') });
      expect(session.call.mock.calls.some(([name]) => name === 'click')).toBe(false);
    } finally {
      reconnected.resolve();
      await Promise.allSettled(requests);
      await session.server.stop();
    }
  });

  it('settles cancelled tools before releasing the browser on shutdown', async () => {
    const entered = deferred();
    let finished = false;
    const release = vi.fn(async () => {
      expect(finished).toBe(true);
    });
    const session = await openSession(
      async (_name, _args, signal) => {
        entered.resolve();
        try {
          await new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
          );
          return { content: [] };
        } finally {
          finished = true;
        }
      },
      { release },
    );
    const call = session.request('call', {
      name: 'wait_for',
      args: { pageId: 1, text: ['ready'] },
    });
    try {
      await entered.promise;
      await session.server.stop();
      await call;
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await session.server.stop();
      await call;
    }
  });
});
