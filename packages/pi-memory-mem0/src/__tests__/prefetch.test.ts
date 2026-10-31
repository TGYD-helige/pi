import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prefetch } from '../prefetch.js';
import type { Mem0Provider } from '../provider.js';

function pendingProvider(cancellable = true) {
  let finish: (value: []) => void = () => {};
  const search = vi.fn(
    (_query: string, _opts: { signal?: AbortSignal }) =>
      new Promise<[]>((resolve) => {
        finish = resolve;
      }),
  );
  const provider: Mem0Provider = {
    supportsSearchCancellation: cancellable,
    search,
    add: async () => null,
    getAll: async () => [],
    delete: async () => {},
  };
  return { provider, search, finish: () => finish([]) };
}

afterEach(() => vi.useRealTimers());

describe('Prefetch', () => {
  it('cancels a timed-out recall and clears its timer', async () => {
    vi.useFakeTimers();
    const { provider, search } = pendingProvider();
    const prefetch = new Prefetch(provider, 'user', { topK: 5 });
    prefetch.queue('query');
    const result = prefetch.consume();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBeUndefined();
    expect(search.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not accumulate uncancellable embedded searches after a timeout', async () => {
    vi.useFakeTimers();
    const { provider, search, finish } = pendingProvider(false);
    const prefetch = new Prefetch(provider, 'user', { topK: 5 });
    prefetch.queue('first');
    const result = prefetch.consume();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBeUndefined();
    prefetch.queue('second');
    expect(search).toHaveBeenCalledOnce();
    expect(await prefetch.consume()).toBeUndefined();
    finish();
    await Promise.resolve();
    prefetch.queue('third');
    expect(search).toHaveBeenCalledTimes(2);
    prefetch.cancel();
    finish();
  });

  it('preserves the embedded admission slot when intervening sessions use a cancellable backend', async () => {
    const searchState = { active: undefined };
    const { provider, search, finish } = pendingProvider(false);
    const embedded = new Prefetch(provider, 'user', { topK: 5, searchState });
    embedded.queue('old embedded query');
    embedded.cancel();
    const remote = new Prefetch({ ...pendingProvider().provider, search: async () => [] }, 'user', {
      topK: 5,
      searchState,
    });
    remote.queue('remote query');
    await remote.consume();
    const resumed = new Prefetch(provider, 'user', { topK: 5, searchState });
    resumed.queue('new embedded query');
    expect(search.mock.calls.length).toBe(1);
    finish();
    await Promise.resolve();
    resumed.queue('after completion');
    expect(search.mock.calls.length).toBe(2);
    resumed.cancel();
    finish();
  });

  it('returns matching memories before the deadline without leaving a timer', async () => {
    vi.useFakeTimers();
    const provider = {
      ...pendingProvider().provider,
      search: async () => [{ id: '1', memory: 'prefers TypeScript' }],
    };
    const prefetch = new Prefetch(provider, 'user', { topK: 5 });
    prefetch.queue('language');
    expect(await prefetch.consume()).toContain('prefers TypeScript');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels waiting when the session or caller cancels', async () => {
    const { provider, search, finish } = pendingProvider();
    const prefetch = new Prefetch(provider, 'user', { topK: 5 });
    const controller = new AbortController();
    prefetch.queue('query', controller.signal);
    const result = prefetch.consume();
    controller.abort();
    expect(await result).toBeUndefined();
    expect(search.mock.calls[0]![1].signal?.aborted).toBe(true);
    finish();
  });
  it('discards a replaced query and cancels the current query at shutdown', async () => {
    const { provider, search, finish } = pendingProvider();
    const prefetch = new Prefetch(provider, 'user', { topK: 5 });
    prefetch.queue('old');
    const oldResult = prefetch.consume();
    prefetch.queue('new');
    expect(await oldResult).toBeUndefined();
    expect(search.mock.calls[0]![1].signal?.aborted).toBe(true);
    const newResult = prefetch.consume();
    prefetch.cancel();
    expect(await newResult).toBeUndefined();
    expect(search.mock.calls[1]![1].signal?.aborted).toBe(true);
    finish();
  });
});
