/**
 * Evaluate whether a goal condition is satisfied, given the conversation so far.
 */

import type { GoalModelConfig } from './config.js';
import { type CompletionFailure, completeOnce, type GoalModelRegistry } from './llm.js';
import { buildEvaluateUserPrompt, EVALUATE_SYSTEM_PROMPT } from './prompts.js';

export interface GoalVerdict {
  ok: boolean;
  impossible: boolean;
  reason: string;
}

export interface EvaluateOptions {
  registry: GoalModelRegistry;
  modelConfig: GoalModelConfig;
  condition: string;
  transcript: string;
  /** Text-bearing messages dropped to fit the cap; surfaced to the evaluator. */
  omittedCount?: number;
  signal?: AbortSignal;
  onError?: (failure: CompletionFailure) => void;
}

/**
 * Returns a verdict, or null if the model is unavailable / the call failed.
 * A malformed model response is treated conservatively as "not yet met" rather
 * than null, so the engine keeps working instead of silently giving up.
 */
export async function evaluateCondition(opts: EvaluateOptions): Promise<GoalVerdict | null> {
  const { registry, modelConfig, condition, transcript, omittedCount, signal } = opts;

  const raw = await completeOnce(
    registry,
    modelConfig,
    EVALUATE_SYSTEM_PROMPT,
    buildEvaluateUserPrompt(condition, transcript, omittedCount ?? 0),
    signal,
    opts.onError,
  );
  if (raw === null) {
    console.error('[pi-goal] evaluate: model unavailable or call failed');
    return null;
  }

  const verdict = parseVerdict(raw);
  console.error(`[pi-goal] evaluation: ok=${verdict.ok} impossible=${verdict.impossible} `);
  return verdict;
}

/** Parse the JSON verdict leniently; unparseable output → conservative "not yet". */
export function parseVerdict(raw: string): GoalVerdict {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return {
      ok: false,
      impossible: false,
      reason: 'insufficient evidence in transcript (unparseable evaluation)',
    };
  }
  const ok = parsed.ok === true;
  const impossible = parsed.impossible === true && !ok;
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : ok
        ? 'Condition satisfied.'
        : 'Condition not yet satisfied.';
  return { ok, impossible, reason };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  // Fast path: whole string is JSON.
  const direct = tryParse(text);
  if (direct) return direct;
  // Fallback: first {...} block (handles code fences / surrounding prose).
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParse(text.slice(start, end + 1));
  }
  return null;
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
