import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PersistentTaskScheduler,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskScheduler,
  type TaskSchedulerScope,
} from '../index.js';

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function createMockPi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void>>> = {};

  return {
    tools,
    commands,
    eventHandlers,
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((name: string, cmd: RegisteredCommand) => {
      commands.set(name, cmd);
    }),
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    sendUserMessage: vi.fn(),
  };
}

function createMockCtx(cwd = '/tmp', sessionId = 'test-session-1') {
  return {
    cwd,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    sessionManager: { getSessionId: () => sessionId },
    model: { id: 'test-model' },
  };
}

class MemStore implements ScheduledTaskStore {
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

class MemLock implements SchedulerLock {
  readonly path = 'memory:test';
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

async function setupExtension(
  injectedConfig?: Record<string, unknown>,
  sessionId = 'test-session-1',
) {
  const { default: taskSchedulerExtension } = await import('../extension.js');
  const pi = createMockPi();
  const ctx = createMockCtx('/tmp', sessionId);

  taskSchedulerExtension(pi as any, injectedConfig as any);

  for (const handler of pi.eventHandlers.session_start ?? []) {
    await handler({}, ctx);
  }

  return { pi, ctx };
}

describe('extension — default file storage mode', () => {
  it('reports safe startup failures and releases the lock', async () => {
    const store = new MemStore();
    vi.spyOn(store, 'list').mockRejectedValue(new DOMException('secret response', 'TimeoutError'));
    const lock = new MemLock();
    const { pi, ctx } = await setupExtension({ store, lock });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'error');
    expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain('secret response');
    expect(lock.isAcquired()).toBe(false);
    expect(pi.tools.size).toBe(0);
  });

  it('registers all tools and commands on session_start', async () => {
    const { pi } = await setupExtension({ dataDir: '/tmp/pi-test-ext' });

    expect(pi.tools.has('scheduler_create')).toBe(true);
    expect(pi.tools.has('scheduler_list')).toBe(true);
    expect(pi.tools.has('scheduler_get')).toBe(true);
    expect(pi.tools.has('scheduler_update')).toBe(true);
    expect(pi.tools.has('scheduler_delete')).toBe(true);
    expect(pi.tools.has('scheduler_run_now')).toBe(true);

    expect(pi.commands.has('cron')).toBe(true);
  });

  it('sets status to active when scheduler starts', async () => {
    const { ctx } = await setupExtension({ dataDir: '/tmp/pi-test-ext' });

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-scheduler', 'scheduler: active');
  });

  it('keeps concurrent session files independent', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = await mkdtemp(join(tmpdir(), 'pi-task-scheduler-sessions-'));
    const started: Array<Awaited<ReturnType<typeof setupExtension>>> = [];

    try {
      const now = new Date().toISOString();
      await writeFile(
        join(dataDir, 'tasks.json'),
        JSON.stringify([
          {
            id: 'legacy-a',
            sessionId: 'session-a',
            prompt: 'legacy session-a task',
            type: 'interval',
            schedule: '1h',
            intervalSeconds: 3_600,
            enabled: false,
            model: { provider: 'test', model: 'test-model' },
            toolPolicyProfile: 'default',
            createdAt: now,
            updatedAt: now,
            runCount: 0,
          },
        ]),
      );
      const sessionA = await setupExtension({ dataDir }, 'session-a');
      const sessionB = await setupExtension({ dataDir }, 'session-b');
      started.push(sessionA, sessionB);

      await sessionA.pi.tools
        .get('scheduler_create')!
        .execute(
          'create-a',
          { type: 'interval', schedule: '1h', prompt: 'session-a task', enabled: false },
          undefined,
          undefined,
          createMockCtx('/tmp', 'session-a'),
        );
      await sessionB.pi.tools
        .get('scheduler_create')!
        .execute(
          'create-b',
          { type: 'interval', schedule: '1h', prompt: 'session-b task', enabled: false },
          undefined,
          undefined,
          createMockCtx('/tmp', 'session-b'),
        );

      for (const instance of started.splice(0)) {
        for (const handler of instance.pi.eventHandlers.session_shutdown ?? []) {
          await handler({}, instance.ctx);
        }
      }

      const restartedA = await setupExtension({ dataDir }, 'session-a');
      started.push(restartedA);
      const result = (await restartedA.pi.tools
        .get('scheduler_list')!
        .execute('list-a', {}, undefined, undefined, createMockCtx('/tmp', 'session-a'))) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]!.text).toContain('session-a task');
      expect(result.content[0]!.text).toContain('legacy session-a task');
      expect(result.content[0]!.text).not.toContain('session-b task');
    } finally {
      for (const instance of started) {
        for (const handler of instance.pi.eventHandlers.session_shutdown ?? []) {
          await handler({}, instance.ctx);
        }
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('scheduler_list returns empty when no tasks', async () => {
    const { pi } = await setupExtension({ dataDir: '/tmp/pi-test-ext' });

    const tool = pi.tools.get('scheduler_list')!;
    const result = (await tool.execute('id', {}, undefined, undefined, createMockCtx())) as any;

    expect(result.content[0].text).toBe('No scheduled tasks.');
  });

  it('dispatches a recorded prompt only while its owning session is active', async () => {
    const store = new MemStore();
    const { pi, ctx } = await setupExtension({ store, lock: new MemLock() });
    const toolCtx = createMockCtx();
    const createResult = (await pi.tools
      .get('scheduler_create')!
      .execute(
        'create',
        { type: 'interval', schedule: '1h', prompt: 'session-owned prompt' },
        undefined,
        undefined,
        toolCtx,
      )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    await pi.tools
      .get('scheduler_run_now')!
      .execute('run', { taskId }, undefined, undefined, toolCtx);
    await vi.waitFor(() => {
      expect(pi.sendUserMessage).toHaveBeenCalledWith('session-owned prompt', {
        deliverAs: 'followUp',
      });
    });

    for (const handler of pi.eventHandlers.session_shutdown ?? []) {
      await handler({}, ctx);
    }
  });

  it('does not dispatch a recorded prompt into a different active session', async () => {
    const store = new MemStore();
    const { pi, ctx } = await setupExtension({ store, lock: new MemLock() });
    const ownerCtx = createMockCtx();
    const createResult = (await pi.tools
      .get('scheduler_create')!
      .execute(
        'create',
        { type: 'interval', schedule: '1h', prompt: 'do not cross sessions' },
        undefined,
        undefined,
        ownerCtx,
      )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;
    ctx.sessionManager.getSessionId = () => 'different-session';

    await pi.tools
      .get('scheduler_run_now')!
      .execute('run', { taskId }, undefined, undefined, ownerCtx);
    await vi.waitFor(() => {
      expect(store.tasks.get(taskId)?.lastStatus).toBe('error');
    });

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    for (const handler of pi.eventHandlers.session_shutdown ?? []) {
      await handler({}, ctx);
    }
  });
});

describe('extension — injected scheduler', () => {
  let externalScheduler: TaskScheduler;
  let store: MemStore;

  beforeEach(async () => {
    store = new MemStore();
    externalScheduler = new PersistentTaskScheduler({
      store,
      lock: new MemLock(),
      runner: async () => {},
    });
    await externalScheduler.start();
  });

  it('uses injected scheduler without creating its own', async () => {
    const { pi, ctx } = await setupExtension({ scheduler: externalScheduler });

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-scheduler', 'scheduler: active');

    const tool = pi.tools.get('scheduler_create')!;
    const result = (await tool.execute(
      'id',
      { type: 'interval', schedule: '10m', prompt: 'injected test' },
      undefined,
      undefined,
      createMockCtx(),
    )) as any;

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.prompt).toBe('injected test');
    expect(store.tasks.size).toBe(1);
  });

  it('does not stop injected scheduler on session_shutdown', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });

    for (const handler of pi.eventHandlers.session_shutdown ?? []) {
      await handler({}, createMockCtx());
    }

    expect(externalScheduler.isActive()).toBe(true);
  });

