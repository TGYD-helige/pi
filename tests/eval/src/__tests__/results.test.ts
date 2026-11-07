import { describe, expect, it } from 'vitest';
import { compareResults, type EvalResults, summarize } from '../results.js';

const row = (task: string, trial: number, success: number, failureMode = 'ok') => ({
  task,
  trial,
  success,
  failureMode,
  turns: 2,
  toolCalls: 3,
  durationMs: 100,
  totalTokens: 20,
});

describe('evaluation results', () => {
  it('counts crashes in completion rate and reports availability separately', () => {
    expect(summarize([row('read', 1, 1), row('read', 2, 0, 'crash')])).toMatchObject({
      n: 2,
      successRate: 0.5,
      nonCrashSuccessRate: 1,
      crashRate: 0.5,
      consistentTaskRate: 0,
    });
  });

  it('compares matched trials and identifies regressions without excluding crashes', () => {
    const base: EvalResults = {
      suite: 'fixture',
      taskSetHash: 'same',
      revision: 'base',
      dirty: false,
      configuration: { model: 'fixture', thinking: 'off', piVersion: '1' },
      expectedTrials: 2,
      rows: [row('read', 1, 1), row('read', 2, 1)],
    };
    const head = {
      ...base,
      revision: 'head',
      rows: [row('read', 1, 1), row('read', 2, 0, 'crash')],
    };
    expect(compareResults(base, head)).toContain('| read | 2/2 | 1/2 | regression |');
    expect(() => compareResults(base, { ...head, rows: head.rows.slice(0, 1) })).toThrow(
      /incomplete/i,
    );
    expect(() => compareResults(base, { ...head, taskSetHash: 'changed' })).toThrow(/same suite/i);
    expect(() => compareResults(base, { ...head, rows: [head.rows[0]!, head.rows[0]!] })).toThrow(
      /duplicate/i,
    );
  });
  it('keeps unknown metrics unknown when every trial crashes or usage is missing', () => {
    const failed = {
      task: 'read',
      trial: 1,
      success: 0,
      failureMode: 'crash',
      durationMs: 1,
      turns: 0,
      toolCalls: 0,
    };
    expect(summarize([failed])).toMatchObject({
      successRate: 0,
      nonCrashSuccessRate: null,
      avgTokens: null,
      avgTurns: null,
    });
    expect(summarize([])).toMatchObject({ successRate: null, consistentTaskRate: null });
  });
  it('does not present partial usage from crashed trials as a complete token average', () => {
    expect(summarize([row('read', 1, 1), row('read', 2, 0, 'crash')]).avgTokens).toBeNull();
  });
});
