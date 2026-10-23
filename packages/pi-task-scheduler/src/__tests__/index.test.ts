import { describe, expect, it, vi } from 'vitest';
import {
  matchesScheduledTaskScope,
  PersistentTaskScheduler,
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  scheduleExpressionForCroner,
  type TaskSchedulerScope,
} from '../index.js';

const model = { provider: 'test', model: 'test-model' };

describe('task scheduler', () => {
  it('normalizes interval, once, cron, and RRULE schedules', () => {
    expect(resolveScheduledTaskDefinition({ type: 'interval', schedule: '10m' })).toMatchObject({
      type: 'interval',
      schedule: '10m',
      intervalSeconds: 600,
    });
    expect(resolveScheduledTaskDefinition({ type: 'cron', schedule: '0 9 * * *' })).toMatchObject({
      type: 'cron',
      schedule: '0 9 * * *',
      intervalSeconds: 0,
    });
    expect(resolveScheduledTaskDefinition({ type: 'once', schedule: '+5m' }).schedule).toEqual(
      expect.stringMatching(/T.*Z$/),
    );
    expect(scheduleExpressionForCroner('RRULE:FREQ=WEEKLY;BYHOUR=7;BYMINUTE=30;BYDAY=FR')).toBe(
      '30 7 * * 5',
    );
  });

  it('runs tasks through the injected runner and emits lifecycle hooks', async () => {
    const events: string[] = [];
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async (task, run) => {
        events.push(`runner:${task.prompt}:${run.sessionId.startsWith('scheduled-run-')}`);
      },
      hooks: {
        onSchedulerStarted: () => {
          events.push('scheduler:start');
        },
        onTaskStarted: ({ task }) => {
          events.push(`task:start:${task.prompt}`);
        },
        onTaskCompleted: ({ task }) => {
          events.push(`task:done:${task.runCount}`);
        },
      },
    });

    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'check things',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);
    await scheduler.stop();

    expect(events).toEqual([
      'scheduler:start',
      'task:start:check things',
      'runner:check things:true',
      'task:done:1',
    ]);
    expect((await scheduler.get(task.id))?.lastStatus).toBe('success');
  });

  it('does not run the same task concurrently', async () => {
    let starts = 0;
    let release: (() => void) | undefined;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        starts += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'slow check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(() => starts === 1);
    await scheduler.runNow(task.id);
    await delay(20);
    expect(starts).toBe(1);
    release?.();
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);
    await scheduler.stop();
  });

  it('records failed task runs and emits failure hooks', async () => {
    const failures: string[] = [];
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        throw new Error('nope');
      },
      hooks: {
        onTaskFailed: ({ error }) => {
          failures.push(error);
        },
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'bad check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.lastStatus === 'error');

    const failed = await scheduler.get(task.id);
    expect(failed?.lastError).toBe('nope');
    expect(failed?.runHistory?.at(-1)).toMatchObject({ status: 'error', message: 'nope' });
    expect(failures).toEqual(['nope']);
    await scheduler.stop();
  });

  it('keeps task execution isolated from hook failures', async () => {
    let ran = false;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        ran = true;
      },
      hooks: {
        onTaskStarted: () => {
          throw new Error('hook failed');
        },
        onTaskCompleted: () => {
          throw new Error('hook failed too');
        },
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'hook check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);

    const completed = await scheduler.get(task.id);
    expect(ran).toBe(true);
    expect(completed?.lastStatus).toBe('success');
    expect(completed?.lastError).toBeUndefined();
    await scheduler.stop();
  });

  it('does not unschedule a task when scoped deletion is denied', async () => {
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {},
    });
    const task = await scheduler.create({
      sessionId: 'session-a',
      prompt: 'owned task',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await expect(scheduler.delete(task.id, { sessionId: 'session-b' })).resolves.toBe(false);
    await expect(scheduler.get(task.id, { sessionId: 'session-a' })).resolves.toBeDefined();
    await expect(scheduler.status()).resolves.toMatchObject({ scheduledTimerCount: 1 });
    await scheduler.stop();
  });

  it('starts only tasks owned by the configured session', async () => {
    const store = new MemoryScheduledTaskStore();
    const bootstrap = new PersistentTaskScheduler({
      store,
      lock: new MemorySchedulerLock(),
      runner: async () => {},
    });
    for (const sessionId of ['session-a', 'session-b']) {
      await bootstrap.create({
        sessionId,
        prompt: `${sessionId} task`,
        type: 'interval',
        schedule: '1h',
        intervalSeconds: 3600,
        enabled: true,
        model,
        toolPolicyProfile: 'scheduled',
      });
    }
    const scheduler = new PersistentTaskScheduler({
      store,
      lock: new MemorySchedulerLock(),
      runner: async () => {},
      scope: { sessionId: 'session-a' },
    });

    await scheduler.start();
    await expect(scheduler.status()).resolves.toMatchObject({
      taskCount: 1,
      scheduledTimerCount: 1,
    });
    await scheduler.stop();
  });

  // Node's timer limit: a longer delay fires after 1 ms.
  const maxTimerDelayMs = 2_147_483_647;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  it.each([
    ['just under the timer limit', maxTimerDelayMs - 1],
    ['at the timer limit', maxTimerDelayMs],
    ['just over the timer limit', maxTimerDelayMs + 1],
    ['thirty days away', thirtyDaysMs],
  ])('runs a once task %s at its advertised time, not before', async (_label, delayMs) => {
    await withFakeClock(async (now) => {
      const runs: number[] = [];
      const scheduler = await startedScheduler(runs, {
        type: 'once',
        schedule: new Date(now + delayMs).toISOString(),
        intervalSeconds: 0,
      });
      const [task] = await scheduler.list();
      expect(task?.nextRunAt).toBe(new Date(now + delayMs).toISOString());

      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(runs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toEqual([now + delayMs]);
      await scheduler.stop();
    });
  });

  it.each([
    ['just under the timer limit', Math.floor(maxTimerDelayMs / 1000)],
    ['just over the timer limit', Math.ceil(maxTimerDelayMs / 1000)],
    ['of thirty days', thirtyDaysMs / 1000],
  ])('runs an interval task %s at each advertised time, not before', async (_label, seconds) => {
    await withFakeClock(async (now) => {
      const intervalMs = seconds * 1000;
      const runs: number[] = [];
      const scheduler = await startedScheduler(runs, {
        type: 'interval',
        schedule: `${seconds}s`,
        intervalSeconds: seconds,
      });
      const [task] = await scheduler.list();
      expect(task?.nextRunAt).toBe(new Date(now + intervalMs).toISOString());

      await vi.advanceTimersByTimeAsync(intervalMs - 1);
      expect(runs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toEqual([now + intervalMs]);
      expect((await scheduler.list())[0]?.nextRunAt).toBe(
        new Date(now + 2 * intervalMs).toISOString(),
      );
      await vi.advanceTimersByTimeAsync(intervalMs - 1);
      expect(runs).toEqual([now + intervalMs]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toEqual([now + intervalMs, now + 2 * intervalMs]);
      await scheduler.stop();
    });
  });

  it('does not replay missed intervals after a forward clock adjustment', async () => {
    await withFakeClock(async (now) => {
      const runs: number[] = [];
      const scheduler = await startedScheduler(runs, {
        type: 'interval',
        schedule: '30d',
        intervalSeconds: thirtyDaysMs / 1000,
      });
      try {
        vi.setSystemTime(now + 3 * thirtyDaysMs);
        await vi.advanceTimersByTimeAsync(maxTimerDelayMs + 10);
        expect(runs).toHaveLength(1);
        const nextRunAt = Date.parse((await scheduler.list())[0]?.nextRunAt ?? '');
        await vi.advanceTimersByTimeAsync(nextRunAt - Date.now() - 1);
        expect(runs).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(runs).toHaveLength(2);
        expect(runs[1]! - runs[0]!).toBe(thirtyDaysMs);
      } finally {
        await scheduler.stop();
      }
    });
  });

  it('leaves a cron task a year away to croner, which waits in short steps', async () => {
    await withFakeClock(async (now) => {
      const runs: number[] = [];
      const scheduler = await startedScheduler(runs, {
        type: 'cron',
        schedule: '0 0 1 1 *',
        intervalSeconds: 0,
      });
      const nextRunAt = Date.parse((await scheduler.list())[0]?.nextRunAt ?? '');
      expect(nextRunAt - now).toBeGreaterThan(maxTimerDelayMs);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(runs).toEqual([]);
      await scheduler.stop();
    });
  });
});

class MemoryScheduledTaskStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();

  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((task) => matchesScheduledTaskScope(task, scope));
  }

  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(taskId);
    return task && matchesScheduledTaskScope(task, scope) ? task : undefined;
  }

  async create(task: ScheduledTask): Promise<ScheduledTask> {
    this.tasks.set(task.id, task);
    return task;
  }

  async update(
    taskId: string,
    task: ScheduledTask,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    if (!(await this.get(taskId, scope))) {
      return undefined;
    }
    this.tasks.set(taskId, task);
    return task;
  }

  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    if (!(await this.get(taskId, scope))) {
      return false;
    }
    return this.tasks.delete(taskId);
  }
}

class MemorySchedulerLock implements SchedulerLock {
  readonly path = 'memory:scheduler';
  private locked = false;

  acquire(): boolean {
    if (this.locked) {
      return false;
    }
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

async function withFakeClock(test: (now: number) => Promise<void>): Promise<void> {
  const now = Date.parse('2026-01-02T00:00:00.000Z');
  vi.useFakeTimers({ now });
  try {
    await test(now);
  } finally {
    vi.useRealTimers();
  }
}

async function startedScheduler(
  runs: number[],
  schedule: Pick<ScheduledTask, 'type' | 'schedule' | 'intervalSeconds'>,
): Promise<PersistentTaskScheduler> {
  const scheduler = new PersistentTaskScheduler({
    store: new MemoryScheduledTaskStore(),
    lock: new MemorySchedulerLock(),
    runner: async () => {
      runs.push(Date.now());
    },
  });
  await scheduler.create({
    sessionId: 'scheduled-1',
    prompt: 'long wait',
    ...schedule,
    enabled: true,
    model,
    toolPolicyProfile: 'scheduled',
  });
  await scheduler.start();
  return scheduler;
}

async function waitFor(assertion: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (await assertion()) {
      return;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for assertion');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
