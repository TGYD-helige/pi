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
  it('does not accept evading capacity by moving project facts to USER', () => {
    const task = MEMORY_TASKS.find((task) => task.id === 'capacity-preserves-facts')!;
    const answer = JSON.stringify(task.expected);
    expect(gradeMemoryTask(task, answer, { memory: [], user: task.seed.memory })).toBe(false);
    expect(
      gradeMemoryTask(task, answer, {
        memory: task.seed.memory,
        user: ['Project Gamma uses us-east-2.'],
      }),
    ).toBe(false);
    expect(
      gradeMemoryTask(task, answer, { memory: ['Alpha eu-west-1; Beta ap-south-1.'], user: [] }),
    ).toBe(true);
  });
  it('rejects persisted memory beyond the configured capacity', () => {
    const task = MEMORY_TASKS.find((task) => task.id === 'capacity-preserves-facts')!;
    const answer = JSON.stringify(task.expected);
    expect(gradeMemoryTask(task, answer, task.seed)).toBe(true);
    expect(
      gradeMemoryTask(task, answer, {
        memory: [...task.seed.memory, 'Gamma '.repeat(25)],
        user: [],
      }),
    ).toBe(false);
    const remaining = task.memoryCharLimit! - task.seed.memory.join('\n§\n').length;
    expect(
      gradeMemoryTask(task, answer, {
        memory: [...task.seed.memory, 'x'.repeat(remaining)],
        user: [],
      }),
    ).toBe(false);
  });
  it.each([
    ['avoid-inferred-preference', 'Rust is the user’s favorite programming language.'],
    ['forget-address', 'Shipping label is Dock17.'],
  ])('requires empty stores for %s instead of blacklisting literal phrases', (id, fact) => {
    const task = MEMORY_TASKS.find((task) => task.id === id)!;
    const answer = JSON.stringify(task.expected);
    expect(gradeMemoryTask(task, answer, { memory: [], user: [fact] })).toBe(false);
    expect(gradeMemoryTask(task, answer, { memory: [fact], user: [] })).toBe(false);
    expect(gradeMemoryTask(task, answer, { memory: [], user: [] })).toBe(true);
  });
});
