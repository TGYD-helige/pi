# Offline runtime performance

The independent `Performance` workflow runs on pull requests and pushes to `master`/`main`, and supports manual dispatch. Pull requests compare against the PR base commit; pushes compare against the previous branch head; manual runs compare against the selected commit's first parent. No model credentials or external services are required. Performance workers reject TCP connections and fetch requests; model tasks, service validation, and native browser/desktop behavior belong in `integration.yml`. The workflow runs independent `runtime`, `sessions`, and `profiles` matrix jobs, with separate artifacts.

## Coverage

All 17 extension packages have an independent cold-import measurement in a fresh Node process, using each package manifest's actual extension entry. Timing excludes Node startup and extension factory execution. The suite checks package discovery against its coverage list, so adding or removing an extension requires updating the benchmark coverage.

| Package | Additional measured paths | External boundary |
| --- | --- | --- |
| `pi-attachments` | Render 20 text attachments with an 8 KB text budget; enumerate and bound a 220-file directory | Real temporary files; no remote downloads |
| `pi-browser-use` | Convert a 1,000-node MCP snapshot into bounded model-visible content | Recorded MCP-shaped input; no browser or remote session |
| `pi-computer-use` | Convert and bound a 1,000-element accessibility tree | Recorded driver-shaped input; no native driver or desktop |
| `pi-channels` | Render a 100-row table; resolve routes and dispatch 100 messages | In-memory adapter; no message delivery |
| `pi-dingtalk` | Unconfigured session start, resource discovery, and shutdown | No CLI installation or login |
| `pi-lark` | Unconfigured session start, resource discovery, and shutdown | No CLI installation or login |
| `pi-wecom` | Unconfigured session start, resource discovery, and shutdown | No CLI installation or login |
| `pi-goal` | Build and bound an evaluation transcript from 1,000 messages | No model evaluation |
| `pi-image-gen` | Read and validate four local 1024×768 PNG images (approximately 9 MiB total); bound 10 image results with oversized revised prompts | Real files and input handling; no paid image generation |
| `pi-memory` | Load/sanitize 12 persisted facts, live reads, prompt snapshots, persistent add/remove, four concurrent writes with readback and removal | Real temporary files; no extraction model or dreaming |
| `pi-memory-mem0` | Prefetch and format 100 recalled memories; redact approximately 64 KiB of memory text | Fixed in-memory search provider; no embeddings, vector database, or extraction model |
| `pi-security` | Classify a real workspace file-write request and evaluate 100 rules | Real path classification; no approval dialogs |
| `pi-task-scheduler` | Load 100 tasks, filter by session scope, persist add/delete with cross-session denial checks | Real temporary JSON store; no scheduled agent execution |
| `pi-teamwork` | Parse and map 100 issues through the Multica adapter | Injected CLI response; no daemon or server |
| `pi-telemetry` | Disabled session/prompt hooks; project/serialize 100 messages; reject oversized input; mask headers and payloads; truncate a 1 MiB multibyte payload; publish/flush 100 events; exporter lifecycle and retained heap | Real OpenTelemetry SDK with an in-memory sink; no backend delivery |
| `pi-video-gen` | Validate 100 timeline segments; hash a 4 MiB asset; atomically persist and read a 100-shot manifest | Real local files; no paid generation, TTS, or FFmpeg rendering |
| `pi-web-access` | Bound 100 search results and a 1 MiB fetched page | Recorded provider-shaped data; no search service or HTTP fetch |
| `shared` (support library) | Cold import; scan approximately 34 KB and 544 KB contexts; bound approximately 100 KB and 4 MB tool results; synchronous/asynchronous settings, eight concurrent reads, and 32 policy files | Real temporary configuration files |

The 66 metrics use the same workload definitions, input dimensions, and measurement code for both revisions. PNG fixtures contain incompressible noise and are generated outside the timed operations using the existing Sharp dependency. Temporary files are removed after each worker. Functional assertions check trust handling, output bounds, persisted facts, dispatch counts, span counts, redaction, and closure before accepting measurements.

## Session engineering suite

The additional 19 metrics exercise the real Pi runtime without calling a model or executing a business task:

| Area | Measurements and boundary |
| --- | --- |
| CLI startup | Start the installed Pi CLI in a child process and wait for a successful RPC `get_state` response, then close stdin and require a clean exit. Compare no extensions, Memory only, and a common combination of Memory, Attachments, Security, Goal, and Telemetry. No model is configured; MCP, discovery, skills, and prompt templates are disabled. This includes Node startup and runtime initialization, not interactive TUI readiness. |
| Per-prompt hooks | Real SDK sessions dispatch `input`, `before_agent_start`, `agent_start`, `turn_start`, context projection, `before_provider_request`, `message_end`, `turn_end`, `agent_end`, and `agent_settled` using static messages. Measure empty/Memory/common configurations with 1,000 messages, plus the common configuration with 10,000 messages. Memory prompt injection and retained context are checked. Extraction, dreaming, goal evaluation, and telemetry delivery are disabled. No provider request or tool execution occurs. |
| Concurrency | Four independent common-configuration sessions process hook pipelines on one event loop. Record median batch time and P95/P99 per-pipeline latency from 120 measured operations after warmup. This is cooperative concurrency, not parallel model throughput. |
| Cancellation and pressure | Cancel 32 pending Prefetch operations using a controlled in-memory provider; verify cancellation reaches all 32 and callers settle. Verify an uncancellable provider retains its single-flight slot until actual completion. Fill CaptureQueue with 16 accepted turns, reject overflow, release a controlled provider, and verify serialized drain and an empty saved outbox. No embedding or extraction service runs. |
| Resource growth | After 10 warmup cycles, create a real common-configuration SDK session, dispatch hooks, emit shutdown, and dispose it 500 times. Snapshot after 100/200/300/400/500 cycles, following settlement and forced GC. Compare maximum positive growth in heap, RSS, open file descriptors, active Node resources, and direct child processes. Save checkpoints and concurrency latencies in the raw artifact. Lifecycle timing excludes checkpoint collection. Leaked child processes fail immediately. |

