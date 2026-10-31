import { getEventListeners } from 'node:events';
import type {
  ExtensionContext,
  ToolCallEvent,
  UserBashEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizePiToolCall, authorizeUserBash, resolvePiSecurityConfig } from '../extension.js';

const io = vi.hoisted(() => ({ open: vi.fn(), directory: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  open: io.open,
  opendir: io.directory,
}));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = {
  type: 'tool_call',
  toolCallId: 'test',
  toolName: 'write',
  input: { path: 'test.txt', content: 'hi' },
} as ToolCallEvent;
const context = (signal: AbortSignal) =>
  ({
    cwd: '/repo',
    signal,
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'test' },
    ui: { notify: vi.fn() },
  }) as unknown as ExtensionContext;
const state = () => ({
  settingsBacked: true,
  config: resolvePiSecurityConfig(),
  grants: [],
  auditLog: [],
});
const payload = Buffer.from(JSON.stringify({ 'pi-security': { profile: 'full-access' } }));
function file(content = payload) {
  return {
    stat: vi.fn().mockResolvedValue({ size: content.length, isFile: () => true }),
    read: vi.fn(async (buffer: Buffer, offset: number) => ({
      bytesRead: content.copy(buffer, offset, offset),
      buffer,
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('piSecurityExtension configuration refresh', () => {
  beforeEach(() => {
    io.open.mockReset().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    io.directory
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(
    ['open', 'stat', 'read', 'close', 'directory', 'iterator', 'policy-read'].flatMap((phase) =>
      ['caller', 'deadline'].flatMap((source) =>
        ['tool', 'bash'].map((entry) => ({ phase, source, entry })),
      ),
    ),
  )('fails closed on $entry $source during $phase without duplicate or late I/O', async ({
    phase,
    source,
    entry,
  }) => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = file();
    const closeDirectory = vi.fn().mockResolvedValue(undefined);
    const directory = {
      close: closeDirectory,
      async *[Symbol.asyncIterator]() {
        try {
          if (phase === 'iterator') await blocked;
          if (phase === 'iterator' || phase === 'policy-read') yield { name: 'policy.json' };
        } finally {
          await closeDirectory();
        }
      },
    };
    if (phase === 'open') io.open.mockReturnValueOnce(blocked.then(() => handle));
    else io.open.mockResolvedValueOnce(handle);
    if (phase === 'stat')
      handle.stat.mockImplementationOnce(async () => {
        await blocked;
        return { size: payload.length, isFile: () => true };
      });
    if (phase === 'read')
      handle.read.mockImplementationOnce(async (buffer: Buffer) => {
        await blocked;
        return { bytesRead: payload.copy(buffer), buffer };
      });
    if (phase === 'close') handle.close.mockImplementationOnce(() => blocked);
    if (phase === 'directory') io.directory.mockReturnValueOnce(blocked.then(() => directory));
    if (phase === 'iterator' || phase === 'policy-read')
      io.directory.mockResolvedValueOnce(directory);
    const policy = file();
    if (phase === 'policy-read') {
      io.open.mockImplementation(async (path: string) => {
        if (path.endsWith('/policy.json')) return policy;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });
      policy.read.mockImplementationOnce(async (buffer: Buffer) => {
        await blocked;
        return { bytesRead: payload.copy(buffer), buffer };
      });
    }
    const controller = new AbortController();
    const retryController = new AbortController();
    const cached = state();
    const run = (signal: AbortSignal) =>
      entry === 'tool'
        ? authorizePiToolCall(event, context(signal), cached)
        : authorizeUserBash(
            { command: 'touch test.txt', cwd: '/repo' } as UserBashEvent,
            context(signal),
            cached,
          );
    let settled = false;
    const pending = run(controller.signal).then((result) => {
      settled = true;
      return result;
    });
    let retry: Promise<unknown> | undefined;
    const denied =
      entry === 'tool'
        ? { block: true }
        : { result: expect.objectContaining({ exitCode: 1, cancelled: source === 'caller' }) };
    try {
      await tick();
      const calls = {
        open: io.open.mock.calls.length,
        stat: handle.stat.mock.calls.length,
        read: handle.read.mock.calls.length,
        dir: io.directory.mock.calls.length,
      };
      if (source === 'caller') controller.abort();
      else await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(settled).toBe(true);
      expect(await pending).toEqual(expect.objectContaining(denied));
      retry = run(retryController.signal);
      await tick();
      expect(io.open).toHaveBeenCalledTimes(calls.open);
      expect(io.directory).toHaveBeenCalledTimes(calls.dir);
      retryController.abort();
      expect(await retry).toEqual(
        expect.objectContaining(
          entry === 'tool'
            ? { block: true }
            : { result: expect.objectContaining({ exitCode: 1, cancelled: true }) },
        ),
      );
      expect(vi.getTimerCount()).toBe(0);
      finish();
      await tick();
      expect(io.open).toHaveBeenCalledTimes(calls.open);
      expect(handle.stat).toHaveBeenCalledTimes(calls.stat);
      expect(handle.read).toHaveBeenCalledTimes(calls.read);
      expect(io.directory).toHaveBeenCalledTimes(calls.dir);
      expect(cached.config.profile).toBe('auto-review');
    } finally {
      controller.abort();
      retryController.abort();
      finish();
      await pending;
      await retry;
      await tick();
    }
    expect(handle.close).toHaveBeenCalledOnce();
    if (phase === 'directory' || phase === 'iterator' || phase === 'policy-read')
      expect(closeDirectory).toHaveBeenCalledOnce();
  });
  it('shares one budget across settings and policy body reads', async () => {
    const settings = file();
    const policy = file();
    settings.read.mockImplementationOnce(async (buffer: Buffer) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { bytesRead: payload.copy(buffer), buffer };
    });
    policy.read.mockImplementationOnce(async (buffer: Buffer) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { bytesRead: payload.copy(buffer), buffer };
    });
    io.open.mockResolvedValueOnce(settings).mockImplementation(async (path: string) => {
      if (path.endsWith('/policy.json')) return policy;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    io.directory.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { name: 'policy.json' };
      },
    });
    const cached = state();
    let settled = false;
    const pending = authorizePiToolCall(event, context(new AbortController().signal), cached).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    try {
      await tick();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(policy.read).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending)?.block).toBe(true);
      expect(policy.close).not.toHaveBeenCalled();
      expect(cached.config.profile).toBe('auto-review');
    } finally {
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      await tick();
    }
    expect(policy.close).toHaveBeenCalledOnce();
    expect(policy.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives queued retries their own bounded wait without starting duplicate reads', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = file();
    io.open.mockReturnValueOnce(blocked.then(() => handle));
    const first = new AbortController();
    const second = new AbortController();
    const a = authorizePiToolCall(event, context(first.signal), state());
    let b: ReturnType<typeof authorizePiToolCall> | undefined;
    try {
      await tick();
      await vi.advanceTimersByTimeAsync(3_000);
      b = authorizePiToolCall(event, context(second.signal), state());
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await a)?.block).toBe(true);
      expect(io.open).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await b)?.block).toBe(true);
      expect(io.open).toHaveBeenCalledTimes(1);
      expect(getEventListeners(first.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(second.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await a;
      await b;
      await tick();
    }
    expect(handle.stat).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('lets a cancelled waiter leave independently and reads fresh policy for the next caller', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = file();
    handle.read.mockImplementationOnce(async (buffer: Buffer) => {
      await blocked;
      return { bytesRead: payload.copy(buffer), buffer };
    });
    io.open.mockResolvedValueOnce(handle);
    const owner = new AbortController();
    const waiter = new AbortController();
    const a = authorizePiToolCall(event, context(owner.signal), state());
    let b: ReturnType<typeof authorizePiToolCall> | undefined;
    let c: ReturnType<typeof authorizePiToolCall> | undefined;
    try {
      await tick();
      const path = io.open.mock.calls[0]![0];
      const fresh = file(
        Buffer.from(JSON.stringify({ 'pi-security': { profile: 'auto-review' } })),
      );
      io.open.mockImplementation(async (candidate: string) => {
        if (candidate === path) return fresh;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });
      b = authorizePiToolCall(event, context(waiter.signal), state());
      c = authorizePiToolCall(event, context(new AbortController().signal), state());
      waiter.abort();
      expect((await b)?.block).toBe(true);
      expect(owner.signal.aborted).toBe(false);
      expect(io.open).toHaveBeenCalledTimes(1);
      finish();
      expect(await a).toBeUndefined();
      expect((await c)?.block).toBe(true);
      expect(fresh.read).toHaveBeenCalled();
      expect(getEventListeners(owner.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      owner.abort();
      waiter.abort();
      await a;
      await b;
      await c;
      await tick();
    }
  });
});
