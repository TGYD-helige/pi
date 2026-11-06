import { Value } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import type { TaskScheduler } from '../index.js';
import { createSchedulerTools } from '../tools.js';

describe('createSchedulerTools', () => {
  it('does not misreport a create timeout as invalid configuration', async () => {
    const scheduler = {
      create: vi.fn().mockRejectedValue(new DOMException('secret-token', 'TimeoutError')),
    } as unknown as TaskScheduler;
    const tool = createSchedulerTools(scheduler).find((tool) => tool.name === 'scheduler_create')!;
    const result = await tool.execute(
      'call',
      { type: 'interval', schedule: '5m', prompt: 'check' },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 's1' } } as never,
    );
    expect(result.structuredContent).toHaveProperty('errorCategory', 'timeout');
    expect(JSON.stringify(result)).not.toMatch(/secret-token|Check the schedule/);
  });

  it('keeps oversized created tasks available for later updates', async () => {
    const task = {
      id: 'persisted-task',
      type: 'interval',
      schedule: '5m',
      enabled: true,
      prompt: 'x'.repeat(13_000),
      sessionId: 's1',
      runCount: 0,
    };
    const scheduler = {
      create: vi.fn().mockResolvedValue(task),
      list: vi.fn().mockResolvedValue([task]),
    } as unknown as TaskScheduler;
    const tools = createSchedulerTools(scheduler);
    const ctx = { sessionManager: { getSessionId: () => 's1' } } as never;
    for (const [name, params] of [
      ['scheduler_create', { type: 'interval', schedule: '5m', prompt: task.prompt }],
      ['scheduler_list', {}],
    ] as const) {
      const tool = tools.find((t) => t.name === name)!;
      const result = await tool.execute('oversized', params, undefined, undefined, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toHaveProperty(
        name === 'scheduler_list' ? 'tasks.0.id' : 'task.id',
        task.id,
      );
      expect(result.structuredContent).toHaveProperty('truncated', true);
      expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
    }
  });

  it('returns typed task objects for filtering and passes the session scope to updates', async () => {
    const task = {
      id: 't1',
      type: 'interval',
      schedule: '5m',
      enabled: true,
      prompt: 'check status',
      sessionId: 's1',
      runCount: 0,
    };
    const scheduler = {
      list: vi.fn().mockResolvedValue([task]),
      update: vi.fn().mockResolvedValue({ ...task, enabled: false }),
      get: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskScheduler;
    const tools = createSchedulerTools(scheduler);
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
    const ctx = { sessionManager: { getSessionId: () => 's1' } } as never;
    const list = await tools
      .find((t) => t.name === 'scheduler_list')!
      .execute('list', {}, undefined, undefined, ctx);
    expect(list.structuredContent).toHaveProperty('tasks.0.id', 't1');
    const update = await tools
      .find((t) => t.name === 'scheduler_update')!
      .execute('update', { taskId: 't1', enabled: false }, undefined, undefined, ctx);
    expect(update.structuredContent).toHaveProperty('task.enabled', false);
    expect(scheduler.update).toHaveBeenCalledWith('t1', { enabled: false }, { sessionId: 's1' });
    const missing = await tools
      .find((t) => t.name === 'scheduler_get')!
      .execute('get', { taskId: 'absent' }, undefined, undefined, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toHaveProperty('error');
  });
});
