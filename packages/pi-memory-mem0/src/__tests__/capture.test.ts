import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CapturedTurn, CaptureQueue, type CaptureState } from '../capture.js';
import type { Mem0Provider } from '../provider.js';

const turn: CapturedTurn = {
  messages: [
    { role: 'user', content: 'tea' },
    { role: 'assistant', content: 'noted' },
  ],
  observedAt: '2026-10-31T00:00:00Z',
};
function provider(add = vi.fn().mockResolvedValue({ results: [] })): Mem0Provider {
  return { add, search: vi.fn(), getAll: vi.fn(), delete: vi.fn() };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('CaptureQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('keeps slow background extraction running past five seconds and drains subsequent captures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('deadline')), ms);
      return controller.signal;
    });
    let finish!: (value: { results: [] }) => void;
    const backend = provider(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue({ results: [] }),
    );
    const save = vi.fn();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save);
    queue.enqueue(turn);
    queue.enqueue({
      ...turn,
      messages: [
        { role: 'user', content: 'coffee' },
        { role: 'assistant', content: 'noted' },
      ],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    finish({ results: [] });
    await settled();
    expect(backend.add).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith([]);
    queue.close();
  });

  it('reconciles a late uncancellable extraction and continues without replaying it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let finish!: (value: { results: [] }) => void;
    const backend = provider(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue({ results: [] }),
    );
    const save = vi.fn();
    const notify = vi.fn();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save, [], notify);
    queue.enqueue(turn);
    queue.enqueue({ ...turn });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/still running/));
    expect(backend.add).toHaveBeenCalledTimes(1);
    finish({ results: [] });
    await settled();
    expect(backend.add).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith([]);
    queue.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('persists accepted turns before sending, bounds admission, and closes without waiting', async () => {
    const backend = provider(vi.fn(() => new Promise(() => {})));
    const save = vi.fn();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save);
    for (let i = 0; i < 16; i++) expect(queue.enqueue(turn)).toBe(true);
    expect(queue.enqueue(turn)).toBe(false);
    expect(save).toHaveBeenCalledTimes(16);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.add).mock.invocationCallOrder[0]!,
    );
    expect(backend.add).toHaveBeenCalledTimes(1);
    queue.close();
    expect(save.mock.calls.at(-1)?.[0]).toHaveLength(16);
  });

  it('recovers pending turns with their original observation date and clears confirmed writes', async () => {
    const backend = provider();
    const save = vi.fn();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save, [turn]);
    queue.start();
    await settled();
    expect(backend.add).toHaveBeenCalledWith(turn.messages, {
      userId: 'alice',
      observedAt: turn.observedAt,
      timeoutMs: 120_000,
    });
    expect(save).toHaveBeenLastCalledWith([]);
    queue.close();
  });

  it('cancels network writes at shutdown and retains ambiguous outcomes for resume', async () => {
    let signal: AbortSignal | undefined;
    const backend = provider(
      vi.fn((_messages, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
        );
      }),
    );
    Object.assign(backend, { supportsAddCancellation: true });
    const save = vi.fn();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save);
    queue.enqueue(turn);
    queue.close();
    await settled();
    expect(signal?.aborted).toBe(true);
    expect(save).toHaveBeenLastCalledWith([turn]);
  });

  it('keeps embedded operations single-flight across sessions until the raw write settles', async () => {
    let finish!: (result: { results: [] }) => void;
    const old = provider(
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const state: CaptureState = {};
    const first = new CaptureQueue(old, { userId: 'alice' }, state, vi.fn());
    first.enqueue(turn);
    first.close();
    const next = provider();
    const second = new CaptureQueue(next, { userId: 'bob' }, state, vi.fn());
    second.enqueue(turn);
    expect(next.add).not.toHaveBeenCalled();
    finish({ results: [] });
    await settled();
    expect(next.add).toHaveBeenCalledTimes(1);
    second.close();
  });

  it('does not send data whose durable snapshot failed', () => {
    const backend = provider();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, () => {
      throw new Error('disk full');
    });
    expect(() => queue.enqueue(turn)).toThrow('disk full');
    expect(backend.add).not.toHaveBeenCalled();
    queue.close();
  });

  it('propagates caller cancellation while retaining the accepted snapshot', async () => {
    const backend = provider(vi.fn(() => new Promise(() => {})));
    Object.assign(backend, { supportsAddCancellation: true });
    const save = vi.fn();
    const controller = new AbortController();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save);
    queue.enqueue(turn, controller.signal);
    controller.abort();
    queue.close();
    await settled();
    expect(vi.mocked(backend.add).mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(save).toHaveBeenLastCalledWith([turn]);
  });

  it('rejects oversized captures without persisting or sending them', () => {
    const backend = provider();
    const save = vi.fn();
    const queue = new CaptureQueue(backend, { userId: 'alice' }, {}, save);
    expect(
      queue.enqueue({ ...turn, messages: [{ role: 'user', content: 'x'.repeat(64_001) }] }),
    ).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(backend.add).not.toHaveBeenCalled();
    queue.close();
  });
});
