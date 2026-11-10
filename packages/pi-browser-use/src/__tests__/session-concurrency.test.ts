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
  localMarker = false,
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
  const binding = {
    id: 'same-browser',
    connection: localMarker
      ? { headless: true, sessionMode: 'isolated' as const }
      : { wsEndpoint: 'ws://127.0.0.1:1' },
  };
  const acquire = vi.fn(async () => binding);
  const server = await serveBrowserSession(
    {
      headless: true,
      sessionMode: 'isolated',
      session: { enabled: true, key: 'concurrent-test', retentionMs: 30000 },
    },
    token,
    {
      adapter: {
        ...(localMarker ? { ownership: 'local' as const } : {}),
        acquire,
        async release() {},
        ...overrides,
      },
    },
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

  it('removes a cancelled exclusive barrier so another page can progress', async () => {
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const held = deferred();
    const started = deferred();
    let finished = false;
    const session = await openSession(async (name, args) => {
      if (name === 'wait_for') {
        started.resolve();
        await held.promise;
        finished = true;
      }
      if (name === 'take_snapshot' && args.pageId === 1) expect(finished).toBe(true);
      return { content: [] };
    });
    const first = session.request(
      'call',
      { name: 'wait_for', args: { pageId: 1, text: ['ready'] } },
      AbortSignal.timeout(10000),
    );
    let cancelled: Promise<unknown> | undefined;
    let surviving: Promise<unknown> | undefined;
    try {
      await started.promise;
      const abort = new AbortController();
      cancelled = session
        .request(
          'call',
          { name: 'evaluate_script', args: { pageId: 1, function: '() => true' } },
          abort.signal,
        )
        .catch(() => undefined);
      await session.request('heartbeat');
      abort.abort();
      await cancelled;
      await vi.waitFor(() =>
        expect(diagnostics).toHaveBeenCalledWith(
          '[pi-browser-use] browser session operation failed (phase=queue, category=cancelled)',
        ),
      );
      surviving = session.request('call', { name: 'take_snapshot', args: { pageId: 1 } });
      expect(await session.request('call', { name: 'take_snapshot', args: { pageId: 2 } })).toEqual(
        { result: { content: [] } },
      );
      held.resolve();
      expect(await surviving).toEqual({ result: { content: [] } });
      expect(session.call.mock.calls.some(([name]) => name === 'evaluate_script')).toBe(false);
    } finally {
      held.resolve();
      await Promise.allSettled([first, cancelled, surviving]);
      await session.server.stop();
    }
  });

  it.each([
    'tool',
    'preparation',
  ] as const)('reuses admission slots released by cancellation during %s', async (stage) => {
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const held = deferred();
    const started = deferred();
    const session = await openSession(
      async (name) => {
        if (name === 'wait_for' && stage === 'tool') {
          started.resolve();
          await held.promise;
        }
        return { content: [] };
      },
      {
        async acquire() {
          if (stage === 'preparation') {
            started.resolve();
            await held.promise;
          }
          return { id: 'same-browser', connection: { wsEndpoint: 'ws://127.0.0.1:1' } };
        },
      },
    );
    const first = session.request(
      'call',
      { name: 'wait_for', args: { pageId: 1, text: ['ready'] } },
      AbortSignal.timeout(10000),
    );
    try {
      await started.promise;
      for (let index = 0; index < 7; index++) {
        diagnostics.mockClear();
        const abort = new AbortController();
        const cancelled = session
          .request(
            'call',
            { name: 'click', args: { pageId: stage === 'tool' ? 1 : index + 2, uid: 'old' } },
            abort.signal,
          )
          .catch(() => undefined);
        await session.request('heartbeat');
        abort.abort();
        await cancelled;
        await vi.waitFor(() =>
          expect(diagnostics).toHaveBeenCalledWith(
            '[pi-browser-use] browser session operation failed (phase=queue, category=cancelled)',
          ),
        );
      }
      const independent = session.request('call', { name: 'take_snapshot', args: { pageId: 99 } });
      if (stage === 'preparation') {
        await session.request('heartbeat');
        held.resolve();
      }
      expect(await independent).toEqual({ result: { content: [] } });
      expect(session.call.mock.calls.some(([name]) => name === 'click')).toBe(false);
    } finally {
      held.resolve();
      await first;
      await session.server.stop();
    }
  });

  it('cancels active siblings when marker preparation becomes stalled', async () => {
    const started = deferred();
    const verifying = deferred();
    let nonce = '',
      checks = 0;
    let siblingSignal: AbortSignal | undefined;
    const session = await openSession(
      async (name, args, signal) => {
        if (name === 'new_page')
          return { content: [{ type: 'text', text: '99: about:blank [selected]' }] };
        if (name === 'evaluate_script') {
          nonce = /__piBrowserRetention = "([a-f0-9]+)"/.exec(String(args.function))?.[1] ?? nonce;
          return { content: [{ type: 'text', text: '```json\ntrue\n```' }] };
        }
        if (name === 'take_snapshot' && args.pageId === 99) {
          if (++checks > 1) {
            verifying.resolve();
            await new Promise((_resolve, reject) =>
              signal!.addEventListener(
                'abort',
                () => {
                  session.state.mockReturnValue('stalled');
                  reject(signal!.reason);
                },
                { once: true },
              ),
            );
          }
          return { content: [{ type: 'text', text: `Pi live browser marker: ${nonce}` }] };
        }
        if (name === 'wait_for') {
          siblingSignal = signal;
          started.resolve();
          await new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
          );
        }
        return { content: [] };
      },
      {},
      true,
    );
    const requests: Promise<unknown>[] = [];
    try {
      await session.request('call', { name: 'list_pages', args: {} });
      await session.request('retain');
      requests.push(
        session.request(
          'call',
          { name: 'wait_for', args: { pageId: 1, text: ['ready'] } },
          AbortSignal.timeout(10000),
        ),
      );
      await started.promise;
      const abort = new AbortController();
      requests.push(
        session
          .request('call', { name: 'take_snapshot', args: { pageId: 2 } }, abort.signal)
          .catch(() => undefined),
      );
      await verifying.promise;
      abort.abort();
      await vi.waitFor(() => expect(siblingSignal?.aborted).toBe(true));
      await Promise.all(requests);
      expect(
        session.call.mock.calls.some(
          ([name, args]) => name === 'take_snapshot' && args.pageId === 2,
        ),
      ).toBe(false);
    } finally {
      await session.server.stop();
      await Promise.allSettled(requests);
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
