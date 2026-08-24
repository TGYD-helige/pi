# @amaster.ai/pi-eval

Internal eval harness for pi packages. **Private workspace package** — not published.

Domain runners live in subdirs (`memory/`, ...). Shared loaders, judge, and fetch scripts live at root so cross-domain reuse is free.

## Layout

```
tests/eval/
  package.json
  datasets/             # gitignored; populated by fetch scripts
  results/              # gitignored; per-runner JSON output
  scripts/
    fetch-locomo.ts     # pull LoCoMo JSON from upstream (MIT)
    judge-llm.ts        # LLM-judge a results/*.json → recallJudge
  src/
    loaders/locomo.ts   # forgiving JSON adapter
    judge.ts            # token-F1 helper (fast in-runner baseline)
    pi-harness.ts       # shared driver: real `pi` CLI + isolated config + event-stream parse
  memory/
    run-mem0.ts         # pi-memory-mem0 runner (passive extraction)
    run-memory.ts       # pi-memory runner (real memory_add/replace/remove loop)
  browser/
    run-browser.ts      # pi-browser-use L3 runner (real Chrome via pi CLI)
    tasks.ts            # browser task set + deterministic success predicates
  computer/
    run-computer.ts     # pi-computer-use L3 runner (real cua-driver via pi CLI; macOS-only)
    tasks.ts            # desktop task set + deterministic success predicates
  video/
    run-video.ts        # pi-video-gen ViMax-Bench runner (real shot-book pipeline via pi CLI)
```

## Quick start

```bash
pnpm install
pnpm --filter @amaster.ai/pi-eval fetch:locomo

MODELS=/path/to/.pi/agent/models.json   # provides provider baseUrl + apiKey

# pi-memory-mem0 (OSS mode: extraction + embedding resolved from models.json)
pnpm --filter @amaster.ai/pi-eval eval:memory:mem0 -- \
  --mode oss --samples 2 --topk 10 --concurrency 2 --models "$MODELS"

# pi-memory (real write loop: LLM emits memory ops per session)
pnpm --filter @amaster.ai/pi-eval eval:memory:curated -- \
  --samples 2 --concurrency 2 --models "$MODELS"

# LLM-judge either result file → recallJudge
pnpm --filter @amaster.ai/pi-eval judge:llm -- \
  --input results/mem0-locomo-oss.json --llm-model deepseek-v4-pro \
  --concurrency 6 --models "$MODELS"
```

Platform mode for mem0 (`--mode platform`) reads `MEM0_API_KEY` instead.

## Browser (pi-browser-use L3 — task-completion rate)

