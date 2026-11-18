import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisLockManager } from '../redis-locks.js';

const redis = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failEval: false,
  evalCalls: [] as string[],
}));

vi.mock('ioredis', () => ({
  Redis: class {
    status = 'ready';
    on() {}
    async set(key: string, value: string) {
      if (redis.values.has(key)) return null;
      redis.values.set(key, value);
      return 'OK';
    }
    async eval(script: string, _keys: number, key: string, owner: string) {
      const kind = script.includes('PEXPIRE') ? 'extend' : 'release';
      redis.evalCalls.push(kind);
      if (redis.failEval) throw new Error('redis offline');
      if (redis.values.get(key) !== owner) return 0;
      if (kind === 'release') redis.values.delete(key);
      return 1;
    }
    async quit() {}
    disconnect() {}
  },
}));

const extendCalls = () => redis.evalCalls.filter((kind) => kind === 'extend').length;

describe('RedisLockManager', () => {
  beforeEach(() => {
    redis.values.clear();
    redis.failEval = false;
    redis.evalCalls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('only lets the owner extend or release a lock', async () => {
    const first = new RedisLockManager('redis://unused', 'first');
    const second = new RedisLockManager('redis://unused', 'second');
    expect(await first.acquire('job', 1_000)).toBe(true);
    expect(await second.acquire('job', 1_000)).toBe(false);
    expect(await second.extend('job', 1_000)).toBe(false);
    await second.release('job');
    expect(redis.values.get('job')).toBe('first');
    await first.release('job');
    expect(await second.acquire('job', 1_000)).toBe(true);
  });

  it('renews the lock while a long task runs and stops renewing afterwards', async () => {
    vi.useFakeTimers();
    const locks = new RedisLockManager('redis://unused', 'owner');
    let finish: () => void = () => {};
    const result = locks.withLock({
      key: 'job',
      ttlMs: 300,
      timeoutMs: 100,
      task: () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('done');
        }),
    });
    await vi.advanceTimersByTimeAsync(350);
    expect(extendCalls()).toBe(3);
    finish();
    await expect(result).resolves.toBe('done');
    expect(redis.values.has('job')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(extendCalls()).toBe(3);
  });

  it('keeps the task outcome when releasing the lock fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const locks = new RedisLockManager('redis://unused', 'owner');
    redis.failEval = true;
    await expect(
      locks.withLock({ key: 'ok', ttlMs: 1_000, timeoutMs: 100, task: async () => 'committed' }),
    ).resolves.toBe('committed');
    const failure = new Error('task failed');
    await expect(
      locks.withLock({
        key: 'bad',
        ttlMs: 1_000,
        timeoutMs: 100,
        task: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(errors).toHaveBeenCalledWith('[pi-storage] failed to release Redis lock');
  });

  it('times out without running the task when another owner keeps the lock', async () => {
    redis.values.set('job', 'other');
    const locks = new RedisLockManager('redis://unused', 'owner');
    const task = vi.fn(async () => 'never');
    await expect(
      locks.withLock({ key: 'job', ttlMs: 1_000, timeoutMs: 20, retryMs: 5, task }),
    ).rejects.toThrow('Timed out acquiring Redis lock: job');
    expect(task).not.toHaveBeenCalled();
  });
});
