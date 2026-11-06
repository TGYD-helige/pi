import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock evaluate so the engine gets deterministic verdicts (no live model).
const evaluateCondition = vi.fn();
vi.mock('../evaluate.js', () => ({
  evaluateCondition: (...args: unknown[]) => evaluateCondition(...args),
}));

import { type ResolvedGoalConfig, resolveConfig } from '../config.js';
import { type GoalEngineDeps, runGoalEngine } from '../extension.js';
import { GoalState } from '../goal-state.js';
import type { GoalModelRegistry } from '../llm.js';

const registry: GoalModelRegistry = {
  find: () => ({}),
  getApiKeyAndHeaders: async () => ({ ok: true }),
};

function makeDeps(
  state: GoalState,
  configOverrides: Partial<ResolvedGoalConfig> = {},
  disableModel = false,
): GoalEngineDeps & {
  sendUserMessage: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  const config: ResolvedGoalConfig = {
    ...resolveConfig({ model: { provider: 'p', model: 'm' } }),
    ...configOverrides,
  };
  if (disableModel) {
    delete config.model;
  }
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  return {
    state,
    config,
    registry,
    sendUserMessage,
    notify,
    setStatus: vi.fn(),
    // deterministic token estimate
    estimateTokens: () => 100,
  };
}

const messages = [
  { role: 'user', content: 'fix the bug' },
  { role: 'assistant', content: 'done' },
];

describe('runGoalEngine', () => {
  beforeEach(() => {
    evaluateCondition.mockReset();
  });

  it('skips when there is no active goal', async () => {
    const state = new GoalState();
    const deps = makeDeps(state);
    expect(await runGoalEngine(deps, messages)).toBe('skipped');
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it('skips when no model is configured (engine disabled)', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state, {}, true);
    expect(await runGoalEngine(deps, messages)).toBe('skipped');
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it('marks achieved and does not continue', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state);
    evaluateCondition.mockResolvedValue({ ok: true, impossible: false, reason: 'all green' });

    expect(await runGoalEngine(deps, messages)).toBe('achieved');
    expect(state.get()?.status).toBe('achieved');
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/achieved/i), 'info');
  });

  it('marks impossible and does not continue', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state);
    evaluateCondition.mockResolvedValue({ ok: false, impossible: true, reason: 'cannot' });

    expect(await runGoalEngine(deps, messages)).toBe('impossible');
    expect(state.get()?.status).toBe('impossible');
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it('injects a continuation message with the reason when not yet met', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state);
    evaluateCondition.mockResolvedValue({
      ok: false,
      impossible: false,
      reason: '2 tests failing',
    });

    expect(await runGoalEngine(deps, messages)).toBe('continued');
    expect(state.get()?.iterations).toBe(1);
    expect(state.get()?.lastReason).toBe('2 tests failing');
    expect(deps.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendUserMessage.mock.calls[0]?.[0]).toContain('2 tests failing');
  });

  it('stops at the iteration limit instead of continuing', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state, { maxIterations: 1 });
    evaluateCondition.mockResolvedValue({ ok: false, impossible: false, reason: 'still failing' });

    expect(await runGoalEngine(deps, messages)).toBe('iteration_limited');
    expect(state.get()?.status).toBe('iteration_limited');
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it('stops when the token budget is reached', async () => {
    const state = new GoalState();
    state.set('c', 'derived', { tokenBudget: 50 });
    const deps = makeDeps(state, { tokenBudget: 50 });
    evaluateCondition.mockResolvedValue({ ok: false, impossible: false, reason: 'nope' });

    // estimate is 100 > budget 50 → budget_limited on first round
    expect(await runGoalEngine(deps, messages)).toBe('budget_limited');
    expect(state.get()?.status).toBe('budget_limited');
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it('makes an evaluator failure visible while keeping the goal active and avoiding continuation', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state);
    evaluateCondition.mockImplementation(async (opts) => {
      opts.onError({ error: 'Evaluator timed out.', errorCategory: 'timeout' });
      return null;
    });
    expect(await runGoalEngine(deps, messages)).toBe('skipped');
    expect(state.get()?.status).toBe('active');
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'warning');
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the evaluator call fails (returns null)', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state);
    evaluateCondition.mockResolvedValue(null);

    expect(await runGoalEngine(deps, messages)).toBe('skipped');
    expect(state.get()?.status).toBe('active');
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it('skips when transcript is empty', async () => {
    const state = new GoalState();
    state.set('c', 'derived');
    const deps = makeDeps(state);
    expect(await runGoalEngine(deps, [])).toBe('skipped');
  });
});
