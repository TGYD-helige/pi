# Skill evaluation

Run the deterministic harness checks with `pnpm vitest run .github/scripts/skill-eval.test.mjs .github/scripts/skill-eval-tools.test.mjs`. The Skill Eval workflow runs `.github/scripts/skill-eval.mjs` with explicit base/head SHAs, provider/model and time limits. Changes to `evals.json` alone also trigger it.

Each skill carries 3–5 cases. Text cases retain declarative `expectations` and `expected_output`; an independent model call judges full requirements and returns a boolean plus quoted evidence per expectation. Keyword mentions alone cannot award points. Invalid verdicts, missing evidence, timeouts and crashes fail the run. This remains a stochastic judge, not proof of agent execution.

Tool cases set `mode: "tools"`. Pi discovers the explicitly loaded skill rather than receiving its body up front; a trusted evaluation extension exposes bounded Markdown reads and fixed media tool fixtures. Expectations score observed successful calls using `tool`, optional `pathSuffix`, `args`, `count`, `before`, or `forbiddenTools`. Tool cases pass only if every assertion passes and every executed tool succeeds. The `resume` scenario accepts only the existing video job ID. Tool-call traces are saved beside each response in `outputs/tool-calls.json`.

Existing base cases and rubrics remain authoritative for regression comparison. New IDs in the candidate are executed separately and must score at least 0.8; changing an existing case does not replace the base rubric in that PR. Use a new ID for new behavior. New skills still require score ≥ 0.8 and improvement ≥ 0.1 against the no-skill baseline. Comparative benchmark aggregates use the same base cases; candidate-only runs remain individually visible.

The workflow checks out and executes only trusted base code. Candidate skill files are materialized as bounded git blobs. The read tool accepts only Markdown inside that skill; candidate scripts, external paths and shell execution are unavailable. Media tools return fixed data and never contact paid providers or write output assets. These tests cover discovery, reference reads, routing, parameters, approval and recovery decisions for the listed fixtures; they do not validate provider behavior, visual quality or arbitrary skills requiring additional tools.

When changing this trusted harness, its new behavior takes effect in pull-request evaluation only after the harness reaches the base branch. Run local deterministic checks and explicit model smoke cases before relying on the workflow result for the change itself.

Tool expectations also carry legacy `includes` or `excludes` fields so the pre-trace base validator can read candidate files during the harness rollout. The new evaluator ignores these fields for tool cases and scores actual calls; the old evaluator still runs its unchanged base cases and does not execute new candidate-only cases.

Set the repository Actions variable or secret `PI_INTEGRATION_MODEL` (variable takes precedence) to select the text model on the existing integration gateway; unset or empty defaults to `deepseek-v4-flash`. Integration and Skill Eval use this selection, while embedding, image and browser vision models retain their separate settings. The existing gateway protocol and model capability profile are unchanged. Workflow changes under `pull_request_target` take effect after reaching the base branch.
