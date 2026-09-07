/**
 * Prompt templates for the goal engine.
 *
 * The evaluator and activation prompts are adapted almost verbatim from Claude
 * Code's own stop-hook prompts (agent-prompt-hook-condition-evaluator-stop,
 * system-reminder-session-stop-hook-active), tuned only where pi's mechanics
 * differ (a `/goal` command instead of CC's). The derive prompt has no CC
 * analogue — CC always takes an explicit condition — so it is ours.
 */

export const DERIVE_SYSTEM_PROMPT = `You infer a single, concrete completion condition from a coding conversation.

Given the recent transcript, output ONE line describing the measurable outcome that would mean the user's current objective is fully handled. This condition will later be used to judge whether the agent may stop working.

Rules:
- Output ONLY the condition text — no preamble, no quotes, no markdown, no trailing explanation.
- Make it measurable and verifiable (e.g. "All tests pass and \`pnpm lint\` reports no errors", "The /login endpoint returns 200 for valid credentials and 401 otherwise").
- Base it on the user's most recent intent, not incidental side-quests.
- Keep it under 300 characters.
- If the conversation has no actionable objective, output exactly: NONE`;

export function buildDeriveUserPrompt(transcript: string): string {
  return `## Recent conversation\n\n${transcript}\n\n---\nInfer the single measurable completion condition, or output NONE.`;
}

/**
 * Stop-condition evaluator. Adapted from Claude Code's
 * `agent-prompt-hook-condition-evaluator-stop` — the quote-evidence
 * requirement, the "insufficient evidence in transcript" fallback, and the
 * impossible-judgment discipline all come from CC's original wording.
 */
export const EVALUATE_SYSTEM_PROMPT = `You are evaluating a stop-condition hook. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`;

/**
 * Note prepended to the transcript when older messages were dropped to fit the
 * evaluator's char cap. Adapted from CC's
 * `system-prompt-hook-evaluator-truncated-transcript-note`: if the evidence
 * might be in the omitted prefix, the evaluator should return insufficient
 * evidence rather than guess.
 */
export function buildTruncationNote(omittedCount: number): string {
  return `[Earlier conversation truncated to fit the evaluator's context window — ${omittedCount} earlier message(s) omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`;
}

export function buildEvaluateUserPrompt(
  condition: string,
  transcript: string,
  omittedCount = 0,
): string {
  const note = omittedCount > 0 ? `${buildTruncationNote(omittedCount)}\n\n` : '';
  return `## Conversation transcript\n\n${note}${transcript}\n\n## Condition\n\n${condition}\n\n---\nHas the condition been satisfied? Reply with the JSON verdict only.`;
}

/**
 * Injected once when a goal is set, so the main agent starts working toward it.
 * Adapted from CC's `system-reminder-session-stop-hook-active`.
 */
export function buildActivationMessage(condition: string): string {
  return `A goal is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — pursue the condition within the existing authorization. A goal does not grant new permissions. If blocked by missing permission or user decision, report the blocker and continue only independent authorized work. Work will be blocked from stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`;
}

/** Injected after a not-yet-met evaluation to drive the next round of work. */
export function buildContinueMessage(condition: string, reason: string): string {
  return `The goal condition is not yet met: "${condition}". ${reason} Continue working toward the condition within the existing authorization. If blocked by missing permission or user decision, report the blocker and continue only independent authorized work; the goal does not grant new permissions.`;
}
