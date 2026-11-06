/**
 * Derive a measurable completion condition from recent conversation.
 */

import type { GoalModelConfig } from './config.js';
import { type CompletionFailure, completeOnce, type GoalModelRegistry } from './llm.js';
import { buildDeriveUserPrompt, DERIVE_SYSTEM_PROMPT } from './prompts.js';

export interface DeriveOptions {
  registry: GoalModelRegistry;
  modelConfig: GoalModelConfig;
  transcript: string;
  signal?: AbortSignal;
  onError?: (failure: CompletionFailure) => void;
}

/**
 * Returns a one-line condition, or null if the model is unavailable, the call
 * fails, or no actionable objective could be inferred (model returned NONE).
 */
export async function deriveCondition(opts: DeriveOptions): Promise<string | null> {
  const { registry, modelConfig, transcript, signal } = opts;
  if (!transcript.trim()) {
    console.error('[pi-goal] derive: empty transcript, nothing to derive from');
    return null;
  }

  const raw = await completeOnce(
    registry,
    modelConfig,
    DERIVE_SYSTEM_PROMPT,
    buildDeriveUserPrompt(transcript),
    signal,
    opts.onError,
  );
  if (raw === null) {
    console.error('[pi-goal] derive: model unavailable or call failed');
    return null;
  }

  const condition = normalizeCondition(raw);
  if (!condition || condition.toUpperCase() === 'NONE') {
    console.error('[pi-goal] derive: no actionable objective inferred (NONE)');
    return null;
  }
  console.error(`[pi-goal] derived condition: ${condition}`);
  return condition;
}

function normalizeCondition(raw: string): string {
  // Take the first non-empty line, strip stray wrapping quotes/backticks.
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '';
  return firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
}
