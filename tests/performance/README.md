# Offline runtime performance

The independent `Performance` workflow runs on pull requests and pushes to `master`/`main`, and supports manual dispatch. Pull requests compare against the PR base commit; pushes compare against the previous branch head; manual runs compare against the selected commit's first parent. No model credentials or external services are required.

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

## Run locally

Use Node 24, install dependencies, and run `pnpm build` in both checkouts, then:

```sh
node tests/performance/runtime.mjs --self-test
node tests/performance/runtime.mjs /path/to/baseline /path/to/candidate /tmp/pi-performance-results
```

If local `tsup` builds have replaced the TypeScript outputs for the browser/computer packages, regenerate their module files with `pnpm exec tsc -b --force packages/pi-browser-use/tsconfig.json packages/pi-computer-use/tsconfig.json`. CI starts from fresh checkouts.

The runner alternates revisions across seven fresh worker processes per revision and compares medians. Each worker additionally starts one fresh import process per extension to prevent shared module-cache contamination. A metric fails above `baseline × 1.30 + noise margin`; each margin appears in the report. Exit code 1 indicates a regression or a failed correctness assertion. Reports and raw samples are saved as `report.md` and `results.json`, and uploaded by CI even when a measured regression fails the job.

These initial margins need calibration on hosted runners. File I/O uses warm filesystem caches. Concurrent memory timing includes lock contention, readback, and cleanup. Retained heap measures growth after 100 exporter lifecycle cycles, following warmup and forced GC; it is a short regression probe, not proof of absence of leaks. Coverage of a package means only the listed local paths: the suite does not measure a complete Pi CLI launch, external-service latency, desktop/browser automation, or sustained production load.
