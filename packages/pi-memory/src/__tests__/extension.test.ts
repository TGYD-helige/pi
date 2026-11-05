import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import memoryExtension from '../extension.js';
import { MemoryStore } from '../store.js';

const { runDreamMock } = vi.hoisted(() => ({
  runDreamMock: vi.fn(),
}));

vi.mock('../dream.js', () => ({
  runDream: runDreamMock,
}));
const TEST_ROOT = path.join(tmpdir(), 'pi-memory-extension-test');

describe('memoryExtension', () => {
  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    runDreamMock.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('starts dreaming and ignores late failures after session shutdown', async () => {
    let finishDream: (() => void) | undefined;
    runDreamMock.mockReturnValue(
      new Promise<boolean>((_resolve, reject) => {
        finishDream = () => reject(new Error('late dream failure'));
      }),
    );
    const dir = path.join(TEST_ROOT, `dream-${Date.now()}`);
    const store = new MemoryStore({ dir });
    await store.loadFromDisk();

    const eventHandlers: Record<
      string,
      Array<(event: unknown, ctx: unknown) => Promise<void>>
    > = {};
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        eventHandlers[event] ??= [];
        eventHandlers[event].push(handler);
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      appendEntry: vi.fn(),
    };
    const ctx = {
      cwd: dir,
      signal: new AbortController().signal,
      sessionManager: {
        getSessionDir: () => path.join(dir, 'sessions'),
        getBranch: () => [],
        getEntries: () => [],
        getSessionId: () => 'test-session',
      },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
    };

    memoryExtension(pi as never, {
      store,
      dataDir: dir,
      dreaming: { minHoursSinceLastRun: 12 },
    });
    for (const handler of eventHandlers.session_start ?? []) {
      await handler({}, ctx);
    }

    expect(runDreamMock).toHaveBeenCalledWith({
      dreaming: { minHoursSinceLastRun: 12 },
      includeGlobalSessions: false,
      memoryDir: dir,
      modelRegistry: ctx.modelRegistry,
      sessionDir: path.join(dir, 'sessions'),
      signal: expect.any(AbortSignal),
    });
    const dreamSignal = runDreamMock.mock.calls[0]![0].signal as AbortSignal;
    expect(dreamSignal.aborted).toBe(false);
    for (const handler of eventHandlers.session_shutdown ?? []) await handler({}, ctx);
    expect(dreamSignal.aborted).toBe(true);
    Object.defineProperty(ctx, 'signal', {
      get: () => {
        throw new Error('stale context');
      },
    });
    Object.defineProperty(ctx, 'ui', {
      get: () => {
        throw new Error('stale UI');
      },
    });
    finishDream?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('scans global sessions only for the default global store', async () => {
    const dir = path.join(TEST_ROOT, `global-${Date.now()}`);
    const previousHome = process.env.PI_AGENT_HOME;
    process.env.PI_AGENT_HOME = dir;
    try {
      const eventHandlers: Record<
        string,
        Array<(event: unknown, ctx: unknown) => Promise<void>>
      > = {};
      const pi = {
        on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
          eventHandlers[event] ??= [];
          eventHandlers[event].push(handler);
        },
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        appendEntry: vi.fn(),
      };
      const ctx = {
        cwd: dir,
        sessionManager: {
          getSessionDir: () => path.join(dir, 'sessions'),
          getBranch: () => [],
          getEntries: () => [],
          getSessionId: () => 'test-session',
        },
        ui: { notify: vi.fn(), setStatus: vi.fn() },
        modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
      };

      memoryExtension(pi as never);
      for (const handler of eventHandlers.session_start ?? []) await handler({}, ctx);

      expect(runDreamMock).toHaveBeenCalledWith({
        includeGlobalSessions: true,
        signal: expect.any(AbortSignal),
        memoryDir: path.join(dir, 'memories'),
        modelRegistry: ctx.modelRegistry,
        sessionDir: path.join(dir, 'sessions'),
      });
    } finally {
      if (previousHome === undefined) delete process.env.PI_AGENT_HOME;
      else process.env.PI_AGENT_HOME = previousHome;
    }
  });
});
