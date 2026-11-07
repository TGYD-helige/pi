import { describe, expect, it } from 'vitest';
import { gradeMemoryTask, MEMORY_TASKS } from '../../memory/tasks.js';

describe('memory product tasks', () => {
  it('requires forgetting on disk as well as in the answer', () => {
    const task = MEMORY_TASKS.find((task) => task.id === 'forget-address')!;
    expect(
      gradeMemoryTask(task, '{"address":null}', {
        memory: ['Shipping label is Dock-17.'],
        user: [],
      }),
    ).toBe(false);
    expect(gradeMemoryTask(task, '{"address":null}', { memory: [], user: [] })).toBe(true);
  });
  it('rejects a correct answer when the old preference is still persisted', () => {
    const task = MEMORY_TASKS.find((task) => task.id === 'correct-preference')!;
    expect(
      gradeMemoryTask(task, '{"language":"French"}', { memory: [], user: ['Spanish', 'French'] }),
    ).toBe(false);
    expect(gradeMemoryTask(task, '{"language":"french"}', { memory: [], user: ['French'] })).toBe(
      true,
    );
  });

  it('accepts selective forgetting without confusing npm with pnpm', () => {
    const task = MEMORY_TASKS.find((task) => task.id === 'selective-forgetting')!;
    expect(
      gradeMemoryTask(task, '{"Alpha":null,"Beta":"pnpm test"}', {
        memory: ['Project Beta uses pnpm test.'],
        user: [],
      }),
    ).toBe(true);
  });

  it('fails malformed answers and accidental deletion of unrelated facts', () => {
    const task = MEMORY_TASKS.find((task) => task.id === 'unknown-project')!;
    expect(gradeMemoryTask(task, 'unknown', task.seed)).toBe(false);
    expect(gradeMemoryTask(task, '{"command":null}', { memory: [], user: [] })).toBe(false);
    expect(gradeMemoryTask(task, '{"command":null}', { memory: [], user: [] }, false)).toBe(true);
  });
});