The runtime and session suites provide 85 engineering metrics. The 500-cycle resource probe is a bounded durability check, not a long-running production soak test. RSS and other margins are provisional and do not guarantee the absence of existing baseline leaks.

## Enabled-extension profiles

The `profiles` suite adds 54 metrics: SDK startup, 1,000-message hook processing, and shutdown for each of the 17 extensions and for all extensions together. Module imports are preloaded in this suite; the runtime suite measures cold imports independently, while the session suite measures complete CLI RPC readiness.

Factories and lifecycle handlers run unchanged. A benchmark-only Node 24 load hook replaces external transport seams: browser/driver catalogs return fixed MCP schemas, CLI bridges report a fixed installed/authenticated state, Teamwork uses an injected CLI response, Channels uses an in-memory outgoing adapter, Mem0 uses an in-memory provider, and Telemetry uses the real OpenTelemetry pipeline with an in-memory sink. Fixtures contain explicit credentials, so the CLI bridges and Mem0 enter their configured branches. Tool registration and transport counters are checked; unsupported transport fixtures fail instead of silently becoming disabled-plugin measurements. No model, driver, browser, login, message delivery, embedding, or paid generation runs.

These are enabled local-extension measurements, not external-service or business-result validation. Goal model evaluation and Memory extraction/dreaming remain disabled; their real-model behavior belongs in Integration.

## Sustained resource load

A separate weekly job runs 60 minutes per revision; manual dispatch accepts `soak_minutes=60` or `120` (default `0`, which skips the long job). Baseline and candidate run sequentially on one runner, so the default long job lasts approximately two hours plus setup. It runs the common five-extension configuration with no external transports or model requests. PR jobs keep their bounded 500-cycle probe.

After 100 warmup cycles, the long worker continuously creates a session, processes static hook events, and shuts down, with a 100 ms duty-cycle pause. It snapshots heap, RSS, descriptors, active resources, and child processes every minute, persists those checkpoints incrementally to per-revision JSONL files (also uploaded if measurement fails), retaining at most the latest 256 cycle latencies for median/P95/P99 reporting. Reports compare maximum growth against each revision's warmed process. Child-process growth always fails. The long job uses one long-lived process per revision rather than seven short samples; its configured noise floors apply. Existing baseline memory growth can still exist and must be assessed from the checkpoints.

The `Performance checks` job provides a fixed aggregate status for the three PR suites; require this status in branch protection when adopting it as a merge gate. Repository protection settings are not changed by the workflow. Long soak results are separate from this PR aggregate.

## Run locally

Use Node 24, install dependencies, and run `pnpm build` in both checkouts, then:

```sh
node tests/performance/runtime.mjs --self-test
node tests/performance/runtime.mjs /path/to/baseline /path/to/candidate /tmp/pi-performance-runtime runtime
node tests/performance/runtime.mjs /path/to/baseline /path/to/candidate /tmp/pi-performance-sessions sessions
node tests/performance/runtime.mjs /path/to/baseline /path/to/candidate /tmp/pi-performance-profiles profiles
# Short validation of the long-run path: one minute per revision.
node tests/performance/runtime.mjs /path/to/baseline /path/to/candidate /tmp/pi-performance-soak soak 1
```

If local `tsup` builds have replaced the TypeScript outputs for the browser/computer packages, regenerate their module files with `pnpm exec tsc -b --force packages/pi-browser-use/tsconfig.json packages/pi-computer-use/tsconfig.json`. CI starts from fresh checkouts.

Normal suites alternate revisions across seven fresh worker processes per revision and compare medians. Together they provide 139 engineering metrics, plus eight separately reported sustained-load metrics. Each runtime worker additionally starts one fresh import process per extension to prevent shared module-cache contamination. A metric fails above `baseline × 1.30 + max(configured margin, 3 × baseline MAD)`; MAD is the median absolute deviation of the seven baseline measurements; candidate variability never increases the allowance. The report and JSON expose the configured floor, baseline MAD, and effective allowance so runner noise can be reviewed. The long job has one process per revision and therefore uses its configured floor. Exit code 1 indicates a regression or a failed correctness assertion. Reports and raw samples are saved as `report.md` and `results.json`, and uploaded by CI even when a measured regression fails the job.

These initial margins need calibration on hosted runners. File I/O uses warm filesystem caches. Concurrent memory timing includes lock contention, readback, and cleanup. Retained heap measures growth after 100 exporter lifecycle cycles, following warmup and forced GC; it is a short regression probe, not proof of absence of leaks. Coverage of a package means only the listed local paths: these tests exclude external-service latency, desktop/browser automation, model tasks, and sustained production load.
