import { Value } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import type { TaskScheduler } from '../index.js';
import { createSchedulerTools } from '../tools.js';

describe('createSchedulerTools', () => {
  it.each([
    ['2000-01-01T00:00:00Z', 'schedule_in_past', 'A one-time schedule must be in the future.'],
    [
      '+9999999999999999d',
      'invalid_once_schedule',
      'Use an ISO timestamp or a relative delay such as "+10m".',
    ],
  ])('rejects an invalid one-time schedule before any write (%s)', async (schedule, code, message) => {
    const create = vi.fn();
    const tool = createSchedulerTools({ create } as unknown as TaskScheduler).find(
      (tool) => tool.name === 'scheduler_create',
    )!;
    const result = await tool.execute(
      'call',
      { type: 'once', schedule, prompt: 'fixture' },
      undefined,
      undefined,
      {} as never,
    );
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: `[${code}] ${message}` }],
      structuredContent: { error: { code, message } },
    });
    expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
  });

  it.each([
    '0s',
    '10000000000000s',
  ])('rejects an invalid interval before creating or updating (%s)', async (schedule) => {
    const create = vi.fn();
    const update = vi.fn();
    const get = vi.fn().mockResolvedValue({ type: 'interval', schedule: '1m' });
    const tools = createSchedulerTools({ create, get, update } as unknown as TaskScheduler);
    const ctx = { sessionManager: { getSessionId: () => 'fixture' } } as never;
    for (const [name, params] of [
      ['scheduler_create', { type: 'interval', schedule, prompt: 'fixture', enabled: false }],
      ['scheduler_update', { taskId: 'fixture', schedule }],
    ] as const) {
      const tool = tools.find((tool) => tool.name === name)!;
      const result = await tool.execute('call', params, undefined, undefined, ctx);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'invalid_interval_schedule' } },
      });
      expect(result.content[0]).toMatchObject({
        text: expect.not.stringContaining('may have completed'),
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('bounds error details and validates the result when task metadata exceeds the output limit', async () => {
    const scheduler = {
      get: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    } as unknown as TaskScheduler;
    const tools = createSchedulerTools(scheduler);
    const ctx = { sessionManager: { getSessionId: () => 's1' } } as never;
    const taskId = 'x'.repeat(20_000);
    for (const [name, code] of [
      ['scheduler_get', 'task_not_found'],
      ['scheduler_delete', 'scheduler_output_limit'],
    ]) {
      const tool = tools.find((item) => item.name === name)!;
      const result = await tool.execute('call', { taskId }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty('error.code', code);
      expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(12 * 1024);
    }
  });

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