Answers the "does it actually work" question: a **real** tool-calling LLM must complete a task using only the `browser_*` tools, driving a **real Chrome**. It drives the extension through the **real `pi` CLI** — the same way `.github/workflows/integration.yml` does: install the extension with `pi install` into an isolated config dir, then `pi --mode json -p '<task>' --tools <allowlist>` and parse the event stream. The extension runs exactly as shipped (built dist, pi's own dependency resolution), so the success rate reflects the real wrapper (snapshot handling, tool descriptions, overlay/stale hints) plus the model — no importing package internals, no hand-rolled tool loop.

Nothing is hardcoded. Provider, model, endpoint, and key are all parameterized:

```bash
# endpoint + key from env (repo convention: PI_INTEGRATION_*). The generated
# models.json references the key by env-var NAME, so the secret never lands on disk.
export PI_INTEGRATION_BASE_URL="https://your-gateway/v1"
export PI_INTEGRATION_API_KEY="sk-..."

pnpm --filter @amaster.ai/pi-eval eval:browser -- \
  --provider deepseek-integration --model deepseek-v4-flash

# single task:
pnpm --filter @amaster.ai/pi-eval eval:browser -- --task example-title

# LLM-judge the run (only needed for tasks without a deterministic `check`):
pnpm --filter @amaster.ai/pi-eval judge:llm -- \
  --input results/browser-tasks.json --llm-model deepseek-v4-pro --models "$MODELS"
```

Flags (all optional, with env fallbacks): `--models <path>` (use a ready-made models.json verbatim — what CI does; `PI_MODELS_PATH`), or generate one from `--provider` (`PI_EVAL_PROVIDER`, default `deepseek-integration`), `--model` (`PI_EVAL_MODEL`), `--base-url` (`PI_INTEGRATION_BASE_URL`), `--api` (`PI_EVAL_API`, default `openai-completions`), `--api-key-env` (`PI_EVAL_API_KEY_ENV`, default `PI_INTEGRATION_API_KEY` — names the env var holding the key). Plus `--thinking` (default `high`), `--timeout` (per-task ms), `--tasks N`, `--task <id>`. Chrome is found via `CHROME_BIN` or common macOS/Linux paths; if none, install one with `npx -y @puppeteer/browsers install chrome@stable` and set `CHROME_BIN` (the Linux-CI step from integration.yml).

**Scoring.** Each task in `browser/tasks.ts` carries a deterministic `check(answer, observed)` predicate — success is a string/regex match over the model's final answer plus the tool outputs it saw. No LLM in the scoring path, so numbers are stable and free. Tasks that genuinely can't be reduced to a match omit `check` and defer to `judge-llm.ts` (every task still sets `gold`). The summary reports `successRate` (over checked, non-crashed tasks), `avgTurns` (model round-trips to reach a passing answer — **fewer is better**; a sharper wrapper/prompt lets the model finish in fewer turns), `avgToolCalls`, and a `failureMix` bucketing each task as `ok` / `check-failed` / `tool-error` / `crash` — a regression in, say, snapshot stripping shows up as a shift in the mix.

Task coverage aims at the failure modes the wrapper is responsible for, not just happy-path reads: single reads (`example-*`, pinned Wikipedia), form fill+submit (`login-form-submit` — two fields + submit on the-internet.herokuapp.com), and **multi-step navigation** (`multi-step-navigate` — click a link, re-snapshot after uids invalidate), which exercises the extension's stale-element handling. Seeds are chosen for stability: IANA-reserved `example.com`/`example.org`, pinned Wikipedia `oldid`s, and the SeleniumHQ demo site — httpbin.org was dropped after it flaked repeatedly (503s / timeouts) in trial runs.

**CI.** Runs as the manual **Agentic Eval** workflow (`.github/workflows/agentic-eval.yml`, `workflow_dispatch`) — kept separate from integration.yml, which is a pass/fail smoke test; this one is effect evaluation. The workflow installs a real Chrome and writes models.json from the `PI_INTEGRATION_*` secrets, then runs this runner and publishes a scored summary.

Known variance:
- **Site availability.** Seed sites can be down — a seed 503 shows up (correctly)
  as `check-failed`/`tool-error`. Prefer static seeds; re-run before reading a
  single-run failure as a regression.
- **Model drift.** Temperature aside, tool-calling models still vary run-to-run
  in tool-call count and page-reading accuracy. Treat `successRate` as ±.
- **Wikipedia** tasks pin an `oldid` so article text can't drift; other seeds are
  chosen for stability but are not pinned.

## Computer (pi-computer-use L3 — desktop task-completion rate)

Same shape and same `pi`-CLI harness as the browser eval, one level lower: a real tool-calling LLM drives **real macOS desktop apps** via `computer_use_*` tools. The extension (with its own `formatToolError` / bundled `cua-driver`) runs as shipped. Most seed apps are built-in system apps (Calculator, TextEdit, Notes) so results are deterministic and offline. One task (`netease-daily-recommend`) drives a real third-party app (NetEase Cloud Music) to its 每日推荐 entry — a genuine agentic-interaction case; its `check` only verifies the agent reached the recommendation view (content is login-gated and changes daily), and it is skipped implicitly if the app isn't installed (the launch tool errors → `tool-error`).

```bash
export PI_INTEGRATION_BASE_URL="https://your-gateway/v1"
export PI_INTEGRATION_API_KEY="sk-..."

pnpm --filter @amaster.ai/pi-eval eval:computer -- \
  --provider amaster --model deepseek-v4-flash

pnpm --filter @amaster.ai/pi-eval judge:llm -- \
  --input results/computer-tasks.json --llm-model deepseek-v4-pro --models "$MODELS"
```

Flags are identical to the browser runner. Result file: `results/computer-tasks.json`, same summary shape.

**macOS-only, and skips gracefully elsewhere.** On any non-macOS platform (e.g. a Linux CI runner) the runner writes a `{skipped: true}` result and exits 0 — it never fails a cross-platform pipeline. On macOS it requires:
- The bundled `cua-driver` binary for your platform
  (`packages/pi-computer-use/bin/<platform>/`).
- **Accessibility** *and* **Screen Recording** granted to the process running the
  eval (System Settings → Privacy & Security). Without them cua-driver returns
  `ax_not_granted` / `sc_not_granted`; the extension's own permission hint then
  surfaces in the tool output and tasks fail as `tool-error`.
- Apps launch **visibly** and receive synthetic clicks/keystrokes — don't run
  this while doing other work on the same machine.

The **Agentic Eval** workflow includes a `computer-eval` job (run it via the `target` input), but there is no hosted macOS runner wired to it yet — on the Linux runner it no-ops via the graceful skip above. Point the job's `runs-on` at a macOS runner with the TCC grants to get real numbers.

## Video (pi-video-gen on ViMax-Bench — render quality + cross-shot consistency)

Answers "how good is the video our shot-book pipeline actually produces" — a **quality** eval, unlike the L3 task-completion runners above. Input data is [HKUDS/ViMax](https://github.com/HKUDS/ViMax)'s `vimax_benchmark/` (MIT): 35 multi-shot story specs (Type A = character persistence, B = background persistence, C = multi-person separability; Medium = 2 scenes/8-10 shots, Long = 3-4 scenes/12-16 shots). The runner converts each spec **deterministically** into a VideoProject shot book, then drives the real `pi` CLI to execute it (`image_generate` per shot frame → one `video_render`) — the LLM only executes the plan, so scores reflect render/orchestration quality, not planning variance.

**COST WARNING: every story is 8-16 paid video clips + ~1 image per shot.** Always slice with `--samples`/`--tier`/`--story`.

```bash
pnpm --filter @amaster.ai/pi-eval fetch:vimax        # one-time, pinned commit

# local: reuse your ~/.pi/agent video/image provider config
pnpm --filter @amaster.ai/pi-eval eval:video -- --use-default-pi --model deepseek-v4-flash --samples 2 --tier medium

# CI shape: generated extension settings from env (mirrors integration.yml's gateway)
export PI_INTEGRATION_BASE_URL="https://your-gateway/v1"
export PI_INTEGRATION_API_KEY="sk-..."
export PI_EVAL_IMAGE_MODEL="doubao-seedream-5-0-lite-260128"
pnpm --filter @amaster.ai/pi-eval eval:video -- --model deepseek-v4-flash --samples 2 --models "$MODELS"

# VLM-judge the run (needs ffmpeg on PATH or FFMPEG_PATH, and a vision model)
pnpm --filter @amaster.ai/pi-eval judge:video -- \
  --input results/video-vimax.json --llm-model kimi-k2.6 --models "$MODELS"
```

Extra flags: `--tier medium|long|all`, `--story <id>`, `--video-model` (default `doubao-seedance-2-0-260128` via a newapi-shaped gateway), `--timeout` (default 2h per story — a full shot-book render takes tens of minutes). Artifacts (generated images, per-shot clips, `final_video.mp4`, judge frames) land in `results/artifacts/`.

**Scoring.** `run-video.ts` reports pipeline health: `completionRate` (final video verified on disk), `specViolations` (runs where the LLM rewrote the shot book instead of executing it — the written `render-input.json`'s shot ids/order are compared against the spec), `avgTurns`, `failureMix`. `judge-video.ts` reports quality: a VLM scores `consistency` (1-5, rubric keyed to the story's ViMax type) and per-shot `prompt_following` from probed mid-clip frames, aggregated overall and by type. The VLM judge reimplements the *spirit* of the paper's ViCLIP consistency metric — **scores are comparable across providers and across our own releases, not to the ViMax paper numbers** (that would require reimplementing ViCLIP; out of scope, see Status).

## Datasets

- **LoCoMo** — multi-session conversational QA. Pulled from [snap-research/locomo](https://github.com/snap-research/locomo) (MIT). ~600 samples; runner takes `--samples N` for a slice.
- **ViMax-Bench** — 35 multi-shot story specs for video consistency. Pulled from [HKUDS/ViMax](https://github.com/HKUDS/ViMax) (MIT), pinned commit in `scripts/fetch-vimax.ts`. Data only — scoring is ours.
- LongMemEval / MemBench — TODO. Same fetch-on-demand pattern.

We deliberately do **not** consume [OpenDataBox/MemoryData](https://github.com/OpenDataBox/MemoryData) directly — that repo has no license. We borrow its evaluation taxonomy (recall / conflict / multi-session / update) and pull data from each upstream.

## Why pi-memory and pi-memory-mem0 are evaluated differently

| Aspect              | pi-memory (curated)                       | pi-memory-mem0 (passive)              |
|---------------------|-------------------------------------------|---------------------------------------|
| Storage             | 2200 + 1375 char hard cap                 | Vector store (SQLite / cloud)         |
| Write decision      | LLM emits memory_add/replace/remove ops   | Background per-turn extraction        |
| Retrieval           | None — the whole snapshot is the context  | Semantic top-k search                 |
| What LoCoMo rewards  | —                                        | Storing every retrievable detail      |

Both runners produce a memory `blob` per question and the same LLM-judge asks "does this memory contain the answer?" — so the numbers share a scale. But **do not read them as a leaderboard.** LoCoMo asks 300+ fine-grained recall questions (exact dates, who-did-what, multi-hop). pi-memory's whole design is to *discard* most of that under a hard char budget and keep only high-value facts (preferences, corrections, stable environment facts). It compresses 19 sessions of conversation into ~a few hundred chars on purpose. mem0's unbounded vector store keeps everything, so it recalls arbitrary details far better.

The gap below reflects that mismatch, not that one is "better". A fair pi-memory benchmark would measure long-term retention of a small set of high-value facts, not exhaustive detail recall.

## Results (LoCoMo, 2-sample slice: conv-26 + conv-30, 304 QA)

Extraction/write + answer model: `deepseek-v4-flash`. Judge: `deepseek-v4-pro`. Endpoint resolved from a pi `models.json` (`--models`).

| Runner            | literal recall | LLM-judge recall |
|-------------------|---------------:|-----------------:|
| pi-memory-mem0    |          ~0.39 |            ~0.44 |
| pi-memory         |          ~0.26 |            ~0.19 |

Notes:
- mem0's judge score was ~0.27 before two fixes: isolating mem0's SQLite vector
  store per run (it defaults to `~/.mem0/vector_store.db` and silently
  accumulates across runs, polluting recall) and wiring `observedAt` so
  extracted facts carry the conversation date, not the wall clock.
- LLM-judge has run-to-run variance (flash drifted ~10 points between runs; pro
  is steadier). Treat these as ±, not exact. Averaging multiple judge passes is
  a TODO.

## Status

Working, run manually (no CI hook). Open items:

- Only LoCoMo wired; LongMemEval / MemBench are TODO (same fetch-on-demand pattern).
- Video eval v1 executes pre-planned shot books only; LLM-planned runs (planning
  quality) and a ViCLIP reimplementation (paper-comparable numbers) are TODO.
- Multi-sample averaging to shrink variance (currently 2 samples).
- Judge variance reduction (multi-pass majority vote).
- Reasoning models need generous `max_tokens` (write loop uses 4096, judge 512) —
  content comes out empty if the budget is spent on reasoning_content.
