import { describe, expect, it } from 'vitest';
import {
  buildActivationMessage,
  buildContinueMessage,
  buildEvaluateUserPrompt,
  buildTruncationNote,
  EVALUATE_SYSTEM_PROMPT,
} from '../prompts.js';

describe('EVALUATE_SYSTEM_PROMPT (aligned with Claude Code)', () => {
  it('requires quoting transcript evidence', () => {
    expect(EVALUATE_SYSTEM_PROMPT).toMatch(/quote evidence from the transcript/i);
  });

  it('defines the insufficient-evidence fallback', () => {
    expect(EVALUATE_SYSTEM_PROMPT).toMatch(/insufficient evidence in transcript/i);
  });

  it('carries the impossible-judgment discipline (evidence, not proof)', () => {
    expect(EVALUATE_SYSTEM_PROMPT).toMatch(/evidence, not proof/i);
    expect(EVALUATE_SYSTEM_PROMPT).toMatch(/when in doubt, return \{"ok": false\}/i);
  });
});

describe('buildEvaluateUserPrompt', () => {
  it('omits the truncation note when nothing was dropped', () => {
    const prompt = buildEvaluateUserPrompt('cond', 'transcript', 0);
    expect(prompt).not.toMatch(/truncated/i);
    expect(prompt).toContain('cond');
    expect(prompt).toContain('transcript');
  });

  it('includes the truncation note when messages were omitted', () => {
    const prompt = buildEvaluateUserPrompt('cond', 'transcript', 3);
    expect(prompt).toMatch(/truncated/i);
    expect(prompt).toContain('3 earlier message');
  });
});

describe('buildTruncationNote', () => {
  it('reports the omitted count and steers toward insufficient evidence', () => {
    const note = buildTruncationNote(5);
    expect(note).toContain('5 earlier message');
    expect(note).toMatch(/insufficient evidence in transcript/i);
  });
});

describe('buildActivationMessage', () => {
  it('embeds the condition and the auto-clear guidance', () => {
    const msg = buildActivationMessage('all tests pass');
    expect(msg).toContain('all tests pass');
    expect(msg).toMatch(/auto-clears/i);
    expect(msg).toContain('existing authorization');
    expect(msg).toContain('missing permission or user decision');
    expect(msg).toMatch(/do not tell the user to run `\/goal clear`/i);
  });
});

describe('buildContinueMessage', () => {
  it('embeds the condition and the remaining reason', () => {
    const msg = buildContinueMessage('build succeeds', '2 tests failing');
    expect(msg).toContain('build succeeds');
    expect(msg).toContain('2 tests failing');
    expect(msg).toMatch(/existing authorization/i);
    expect(msg).toMatch(/missing permission or user decision/i);
  });
});