  it('stops self-created scheduler on session_shutdown', async () => {
    const { pi } = await setupExtension({
      store: new MemStore(),
      lock: new MemLock(),
    });

    for (const handler of pi.eventHandlers.session_shutdown ?? []) {
      await handler({}, createMockCtx());
    }

    // After shutdown, tools still work (scheduler instance persists) but scheduler is stopped
    const tool = pi.tools.get('scheduler_list')!;
    const result = (await tool.execute('id', {}, undefined, undefined, createMockCtx())) as any;
    expect(result.content[0].text).toBe('No scheduled tasks.');
  });
});

describe('extension — tool operations with injected scheduler', () => {
  let externalScheduler: TaskScheduler;
  let store: MemStore;

  beforeEach(async () => {
    store = new MemStore();
    externalScheduler = new PersistentTaskScheduler({
      store,
      lock: new MemLock(),
      runner: async () => {},
    });
    await externalScheduler.start();
  });

  it('scheduler_create creates a task via injected scheduler', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const tool = pi.tools.get('scheduler_create')!;
    const ctx = createMockCtx();

    const result = (await tool.execute(
      'id',
      {
        type: 'cron',
        schedule: '0 9 * * 1-5',
        prompt: 'daily standup reminder',
        name: 'standup',
      },
      undefined,
      undefined,
      ctx,
    )) as any;

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('standup');
    expect(parsed.type).toBe('cron');
    expect(parsed.schedule).toBe('0 9 * * 1-5');
    expect(store.tasks.size).toBe(1);
  });

  it('scheduler_get returns task details', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const getTool = pi.tools.get('scheduler_get')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '5m', prompt: 'check health' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const getResult = (await getTool.execute('id', { taskId }, undefined, undefined, ctx)) as any;
    const task = JSON.parse(getResult.content[0].text);
    expect(task.id).toBe(taskId);
    expect(task.prompt).toBe('check health');
  });

  it('scheduler_get returns not found for missing task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const tool = pi.tools.get('scheduler_get')!;

    const result = (await tool.execute(
      'id',
      { taskId: 'nonexistent' },
      undefined,
      undefined,
      createMockCtx(),
    )) as any;

    expect(result.content[0].text).toBe('Task not found: nonexistent');
  });

  it('scheduler_update modifies task fields', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const updateTool = pi.tools.get('scheduler_update')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '10m', prompt: 'original' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const updateResult = (await updateTool.execute(
      'id',
      { taskId, prompt: 'updated', enabled: false, sessionId: 'attacker-session' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const updated = JSON.parse(updateResult.content[0].text);
    expect(updated.prompt).toBe('updated');
    expect(updated.enabled).toBe(false);
    await expect(externalScheduler.get(taskId)).resolves.toMatchObject({
      sessionId: 'test-session-1',
    });
  });

  it('scheduler_delete removes a task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const deleteTool = pi.tools.get('scheduler_delete')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '1h', prompt: 'temp' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const deleteResult = (await deleteTool.execute(
      'id',
      { taskId },
      undefined,
      undefined,
      ctx,
    )) as any;
    expect(deleteResult.content[0].text).toBe(`Deleted task: ${taskId}`);
    expect(store.tasks.size).toBe(0);
  });

  it('scheduler_delete returns not found for missing task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const tool = pi.tools.get('scheduler_delete')!;

    const result = (await tool.execute(
      'id',
      { taskId: 'ghost' },
      undefined,
      undefined,
      createMockCtx(),
    )) as any;
    expect(result.content[0].text).toBe('Task not found: ghost');
  });

  it('scheduler_run_now triggers a task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const runTool = pi.tools.get('scheduler_run_now')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '1h', prompt: 'run me', name: 'runner' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const runResult = (await runTool.execute('id', { taskId }, undefined, undefined, ctx)) as any;
    expect(runResult.content[0].text).toBe('Triggered: runner');
  });

  it('all tools return not running when scheduler is undefined', async () => {
    const { default: taskSchedulerExtension } = await import('../extension.js');
    const pi = createMockPi();
    taskSchedulerExtension(pi as any);
    // Don't fire session_start — scheduler stays undefined

    const ctx = createMockCtx();
    for (const tool of Array.from(pi.tools.values())) {
      const result = (await tool.execute('id', {}, undefined, undefined, ctx)) as any;
      expect(result.content[0].text).toContain('not running');
    }
  });
});

