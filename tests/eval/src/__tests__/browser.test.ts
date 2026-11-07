import { describe, expect, it } from 'vitest';
import { BROWSER_TASKS } from '../../browser/tasks.js';

describe('browser outcome scoring', () => {
  it('does not accept a destination link on the initial page as completed navigation', () => {
    const task = BROWSER_TASKS.find((task) => task.id === 'multi-step-navigate')!;
    expect(task.check!({ answer: 'Could not navigate.', observed: 'link A/B Testing' })).toBe(
      false,
    );
  });
});
