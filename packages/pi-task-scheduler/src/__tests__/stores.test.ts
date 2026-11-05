import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersistentTaskScheduler,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskSchedulerScope,
} from '../index.js';
import { FileSchedulerLock, JsonScheduledTaskStore } from '../stores.js';

const TEST_DIR = path.join(tmpdir(), 'pi-task-scheduler-test');

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: 'test-session',
    prompt: 'test prompt',
    type: 'interval',
    schedule: '10m',
    intervalSeconds: 600,
    enabled: true,
    model: { provider: 'test', model: 'test-model' },
    toolPolicyProfile: 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe('JsonScheduledTaskStore', () => {
  it('does not replace corrupt task data with a fresh task', async () => {
    const file = path.join(TEST_DIR, 'corrupt.json');
    writeFileSync(file, '{broken');
    const store = new JsonScheduledTaskStore(file);
    await expect(store.create(makeTask())).rejects.toThrow(/backup/i);
  });

  it('scopes reads and mutations to the owning session', async () => {
    const store = new JsonScheduledTaskStore(path.join(TEST_DIR, 'scoped.json'));
    const first = await store.create(makeTask({ id: 'first', sessionId: 'session-a' }));
    await store.create(makeTask({ id: 'second', sessionId: 'session-b' }));

    await expect(store.list({ sessionId: 'session-a' })).resolves.toEqual([first]);
    await expect(store.get('second', { sessionId: 'session-a' })).resolves.toBeUndefined();
    await expect(store.delete('second', { sessionId: 'session-a' })).resolves.toBe(false);
    await expect(store.get('second')).resolves.toBeDefined();
  });
  const filePath = path.join(TEST_DIR, 'tasks.json');

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(filePath)) rmSync(filePath);
    if (existsSync(`${filePath}.bak`)) rmSync(`${filePath}.bak`);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates and lists tasks', async () => {
    const store = new JsonScheduledTaskStore(filePath);
    const task = makeTask({ id: 'task-1' });

    const created = await store.create(task);
    expect(created.id).toBe('task-1');

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('task-1');
  });

  it('serializes concurrent creates without losing tasks', async () => {
    const store = new JsonScheduledTaskStore(filePath);
    const tasks = Array.from({ length: 20 }, (_, index) => makeTask({ id: `task-${index}` }));

    await Promise.all(tasks.map((task) => store.create(task)));

    const reloaded = await new JsonScheduledTaskStore(filePath).list();
    expect(reloaded.map((task) => task.id).sort()).toEqual(tasks.map((task) => task.id).sort());
  });

  it('gets a task by id', async () => {
    const store = new JsonScheduledTaskStore(filePath);
    await store.create(makeTask({ id: 'task-get' }));

    const found = await store.get('task-get');
    expect(found?.id).toBe('task-get');

    const notFound = await store.get('nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('updates an existing task', async () => {
    const store = new JsonScheduledTaskStore(filePath);
    const task = makeTask({ id: 'task-update', prompt: 'old' });
    await store.create(task);

    const updated = await store.update('task-update', { ...task, prompt: 'new' });
    expect(updated?.prompt).toBe('new');

    const missing = await store.update('nonexistent', task);
    expect(missing).toBeUndefined();
  });

  it('deletes a task', async () => {
    const store = new JsonScheduledTaskStore(filePath);
    await store.create(makeTask({ id: 'task-del' }));

    expect(await store.delete('task-del')).toBe(true);
    expect(await store.delete('task-del')).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it('persists to disk and reloads', async () => {
    const store1 = new JsonScheduledTaskStore(filePath);
    await store1.create(makeTask({ id: 'persist-1', prompt: 'hello' }));

    const store2 = new JsonScheduledTaskStore(filePath);
    const tasks = await store2.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toBe('hello');
  });

  it('recovers from corrupted JSON via backup', async () => {
    const store1 = new JsonScheduledTaskStore(filePath);
    await store1.create(makeTask({ id: 'backup-test' }));
    // second write creates a backup of the first state
    await store1.create(makeTask({ id: 'backup-test-2' }));

    writeFileSync(filePath, 'corrupted{{{');

    const store2 = new JsonScheduledTaskStore(filePath);
    const tasks = await store2.list();
    // backup contains state after first create (before second write)
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('backup-test');
  });

  it('returns empty list when file does not exist', async () => {
    const store = new JsonScheduledTaskStore(path.join(TEST_DIR, 'nonexistent.json'));
    const tasks = await store.list();
    expect(tasks).toHaveLength(0);
  });
});

describe('FileSchedulerLock', () => {
  const lockPath = path.join(TEST_DIR, 'scheduler.lock');

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(lockPath)) rmSync(lockPath);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('acquires and releases a lock', () => {
    const lock = new FileSchedulerLock(lockPath);

    expect(lock.acquire()).toBe(true);
    expect(lock.isAcquired()).toBe(true);
    expect(lock.holderPid()).toBe(process.pid);

    lock.release();
    expect(lock.isAcquired()).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('allows re-acquire by same process', () => {
    const lock = new FileSchedulerLock(lockPath);

    expect(lock.acquire()).toBe(true);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  it('blocks acquire when held by another process', () => {
    // Use parent PID — guaranteed alive and not our own PID
    writeFileSync(lockPath, String(process.ppid));

    const lock = new FileSchedulerLock(lockPath);
    expect(lock.acquire()).toBe(false);
    expect(lock.isAcquired()).toBe(false);
  });

  it('cleans up stale lock from dead process', () => {
    writeFileSync(lockPath, '999999999');

    const lock = new FileSchedulerLock(lockPath);
    expect(lock.acquire()).toBe(true);
    expect(lock.isAcquired()).toBe(true);
    lock.release();
  });

  it('creates parent directories if needed', () => {
    const nested = path.join(TEST_DIR, 'nested', 'dir', 'scheduler.lock');
    const lock = new FileSchedulerLock(nested);

    expect(lock.acquire()).toBe(true);
    expect(existsSync(nested)).toBe(true);
    lock.release();
  });
});

describe('custom storage injection', () => {
  it('scheduler works with a custom ScheduledTaskStore implementation', async () => {
    const events: string[] = [];
    const customStore = new InMemoryStore();
    const customLock = new InMemoryLock();

    const scheduler = new PersistentTaskScheduler({
      store: customStore,
      lock: customLock,
      runner: async (task) => {
        events.push(`run:${task.prompt}`);
      },
    });

    await scheduler.start();

    const task = await scheduler.create({
      sessionId: 'custom-session',
      prompt: 'custom store test',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model: { provider: 'test', model: 'test-model' },
      toolPolicyProfile: 'default',
    });

    expect(customStore.tasks.size).toBe(1);
    expect(customStore.tasks.get(task.id)?.prompt).toBe('custom store test');

    await scheduler.runNow(task.id);
    await waitFor(() => events.length > 0);

    expect(events).toEqual(['run:custom store test']);

    const updated = await scheduler.update(task.id, { prompt: 'updated prompt' });
    expect(updated?.prompt).toBe('updated prompt');
    expect(customStore.tasks.get(task.id)?.prompt).toBe('updated prompt');

    await scheduler.delete(task.id);
    expect(customStore.tasks.size).toBe(0);

    await scheduler.stop();
    expect(customLock.isAcquired()).toBe(false);
  });

  it('scheduler respects custom lock blocking', async () => {
    const customLock = new InMemoryLock();
    customLock.acquire();

    const scheduler = new PersistentTaskScheduler({
      store: new InMemoryStore(),
      lock: customLock,
      runner: async () => {},
    });

    await scheduler.start();
    expect(scheduler.isActive()).toBe(false);
  });

  it('scheduler uses custom store for list/get operations', async () => {
    const customStore = new InMemoryStore();
    const now = new Date().toISOString();
    customStore.tasks.set('pre-existing', {
      id: 'pre-existing',
      sessionId: 'session-1',
      prompt: 'seeded task',
      type: 'cron',
      schedule: '0 9 * * *',
      intervalSeconds: 0,
      enabled: true,
      model: { provider: 'openai', model: 'gpt-4' },
      toolPolicyProfile: 'default',
      createdAt: now,
      updatedAt: now,
      runCount: 3,
    });

    const scheduler = new PersistentTaskScheduler({
      store: customStore,
      lock: new InMemoryLock(),
      runner: async () => {},
    });

    await scheduler.start();

    const tasks = await scheduler.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('pre-existing');

    const task = await scheduler.get('pre-existing');
    expect(task?.prompt).toBe('seeded task');
    expect(task?.runCount).toBe(3);

    await scheduler.stop();
  });
});

class InMemoryStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();

  async list(_scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    return Array.from(this.tasks.values());
  }

  async get(taskId: string): Promise<ScheduledTask | undefined> {
    return this.tasks.get(taskId);
  }

  async create(task: ScheduledTask): Promise<ScheduledTask> {
    this.tasks.set(task.id, task);
    return task;
  }

  async update(taskId: string, task: ScheduledTask): Promise<ScheduledTask | undefined> {
    if (!this.tasks.has(taskId)) return undefined;
    this.tasks.set(taskId, task);
    return task;
  }

  async delete(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }
}

class InMemoryLock implements SchedulerLock {
  readonly path = 'memory:test-lock';
  private locked = false;

  acquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release(): void {
    this.locked = false;
  }

  isAcquired(): boolean {
    return this.locked;
  }

  holderPid(): number | undefined {
    return this.locked ? process.pid : undefined;
  }
}

async function waitFor(assertion: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for assertion');
}