describe('extension — /cron command subcommands', () => {
  let externalScheduler: TaskScheduler;
  let store: MemStore;

  beforeEach(async () => {
    store = new MemStore();
    externalScheduler = new PersistentTaskScheduler({
      store,
      lock: new MemLock(),
      runner: async () => {},
    });
    await externalScheduler.start();
  });

  async function getCronHandler() {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const cmd = pi.commands.get('cron')!;
    return cmd.handler;
  }

  it('/cron (no args) shows status', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Active:'), 'info');
  });

  it('/cron status shows status', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('status', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Tasks:'), 'info');
  });

  it('/cron list shows tasks', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('list', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('No scheduled tasks.', 'info');
  });

  it('/cron get without id shows usage', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('get', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Usage: /cron get <task-id>', 'warning');
  });

  it('/cron get with valid id shows task detail', async () => {
    const task = await externalScheduler.create({
      type: 'interval',
      schedule: '5m',
      intervalSeconds: 300,
      prompt: 'test prompt',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: true,
      name: 'my-task',
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler(`get ${task.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('my-task'), 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('test prompt'), 'info');
  });

  it('/cron run without id shows usage', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('run', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Usage: /cron run <task-id>', 'warning');
  });

  it('/cron run triggers task', async () => {
    const task = await externalScheduler.create({
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      prompt: 'run me',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: true,
      name: 'runner',
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler(`run ${task.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Triggered: runner', 'info');
  });

  it('/cron enable enables a task', async () => {
    const task = await externalScheduler.create({
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      prompt: 'test',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: false,
      name: 'toggler',
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler(`enable ${task.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Enabled: toggler', 'info');
    const updated = await externalScheduler.get(task.id);
    expect(updated!.enabled).toBe(true);
  });

  it('/cron disable disables a task', async () => {
    const task = await externalScheduler.create({
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      prompt: 'test',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: true,
      name: 'toggler',
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler(`disable ${task.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Disabled: toggler', 'info');
    const updated = await externalScheduler.get(task.id);
    expect(updated!.enabled).toBe(false);
  });

  it('/cron delete removes a task', async () => {
    const task = await externalScheduler.create({
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      prompt: 'test',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: true,
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler(`delete ${task.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Deleted: ${task.id}`, 'info');
    expect(store.tasks.size).toBe(0);
  });

  it('/cron unknown shows help', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('bogus', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand'),
      'warning',
    );
  });

  it('/cron warns when scheduler not running', async () => {
    const { default: taskSchedulerExtension } = await import('../extension.js');
    const pi = createMockPi();
    taskSchedulerExtension(pi as any);
    // Don't fire session_start — scheduler stays undefined

    const cmd = pi.commands.get('cron')!;
    const ctx = createMockCtx();
    await cmd.handler('list', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Task scheduler is not running.', 'warning');
  });

  it('/cron get with invalid id shows not found', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('get nonexistent-id', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Task not found: nonexistent-id', 'error');
  });

  it('/cron run with invalid id shows not found', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('run nonexistent-id', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Task not found: nonexistent-id', 'error');
  });

  it('/cron enable with invalid id shows not found', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('enable nonexistent-id', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Task not found: nonexistent-id', 'error');
  });

  it('/cron disable with invalid id shows not found', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('disable nonexistent-id', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Task not found: nonexistent-id', 'error');
  });

  it('/cron delete with invalid id shows not found', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('delete nonexistent-id', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Task not found: nonexistent-id', 'error');
  });

  it('/cron enable without id shows usage', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('enable', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Usage: /cron enable <task-id>', 'warning');
  });

  it('/cron disable without id shows usage', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('disable', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Usage: /cron disable <task-id>', 'warning');
  });

  it('/cron delete without id shows usage', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('delete', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Usage: /cron delete <task-id>', 'warning');
  });

  it('/cron list shows tasks when they exist', async () => {
    await externalScheduler.create({
      type: 'cron',
      schedule: '0 9 * * *',
      intervalSeconds: 0,
      prompt: 'morning check',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: true,
      name: 'morning',
    });
    await externalScheduler.create({
      type: 'interval',
      schedule: '30m',
      intervalSeconds: 1800,
      prompt: 'health check',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: false,
      name: 'health',
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('list', ctx);
    const output = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(output).toContain('morning');
    expect(output).toContain('[cron]');
    expect(output).toContain('health');
    expect(output).toContain('[interval]');
    expect(output).toContain('disabled');
  });

  it('/cron get shows task detail fields', async () => {
    const task = await externalScheduler.create({
      type: 'cron',
      schedule: '*/5 * * * *',
      intervalSeconds: 0,
      prompt: 'ping server',
      sessionId: 'sess',
      model: { provider: 'anthropic', model: 'test' },
      toolPolicyProfile: 'workspace-write',
      enabled: true,
      name: 'pinger',
      description: 'Pings the server every 5 minutes',
    });
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler(`get ${task.id}`, ctx);
    const output = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(output).toContain(`ID: ${task.id}`);
    expect(output).toContain('Name: pinger');
    expect(output).toContain('Type: cron');
    expect(output).toContain('Schedule: */5 * * * *');
    expect(output).toContain('Enabled: true');
    expect(output).toContain('Description: Pings the server every 5 minutes');
    expect(output).toContain('Prompt: ping server');
  });

  it('/cron status shows running tasks', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('status', ctx);
    const output = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(output).toContain('Active: true');
    expect(output).toContain('Tasks: 0');
    expect(output).toContain('Timers: 0');
    expect(output).toContain('Crons: 0');
  });

  it('/cron subcommand is case-insensitive', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('STATUS', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Active:'), 'info');
  });

  it('/cron handles extra whitespace in args', async () => {
    const handler = await getCronHandler();
    const ctx = createMockCtx();
    await handler('  status  ', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Active:'), 'info');
  });

  it('getArgumentCompletions returns matching subcommands', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const cmd = pi.commands.get('cron')! as RegisteredCommand & {
      getArgumentCompletions?: (prefix: string) => { label: string; value: string }[] | null;
    };
    const completions = cmd.getArgumentCompletions!('d');
    expect(completions).toEqual([
      { label: 'disable', value: 'disable' },
      { label: 'delete', value: 'delete' },
    ]);
  });

  it('getArgumentCompletions returns all subcommands for empty prefix', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const cmd = pi.commands.get('cron')! as RegisteredCommand & {
      getArgumentCompletions?: (prefix: string) => { label: string; value: string }[] | null;
    };
    const completions = cmd.getArgumentCompletions!('');
    expect(completions).toHaveLength(7);
  });
});
