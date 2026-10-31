import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

const sdk = vi.hoisted(() => ({
  constructed: vi.fn(),
  warmup: vi.fn(),
  search: vi.fn().mockResolvedValue([]),
  add: vi.fn().mockResolvedValue({ results: [] }),
  getAll: vi.fn().mockResolvedValue([]),
  delete: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('mem0ai/oss', () => ({
  Memory: class {
    constructor() {
      sdk.constructed();
    }
    search = sdk.search;
    add = sdk.add;
    delete = sdk.delete;
    getAll(options: { filters: { user_id: string } }) {
      return options.filters.user_id === '__warmup__' ? sdk.warmup() : sdk.getAll(options);
    }
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const options = { config: { mode: 'embedded' as const, oss: { disableHistory: true } } };

describe('embedded Mem0 readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns during warmup and gates every concurrent operation on one initialization', async () => {
    const warmup = deferred();
    sdk.warmup.mockReturnValue(warmup.promise);
    let provider: Awaited<ReturnType<typeof createMem0Provider>> | undefined;
    const factory = createMem0Provider(options).then((value) => {
      provider = value;
    });
    try {
      await vi.waitFor(() => expect(provider).toBeDefined());
      await vi.waitFor(() => expect(sdk.warmup).toHaveBeenCalledOnce());
      const operations = [
        provider!.search('query', { userId: 'u' }),
        provider!.getAll({ userId: 'u' }),
        provider!.getDedupGroups!({ userId: 'u' }),
        provider!.delete('id'),
        provider!.add([{ role: 'user', content: 'memory' }], { userId: 'u' }),
      ];
      await new Promise((resolve) => setImmediate(resolve));
      for (const operation of [sdk.search, sdk.getAll, sdk.delete, sdk.add])
        expect(operation).not.toHaveBeenCalled();
      warmup.resolve();
      await Promise.all(operations);
      expect(sdk.constructed).toHaveBeenCalledOnce();
      expect(sdk.warmup).toHaveBeenCalledOnce();
      expect(sdk.search).toHaveBeenCalledOnce();
      expect(sdk.getAll).toHaveBeenCalledTimes(2);
      expect(sdk.delete).toHaveBeenCalledOnce();
      expect(sdk.add).toHaveBeenCalledOnce();
    } finally {
      warmup.resolve();
      await factory;
    }
  });

  it.each([
    'construction',
    'warmup',
  ])('keeps %s failures observable by later operations', async (phase) => {
    const failure = new Error('SDK initialization failed');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (phase === 'construction')
      sdk.constructed.mockImplementationOnce(() => {
        throw failure;
      });
    const warmup = deferred();
    sdk.warmup.mockReturnValue(warmup.promise);
    const provider = await createMem0Provider(options);
    if (phase === 'warmup') {
      await vi.waitFor(() => expect(sdk.warmup).toHaveBeenCalledOnce());
      warmup.reject(failure);
    }
    await vi.waitFor(() =>
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        '[pi-memory-mem0] embedded initialization failed',
      ),
    );
    await expect(provider.search('query', { userId: 'u' })).rejects.toBe(failure);
    await expect(provider.getAll({ userId: 'u' })).rejects.toBe(failure);
    expect(sdk.constructed).toHaveBeenCalledOnce();
    expect(sdk.search).not.toHaveBeenCalled();
    expect(sdk.getAll).not.toHaveBeenCalled();
  });

  it('cancels only one waiter while initialization continues for other operations', async () => {
    const warmup = deferred();
    sdk.warmup.mockReturnValue(warmup.promise);
    const provider = await createMem0Provider(options);
    const controller = new AbortController();
    const cancelled = provider.search('cancelled', { userId: 'u', signal: controller.signal });
    const surviving = provider.search('surviving', { userId: 'u' });
    try {
      await vi.waitFor(() => expect(sdk.warmup).toHaveBeenCalledOnce());
      controller.abort(new Error('caller cancelled'));
      await expect(cancelled).rejects.toThrow('caller cancelled');
      expect(sdk.search).not.toHaveBeenCalled();
      warmup.resolve();
      await expect(surviving).resolves.toEqual([]);
      expect(sdk.search).toHaveBeenCalledExactlyOnceWith('surviving', {
        filters: { user_id: 'u' },
      });
      expect(sdk.constructed).toHaveBeenCalledOnce();
    } finally {
      warmup.resolve();
      await Promise.allSettled([cancelled, surviving]);
    }
  });
});
