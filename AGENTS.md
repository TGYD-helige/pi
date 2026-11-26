# Pi repository guide

This monorepo ships Pi extensions in `packages/pi-*`, shared contracts in `packages/shared`, and persistence adapters in `packages/storage`. See the [package list and development setup](README.md).

## Choose a workflow

- **For bug fixes**, use `diagnosing-bugs` to reproduce the reported failure and confirm the cause before editing. Use `tdd` for behavior changes in packages with existing coverage. If two attempts based on the same assumption fail the same check, test that assumption directly before another attempt.
- **For new public contracts, multi-package features, or migrations**, use `to-spec` and `to-tickets` (or the equivalent installed skills) to settle the observable behavior and break delivery into verifiable steps.
- **Before a cross-package refactor**, pin existing behavior with a passing test or a comparison of outputs before moving code. Follow shared consumers, persisted data, and external contracts as well as direct callers. Run the relevant check after each independently verifiable step.
- **Before measuring performance**, read the [performance harness](.github/scripts/performance/README.md#run-locally). For a speed claim, compare the same workload and data scope on both revisions. Confirm comparable successful results before comparing measurements. Report material coverage gaps.
- **For PR reviews**, use `code-review` and apply the contracts below as Standards. Use the PR title and body as the Spec, with [closing-keyword issue links as additional context](docs/agents/issue-tracker.md). Check the actual changed lines and cite the evidence for each finding.
- **For issue and PR triage**, use `triage` and check the [PR labeler](.github/workflows/labeler.yml) for its managed labels.
- **For research**, use `research` to verify claims against primary sources. **For merge or rebase conflicts**, use `resolving-merge-conflicts`.
- **When adding or changing a bundled skill or its evaluation fixtures**, read the [skill evaluation guide](docs/agents/skill-evaluation.md).

Use the applicable installed skills. See [ponytail](https://github.com/DietrichGebert/ponytail) and [mattpocock/skills](https://github.com/mattpocock/skills) for setup. When a skill is unavailable, follow the workflow and verification rules here. Keep installer-generated local tooling out of commits unless the team adopts it.

For Standards review, check the applicable changed paths for project trust and environment expansion, cancellation and deadlines, unbounded or sensitive tool output, raw error logging, and public contract compatibility. Use the corresponding rules below to decide what evidence to require.

## Implement the smallest complete change

Trace input, callers, state, and side effects to the observable outcome before editing. Check the owning package, sibling implementations, and `packages/shared` for existing patterns and the same defect. Reuse them, then prefer standard or platform APIs and installed dependencies. Include affected paths within scope and report any related paths left out. Use direct control flow and concrete types. Keep parsing and decisions separate from I/O where useful, and share an interface only when callers need the same contract.

**For public contracts**, preserve tool and slash-command names and parameters, settings keys, persisted session data, and documented lifecycle behavior, or handle an intentional change with a documented migration. Update tests and the package README when parameters change, and update `promptSnippet` and `promptGuidelines` when user-facing behavior or tool selection changes. Add test coverage for each new config key.

### Tool registration

- Give each new user-facing tool a matching slash command and share the implementation. See the `web_search` and `web-search` entry points in [pi-web-access](packages/pi-web-access/src/index.ts).
- Exceptions cover internal bridges and low-level MCP wrappers, dangerous or destructive operations, and tools with no stable human-friendly input. For an existing tool, consider adding its command when changing that tool.
- Use `StringEnum` from `@earendil-works/pi-ai` for fixed string choices. Write a one-line `promptSnippet` and refer to the tool by name in its `promptGuidelines`.

## Pi runtime contracts

Read the [Pi extension API](https://pi.dev/docs/latest/extensions) for hooks, registration, and UI. When relying on a runtime field such as `ctx.mode`, inspect the installed Pi type declarations or source at the target release. Check the API against the affected package's declared minimum Pi version.

### Settings, trust, and models

Import settings and path helpers from `@amaster.ai/pi-shared/settings`. Use `resolveHome()` for runtime data and `resolveConfigDir()` for config. See the [shared loader](packages/shared/src/settings.ts) for precedence and interpolation.

- **Extension settings** use `loadPiSettings<Settings>(key, { cwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) })`. Settings load from global, then agent dir, then trusted project.
- **Project trust** gates project settings and policy reads. Keep project environment placeholders literal. Expand variables only in global and agent-dir settings. Use `expandBareEnvVars: false` when the package opts out of bare variable expansion.
- **Authorization decisions** use `loadPiSettingsAsync` and `loadPiPolicyProfilesAsync` with the same directory and trust options plus the operation's `signal`. Deny authorization when configuration is unreadable or invalid.
- **Policy-read performance in pi-security** starts from the existing refresh in `createGate` and [concurrent read coalescing](packages/pi-security/src/refresh.ts). Keep fresh reads across sequential decisions. For a read-saving optimization, test every affected edit, replacement, and revocation path at the next authorization. If reuse depends on file metadata, include a same-length edit with the original timestamp restored. If a check fails, preserve the fresh read and report any savings available from coalescing or parsing.
- **For model requests**, use `streamModelRequest` or `completeModelRequest` from `@amaster.ai/pi-shared/models` with `ctx.modelRegistry`. The registry resolves credentials per request and routes registered providers and virtual models. Pass an empty auth object when targeting registry-only Pi. Supply credentials from `getApiKeyAndHeaders(model)` for the [shared helper's compatibility fallback](packages/shared/src/models.ts) on older Pi. Keep provider calls on this shared path.

### Tools, lifecycle, and logs

- **Tool output** needs limits before materializing external data, and on final results and progress updates. Bound `content`, `details`, and `structuredContent`. For subprocess diagnostics, return sanitized excerpts and small status fields.
- Reuse the package's truncation helper, Pi's `truncateHead`/`truncateTail` for text, or the shared `boundStructuredContent` for structured results. Use Pi's built-in 50 KB and 2,000-line limits as text budget reference points. Include truncation notices and formatting in the budget.
- **Agent-facing tool failures** use the same error format across all plugins. Require a stable `code` and a `message` that explains what happened. For actions with side effects, say when execution was refused before it started or when the outcome is unknown, if established.
- Add `cause` when it provides a concrete reason the agent can use. Its `message` may preserve vetted original wording or a sanitized explanation, with `source` and the original `code` when available. Add `recovery` only when the plugin can offer a specific next action that the message or cause has yet to explain.
- Render the first line of model-visible `content` as `[<code>] <message>`. Follow it with `Cause (<source>): <cause.message>` when present, or `Cause: <cause.message>` when the source is unavailable. Use `Recovery: <recovery>` only when present. The tool call already identifies the tool. Keep credentials, raw response bodies, and stack traces out of tool results and logs.
- Generate the model-visible text and `structuredContent` from the same error data. Use `structuredContent.error` for the object with `code`, `message`, and any optional fields. Return `isError: true` where the runtime honors it and follow the compatibility rule below otherwise. For pre-execution denials through Pi’s reason-only `tool_call` hook, use the same text format in `reason`.
- **Tool errors on older Pi** need a sanitized thrown error when the runtime must record a failed call. Pi releases before 0.99 mark a resolved result as successful even with `isError: true`. For a subprocess tool, cover startup failures, nonzero exits, and deadlines as well as cancellation. Let the sanitized failure escape any shared wrapper. At the package's compatibility floor, verify the actual tool failure status for a non-cancellation error.
- **For cancellable tool work**, forward the `signal` supplied to tool `execute()` into downstream I/O. For other work tied to an agent run, `ctx.signal` is available while that run is active. Give independent work its own cancellation and deadline. Cover queue wait, DNS, response body, and child processes with one end-to-end deadline per external operation. Clean up listeners and timers, block late side effects, and keep uncancellable work single-flight until it settles.
- **Lifecycle hooks** use `agent_end` for the end of one run and, where supported, `agent_settled` to observe final idle after retries and queued continuations. Use `session_shutdown` for teardown on exit, reload, or session replacement. Rebuild runtime state in `session_start`. Check the [lifecycle overview](https://pi.dev/docs/latest/extensions#lifecycle-overview) and [session replacement rules](https://pi.dev/docs/latest/extensions#session-replacement-lifecycle-and-footguns) when changing these hooks or commands.
- **Independent features in one hook** validate shared input first, then handle each side effect under its own flag. An early return for a disabled or completed branch must happen after independent work. See the `input` handler in [pi-memory-mem0](packages/pi-memory-mem0/src/index.ts).
- **UI** uses `ctx.hasUI` for dialogs. Guard terminal-only behavior with `ctx.mode === 'tui'` where supported. RPC can have UI.
- **Logging** uses `console.error` with a `[package-name]` prefix and a sanitized diagnostic. Log unexpected errors and one startup diagnostic. Gate verbose logs with `DEBUG` and use runtime events for normal tool execution. Reserve stdout for expected machine-readable CLI or migration output.
- Keep raw errors, response bodies, credentials, and full user messages out of logs. Read credentials from environment variables or user and agent-dir settings, and validate them before use. Keep credential values out of source.

### User data and recurring work

**Configuration writes** follow this sequence.

1. Coordinate overlapping writers before reading the configuration for an update. Hold that coordination through replacement.
2. Treat only a missing file as an empty configuration. Preserve unreadable or malformed files and report the error. Fill missing defaults while preserving explicit values and unrelated fields.
3. Create a temporary file in the same directory with restricted permissions from creation for sensitive data, for example `0o600` where applicable. Rename it over the target and preserve or tighten existing permissions.
4. Verify the result with fresh and user-edited data when changing defaults, sync, or migration. State how existing data is migrated or recovered.
- **For background writes**, bound queues and shutdown waits. Persist accepted writes before acknowledging them, preserve order, and retain unfinished data for recovery. Report capacity rejections and ambiguous outcomes. For changes to retryable writes, verify the observable result of replay or recovery after interruption.
- **On startup and recurring paths**, perform cheap enabled/model/trust checks before imports, scans, or I/O. Use asynchronous I/O and child processes. Select by metadata before decoding and bound reads, results, and concurrency. Keep independent work off the prompt's critical path.
- **Recent history** keeps the newest relevant item. Budget for its formatting and bound the item itself if it exceeds the limit. See [transcript regressions](packages/pi-goal/src/__tests__/transcript.test.ts).
- **For repeated work**, remove redundant calls before adding concurrency or caching. Reuse consistent snapshots, batch supported lookups, and skip known unchanged writes. Bound cache size and lifetime, include trust and all result-affecting inputs in keys, and preserve individual cancellation when coalescing work. Cover changed limits, cancellation, overload, or invalidation with focused tests. Preserve lifecycle, trace, privacy, and durability behavior.

## Extension packaging and previews

- **For a new extension**, use a working sibling manifest, TypeScript configuration, and entry as references. Export the extension factory as the default export from `src/index.ts` and point `pi.extensions` at its built entry. Declare `pi.skills` when shipping skills. Declare any used Pi runtime packages and `typebox` as peers and keep them external to bundled output. Choose a minimum compatible with the APIs used. Add the package README and tests and check [workspace discovery](pnpm-workspace.yaml).
- **For a listed extension**, include a package-root preview and set `pi.image` to that asset. Follow the [existing previews](README.md#extension-previews). Use a 1672 × 941 PNG with extension copy on the left, relevant UI or icons on the right, and a distinct central beaver. Prefer blue and white and include an instrument when it fits. For listing changes to name, tagline, or capability scope, update the preview, root listing, package README, and manifest together.

## Verify the change

- **Unit tests** use Vitest in `src/__tests__/<module>.test.ts` with a module-level `describe` and `it` cases. Run `pnpm exec vitest run <path>` for a focused check or `pnpm test` for the suite. Keep cross-package and end-to-end tests in `tests/`.
- **Extension registration tests** load the factory with a minimal `ExtensionAPI` mock, capture the registered tools, commands, or hooks, and invoke the public handler under test. See [pi-web-access tests](packages/pi-web-access/src/__tests__/extension.test.ts).
- **Test isolation** uses `mkdtemp` with a `pi-<pkg>-<suite>-` prefix, offline fixtures, and settings and environment isolated from the real Pi home. Wait for servers, processes, timers, and background work before cleaning up. Use observable state or controlled clocks for timing. Put live providers behind explicit integration runs.
- **Runtime regression** uses the original entry point and reported mode or platform when available. Record the mode and platform exercised. Use the same input to show the failure before the fix and success after, with a sanitized fixture when needed. For a changed end-to-end path, assert the returned result or observable side effect. For tool calls, also match `tool_execution_end` and the expected success or error status using the [Integration assertions](.github/workflows/integration.yml). For an RPC framing change, validate every stdout frame independently of stderr. Read back the changed state after a write.
- **Host compatibility** uses the affected package's declared minimum Pi version and the current target when changing version-sensitive behavior. Exercise the public entry point. Report the declared floor, the exact Pi versions and modes exercised, relevant platforms, and any target checked only in source.
- **For a new or changed extension entry**, run `pnpm pr-check`. The entry check imports built modules and checks that each default export is a function. Exercise the extension's public behavior separately through the relevant entry point. Use the root [scripts](package.json) to choose the focused or full checks.
- **When changing a package's `files`, `exports`, `pi` manifest, or bundled assets**, build the current revision, run `pnpm --dir <package> pack --pack-destination <temp-dir>` and check the tarball for the relevant entries and assets. For an installed-behavior claim, load the packed artifact and exercise the affected entry point. See the [release workflow](.github/workflows/npm-publish.yml) for the WeCom skill pack check.

### Agent guidance and model changes

- Check local links when editing this guide. For a workflow or guardrail change, compare the guides on the same tasks, source, model, and harness. For a model or harness change, keep the guide, tasks, and source fixed.
- Give each candidate an isolated copy of the same source revision and its assigned guide. Keep the original checkout, its Git history, and other candidates' workspaces outside candidate access.
- Fix each case's observable pass criteria before either run and keep the scoring material outside candidate context. Compare anonymized outputs against the same criteria and check actual reads, tool calls, diffs, or executed checks. Any applicable hard rule missed fails that case. Record versions, evidence, and coverage gaps per case.
- When a mistake recurs, first look for an existing test, type, or check that can catch it. Verify the guardrail against the original failure.
- Read-only cases can verify routing and review findings. Claims about compatibility, packaging, or persisted behavior require execution through the affected public entry point. Reuse representative cases for project trust, user data, cancellation, and package or RPC behavior. See [Skill Eval](docs/agents/skill-evaluation.md) for fixed rubrics for packaged skills and [product evals](tests/eval/README.md) for independent runtime assertions.
- When rechecking tool failures after a model or harness change, reuse the [legacy RPC tool failure case](tests/eval/README.md#rpc-tool-failure-case).
- The [automated reviewer](.github/scripts/publish-pi-review.mjs) takes Standards from the trusted base's root and applicable directory `AGENTS.md` files. Keep mandatory review rules in those files.

## GitHub and worktrees

- Write authored GitHub issues, PRs, reviews, comments, and discussions in English. Preserve exact identifiers, logs, or quotations when evidence requires them. Use the [issue template](.github/ISSUE_TEMPLATE/issue.md) and [PR template](.github/pull_request_template.md). For issues, include the affected package and version where applicable, the expected outcome, and the smallest reproduction or relevant context. Use a conventional-commit PR title prefix supported by the labeler.
- Keep each PR focused. State the change, rationale, intended behavior, and verification in the PR body. Link the related issue when one exists. Use package READMEs for usage and the PR for implementation rationale and verification. Keep each Markdown prose paragraph on one source line.
- Report checks on the final reviewed commit, including failed checks and material gaps. Re-run affected checks after edits or a rebase. Count only completed passing checks as passes. To call a failure pre-existing, reproduce it with the same command and environment on the base and report the base SHA.
- Use a separate worktree when another session or unrelated changes occupy the checkout. Preserve others' files, index, and logs. Stage explicit paths and inspect the staged diff before committing.
