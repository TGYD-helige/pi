import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeOnce = vi.fn();
vi.mock('../llm.js', () => ({ completeOnce: (...args: unknown[]) => completeOnce(...args) }));

import { evaluateCondition, parseVerdict } from '../evaluate.js';
import type { GoalModelRegistry } from '../llm.js';

describe('evaluateCondition', () => {
  const registry: GoalModelRegistry = {
    find: () => ({}),
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const base = {
    registry,
    modelConfig: { provider: 'p', model: 'm' },
    condition: 'c',
    transcript: 't',
  };

  beforeEach(() => completeOnce.mockReset());

  it('forwards the safe failure callback to the completion boundary', async () => {
    const onError = vi.fn();
    completeOnce.mockImplementation(async (...args: unknown[]) => {
      (args[5] as (failure: object) => void)?.({
        error: 'Evaluator timed out.',
        errorCategory: 'timeout',
      });
      return null;
    });
    await evaluateCondition({ ...base, onError });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errorCategory: 'timeout' }));
  });

  it('returns null and logs when the model call fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    completeOnce.mockResolvedValue(null);
    expect(await evaluateCondition(base)).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[pi-goal] evaluate: model unavailable'),
    );
    spy.mockRestore();
  });

  it('logs the verdict to stderr', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    completeOnce.mockResolvedValue('{"ok": true, "reason": "done"}');
    const v = await evaluateCondition(base);
    expect(v).toEqual({ ok: true, impossible: false, reason: 'done' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[pi-goal] evaluation: ok=true'));
    spy.mockRestore();
  });
});

describe('parseVerdict', () => {
  it('parses a clean "met" verdict', () => {
    const v = parseVerdict('{"ok": true, "reason": "tests pass"}');
    expect(v).toEqual({ ok: true, impossible: false, reason: 'tests pass' });
  });

  it('parses a "not yet" verdict', () => {
    const v = parseVerdict('{"ok": false, "reason": "2 tests failing"}');
    expect(v).toEqual({ ok: false, impossible: false, reason: '2 tests failing' });
  });

  it('parses an "impossible" verdict', () => {
    const v = parseVerdict('{"ok": false, "impossible": true, "reason": "contradictory"}');
    expect(v).toEqual({ ok: false, impossible: true, reason: 'contradictory' });
  });

  it('ignores impossible when ok is true', () => {
    const v = parseVerdict('{"ok": true, "impossible": true, "reason": "done"}');
    expect(v.ok).toBe(true);
    expect(v.impossible).toBe(false);
  });

  it('extracts JSON embedded in prose / code fences', () => {
    const v = parseVerdict('Here is my verdict:\n```json\n{"ok": true, "reason": "ok"}\n```');
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('ok');
  });

  it('treats unparseable output conservatively as not-yet-met', () => {
    const v = parseVerdict('I think it is probably fine, hard to say.');
    expect(v.ok).toBe(false);
    expect(v.impossible).toBe(false);
    expect(v.reason).toMatch(/insufficient evidence/i);
  });

  it('fills a default reason when reason is missing', () => {
    expect(parseVerdict('{"ok": true}').reason).toBeTruthy();
    expect(parseVerdict('{"ok": false}').reason).toBeTruthy();
  });
});
