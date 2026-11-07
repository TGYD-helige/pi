# @amaster.ai/pi-telemetry

![pi-telemetry preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-telemetry/preview-observability.png)

Runtime traces, first-token latency, token and cost accounting, and diagnostics for Pi. Langfuse, Arize Phoenix, and generic OpenTelemetry export share one private provider.

Uses the official Langfuse JS v5 and OpenTelemetry SDKs. Langfuse export runs through `@langfuse/tracing` and `@langfuse/otel`; generic OTLP export uses the JSON `OTLPTraceExporter`. Phoenix uses the matching protobuf exporter because its direct `/v1/traces` endpoint does not accept OTLP/JSON. Requests time out after 15 seconds and lifecycle flushes are capped at 30 seconds.

## Entry Points

- `@amaster.ai/pi-telemetry`: stable contracts, `NoopRuntimeEventExporter`, and `CompositeRuntimeEventExporter`.
- `@amaster.ai/pi-telemetry/config`: `TelemetryConfig` type, `resolveConfig`, and `loadConfigFromFile`.
- `@amaster.ai/pi-telemetry/langfuse`: Langfuse JS v5 exporter using `@langfuse/tracing` and `@langfuse/otel`.
- `@amaster.ai/pi-telemetry/otel`: generic OTLP/HTTP and Phoenix exporters, plus the combined telemetry factory.

## Events

The extension hooks into the following Pi lifecycle events:

| Event | Telemetry action |
|-------|-----------------|
| `session_start` | Initialize exporters from config |
| `input` | Start a new trace (traceId boundary = user input) |
| `turn_start` | Begin the root or subagent span on the first turn |
| `before_provider_request` | Begin an LLM generation span and record model input |
| `after_provider_response` | Mark failed provider responses |
| `provider_stream_event` / `message_update` | Record raw provider frames when supported, falling back to normalized stream events beneath the active LLM generation |
| `agent_end` | Store the latest result; complete immediately on legacy Pi |
| `agent_before_settle` | Record the final run outcome when available |
| `agent_settled` | Complete the root or subagent span and schedule one background flush after retries and queued continuations finish; record cancellation from `aborted` when available |
| `tool_execution_start` | Begin tool span |
| `tool_execution_end` | End tool span with result and native execution `durationMs` when available (Pi 1.1+) |
| `message_end` | Complete an LLM generation span with output and usage |
| `model_select` | Record model switch events |
| `tool_result` | Record reported tool-internal LLM usage under its tool span |
| `session_before_compact` / `session_compact` / `session_compact_failed` | Record compaction duration, summary, failure/cancellation and reported token/cost usage |
| `session_before_tree` / `session_tree` | Record branch-summary duration and reported usage |
| `session_shutdown` | End any spans still open (marked `terminatedBy: session_shutdown`), then flush and shutdown exporters |

### Trace lifecycle

Traces are scoped to new user prompt boundaries. Steering and follow-ups queued during streaming remain in the running trace as input observations until settlement. A single user message may trigger multiple model requests, retries and tool calls, grouped under one trace. Pi 0.84.2 and later finish the trace on `agent_settled`; earlier peers retain `agent_end`. Errors, cancellation and superseded requests are recorded explicitly.

Settlement schedules at most one background flush and returns without waiting for a slow or unreachable backend. Later spans are covered by the next settlement or final close. `session_shutdown` waits for the pending flush before closing the exporter, so delivery is not abandoned, while `/telemetry flush` remains the explicit way to wait for and inspect a flush. Status refreshes when a background flush completes, but only if the exporter and session are still current, so an older session cannot overwrite a newer session's status.

Root session IDs come from Pi session storage, so resumed sessions retain their identity and new/forked sessions use their own IDs. Prompt numbering resumes from persisted user messages. Child processes retain the inherited root session and trace while using their local Pi session ID for observations. Correlation environment variables are restored at settlement and shutdown.

Langfuse traces carry the configured `serviceName` as resource/metadata attributes and `langfuse.session.id` on every span so shared projects can filter traces by runtime and session. The extension also adds `taskRunId` correlation metadata when `PI_TELEMETRY_TASK_RUN_ID` is present.

## Configuration

Configuration is read from the `"pi-telemetry"` section of, in increasing priority, `~/.pi/agent/settings.json`, the configured agent directory's `settings.json` (for example `$PI_CODING_AGENT_DIR/settings.json`), and a trusted project's `.pi/settings.json`. Project settings are ignored when project trust is declined. Environment variables are expanded only in user and agent-directory settings.

```json
{
  "pi-telemetry": {
    "serviceName": "my-service",
    "serviceVersion": "1.0.0",
    "includePayloads": true,
    "mediaUploadEnabled": false,
    "userId": "developer-id",
    "environment": "development",
    "release": "my-app-v1",
    "langfuse": {
      "enabled": true,
      "publicKey": "pk-lf-...",
      "secretKey": "sk-lf-...",
      "baseUrl": "https://cloud.langfuse.com",
      "flushAt": 20,
      "flushIntervalMs": 5000
    },
    "otel": {
      "enabled": true,
      "endpoint": "https://otel-collector.example.com",
      "headers": { "Authorization": "Bearer ..." },
      "flushAt": 20,
      "flushIntervalMs": 5000
    },
    "phoenix": {
      "enabled": true,
      "endpoint": "http://localhost:6006",
      "apiKey": "${PHOENIX_API_KEY}",
      "projectName": "pi-agent",
      "flushAt": 20,
      "flushIntervalMs": 5000
    }
  }
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serviceName` | `string` | `"pi-server"` | Service name for traces |
| `serviceVersion` | `string` | — | Service version for traces |
| `includePayloads` | `boolean` | `false` | Include chat payloads, tool args and model I/O |
| `mediaUploadEnabled` | `boolean` | `false` | Upload prompt/tool images to Langfuse; also requires `includePayloads: true` |
| `userId` | `string` | — | Standard trace user identifier |
| `environment` | `string` | — | Langfuse environment label, e.g. `development` or `production` |
| `release` | `string` | — | Release label; independent of OTEL serviceVersion |
| `tags` | `string[]` | `[]` | Additional trace tags in Langfuse and Phoenix; up to 32 unique trimmed entries of 128 characters, examining the first 256 candidates (strings over 4096 characters are ignored) |
| `traceName` | `string` | `"chat-turn"` | Langfuse trace and Phoenix root display name, bounded to 90 characters |
| `redactFields` | `string[]` | `[]` | Case-insensitive field names to mask in captured payloads, JSON-encoded payloads and custom metadata; same list limits as tags |

### Langfuse Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable Langfuse exporter |
| `publicKey` | `string` | — | Langfuse public API key |
| `secretKey` | `string` | — | Langfuse secret API key |
| `baseUrl` | `string` | `"https://cloud.langfuse.com"` | Langfuse server URL |
| `flushAt` | `number` | `20` | Batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |

Boolean settings also accept environment-interpolated `true`, `TRUE`, `1`, and `yes`; other strings are false. Langfuse credentials and URLs are trimmed. Missing or blank credentials disable export. Omitting `baseUrl` uses the default; an explicitly blank value disables Langfuse export. Media upload still requires both payload inclusion and media upload to be enabled.

### OTEL Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OTEL exporter |
| `endpoint` | `string` | — | OTLP traces endpoint |
| `headers` | `Record<string, string>` | — | Request headers |
| `flushAt` | `number` | `20` | Batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |

When the endpoint does not end with `/v1/traces`, the exporter appends `/v1/traces`.

### Phoenix Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable Phoenix/OpenInference export |
| `endpoint` | `string` | `"http://localhost:6006"` | Self-hosted, Cloud, or full OTLP traces URL |
| `apiKey` | `string` | — | Phoenix API key, sent as `Authorization: Bearer ...` |
| `projectName` | `string` | Phoenix server default | Phoenix project, set only on Phoenix's `openinference.project.name` resource attribute |
| `flushAt` | `number` | `20` | Phoenix batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Phoenix flush interval in ms |

`projectName` is optional. You may also set `PHOENIX_PROJECT_NAME` in the process environment. The settings value takes precedence over the environment variable; if neither is set, the Phoenix server selects its default project. The Integration workflow supplies the variable instead of creating per-run projects.

For unauthenticated self-hosted Phoenix, use `endpoint: "http://localhost:6006"` and omit `apiKey`. For Phoenix Cloud or an authenticated server, set `apiKey` in user or agent-directory settings with `"${PHOENIX_API_KEY}"` interpolation and use the supplied space URL, for example `https://app.phoenix.arize.com/s/<space>`. A base URL or a full `/v1/traces` URL is accepted; trailing slashes are normalized and path prefixes are preserved without appending the suffix twice. Do not put API keys in trusted project settings: project settings do not expand environment variables.

Phoenix generations expose structured messages, thinking, tool calls and results, tool definitions, invocation parameters, and opted-in image URLs alongside Raw I/O. Environment, release, correlation and cost provenance appear in Metadata; trace tags use OpenInference tags. Additional message/tool attributes are capped at 512 attributes and 250 KB per span. At most 100 messages, parts or tool definitions are projected, favoring output and newest input; `pi.telemetry.projection.truncated` indicates a projection limit. Raw I/O retains its own limits.

The Phoenix adapter projects the same finished spans to OpenInference `AGENT`, `CHAIN`, `LLM`, and `TOOL` kinds. It preserves trace/span IDs and timing, maps the root session to `session.id`, bare model identity and provider, tool name/call ID, and reported token details. Prompt tokens include reported cache read/write tokens; reasoning remains a completion detail rather than being counted twice. Payloads and their MIME types appear only with `includePayloads: true`. Phoenix-specific resource and span attributes are cloned before export, so simultaneous Langfuse and generic OTLP projections remain unchanged and retain matching IDs.

Known Pi cost components are exported as OpenInference cost attributes without inventing a reasoning-cost split. Phoenix normally calculates displayed cost during ingestion from its own model/provider price table, so unknown models require Phoenix custom pricing and displayed cost can differ from the reported amount. Metadata preserves `reportedCost` separately from Phoenix-calculated prices, alongside `costSource`; inspect it when Phoenix displays a different amount. A displayed `$0` with `costSource: "unknown"` does not establish that the request was free. A reported first-content timestamp is preserved as a `first_token` span event and numeric `llm.time_to_first_token_ms` / `llm.time_to_first_token_seconds` diagnostics. These numeric attributes do not promise a dedicated Phoenix TTFT chart.

Use `phoenix`, not `otel`, for a direct Phoenix endpoint: Phoenix receives gzip-compressed protobuf batches, while generic OTLP intentionally retains its existing JSON wire format. An external collector that translates OTLP/JSON can still receive generic OTLP and forward it to Phoenix.

### Live Phoenix verification

The opt-in integration test exports and queries real prompt → LLM → tool → LLM traces with payloads enabled and disabled. It is skipped during normal unit test runs. From the repository root, start Phoenix in one terminal:

```sh
docker run --rm -e PHOENIX_ENABLE_AUTH=false -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest
```

Then run the integration test in another terminal:

```sh
PHOENIX_TEST_ENDPOINT=http://localhost:6006 pnpm vitest run tests/telemetry-phoenix.test.ts
```

For an authenticated server, also set `PHOENIX_TEST_API_KEY` in the test environment. The test uses unique trace IDs and checks stored hierarchy, project/session grouping, model, token/cost attributes, errors, TTFT events, and payload suppression through Phoenix's spans API. It only sets `projectName` when `PHOENIX_PROJECT_NAME` is explicitly provided. Unauthenticated local Phoenix uses its `default` project unless `PHOENIX_PROJECT_NAME` selects another existing project.

The GitHub Actions `Integration` workflow also exports every Stage B/Stage C run that loads `pi-telemetry` to both Langfuse and Phoenix. The dedicated browser-session model harness is an explicit exception because it disables other extensions and telemetry to isolate browser state. The `pi-telemetry` basic, hierarchy, and redacted scenarios verify the same real prompt against both backends without a second model call. Phoenix export and verification use `PHOENIX_PROJECT_NAME` to select an existing project, with `github-pi` as the default and an optional repository-variable override. Each run is filtered by its unique codeworded trace ID; no per-run or per-job projects are created. `PHOENIX_API_KEY` and `PHOENIX_COLLECTOR_ENDPOINT` remain required Actions secrets, and missing credentials fail the affected E2E step instead of silently skipping export.

## Programmatic Usage

```ts
import { loadConfigFromFile, resolveConfig } from "@amaster.ai/pi-telemetry/config";
import { createPhoenixExporter, createTelemetryExporter } from "@amaster.ai/pi-telemetry/otel";

const config = resolveConfig(loadConfigFromFile());
const telemetry = createTelemetryExporter(config); // one provider for all configured destinations
const phoenixOnly = createPhoenixExporter(config);
```

## Privacy

Runtime events omit user prompts, assistant responses, tool arguments, tool outputs, and model inputs/outputs by default. Error messages are always exported. Set `includePayloads: true` to include payloads. For finer control, construct an exporter directly and pass `redactEvent`.


## Observation details

Generation input/output use readable conversation roles, structured thinking blocks and tool calls when available. Display tool definitions are flattened to Langfuse ChatML `name`/`parameters` form across Chat Completions, Responses, Anthropic and Gemini; original provider schemas remain in raw request inspection. Generation input is derived from the provider request captured at `before_provider_request`, preserving system/developer roles, message ordering and tool declarations for Chat Completions, Anthropic, Responses and Gemini payloads. Unrecognized payload formats fall back to the captured `context_with_system` transcript, or the system prompt getter and active tool registry on older runtimes. Each child `llm-stream` pairs the original provider request in its Input with captured streaming events in its Output, including empty streams for attempts that fail before any frames arrive. The original request also remains in generation metadata as `rawInput` for compatibility and convenient inspection alongside the readable input; this intentionally duplicates the request when payload export is enabled. The original assembled output remains in `rawOutput`. Payload suppression, credential masking and application redaction apply to both observations. Later extensions can still alter a request after the telemetry hook. Response model, requested model, API, response ID and stop reason are recorded separately. Tool executions use Langfuse's `TOOL` observation type. The instrumentation scope records the installed package version.

With `includePayloads: true`, each generation's Metadata contains `requestHeaders` and `responseHeaders` from Pi's `before_provider_headers` and `after_provider_response` events, including HTTP failure responses. Header names containing auth, cookie, key, token, secret, password, credential or signature are masked; configured credential masking, field redaction and `redactEvent` also apply. Capture retains at most 64 headers and 16 KB per direction, with values limited to 2048 characters and explicit omission/truncation markers. These are snapshots of the runtime-provided headers: later extensions or the HTTP SDK may add or change headers after the hook. Older runtimes without these events omit these fields. No request headers are modified.

TTFT starts at `before_provider_request` and ends at the first nonempty text, thinking or tool-call content, rather than the initial stream-start event. Generations carry Langfuse's standard completion-start timestamp even when payload export is disabled.

Cache read/write usage and costs use Langfuse's standard input buckets. Reported reasoning is a subset of output and is split without increasing the total; invalid reasoning splits fall back to combined output. Reasoning cost is a proportional split of reported output cost, marked `proportional-output-cost`. One-hour cache writes remain subset metadata, not an additional token/cost bucket. No missing usage is estimated.

All-zero SDK costs from a model without positive pricing are marked `costSource: "unknown"` and omitted from Langfuse cost details, allowing backend model-price inference. A matching Langfuse model definition is still required for inference. Explicit event or hook costs, including zero, are preserved; producers can set `usage.costSource: "provided"` for a known free request. Costs calculated using configured positive model rates are marked `model-pricing`.

Auxiliary generation names keep their purpose and a session ordinal capped at 999999; producer labels are bounded to 40 characters and preserved across start/end events. Compaction and branch summaries are generations in the active trace or standalone traces grouped by session when idle. Their served model is explicitly `unknown`, since summary entries do not report it; `modelAttribution: unreported` and optional `sessionModel` identify this limit. Tool-internal usage is nested beneath its tool, also with an unknown model. `timingAttribution: operation` means the span covers an enclosing operation, while `usage-report` means only the report time was observed. Plain branch navigation without a summary does not create a generation.

## Commands and status

- `/telemetry status` (or `/telemetry`): show exporter state and session ID without exposing credentials.
- `/telemetry flush`: flush pending finished spans and report export errors/timeouts. This does not end active spans or confirm backend ingestion.

The TUI status indicates readiness, disabled export, missing credentials/endpoint, flush completion, or export failure. Configuration warnings remain visible when another destination is active. Export callbacks track failures separately for Langfuse, generic OTLP, and Phoenix; one destination succeeding does not hide another's failure. OTLP partial-success responses with `rejectedSpans > 0` also mark that destination as an error and are not retried as a whole batch, avoiding duplicate spans; decimal-string int64 values used by OTLP/JSON are recognized without numeric conversion. A later complete success clears the error. Status refreshes at session startup, settlement and explicit commands. Prompt completion does not wait for backend flushing. Session shutdown waits for pending telemetry exports.

## Images and credential masking

Images require both payload and media switches. Prompt and tool images use validated inline image data supported by the Langfuse SDK; conversation history uses image markers. Disabled, invalid or oversized image binaries are replaced with markers, including binaries embedded in provider requests. Inline media is capped at 600 KB of base64 per content value and 750 KB per event; larger inputs retain an explicit omitted-image marker. Oversized attribute truncation removes media before generating a preview to prevent partial image uploads. Generic OTLP may contain opted-in inline media; its collector does not perform Langfuse media uploads.

All configured Langfuse credentials, Phoenix API keys, and sensitive OTLP header values, including those for disabled destinations, and Langfuse key patterns are masked before every destination, including error messages and raw stream inputs. This is credential masking, not general PII removal. The default remains no conversation/tool payload export, and `redactEvent` remains available for application-specific policies.

When export is disabled, event handlers skip telemetry processing. Disabled startup also skips runtime loading and history scans. With `includePayloads: false`, each generation retains an empty `llm-stream` child for timing and hierarchy, while the extension skips context projection and model/tool payload capture while preserving usage, errors, model attribution, and first-token timing. Stream capture bounds each frame during traversal by the remaining 1 MB budget, 10,000 values and 32 nesting levels, then stops converting subsequent frames once truncated. Markers and array formatting count toward the capture budget.

## Context and auxiliary calls for extension authors

Emit `pi-telemetry:request-context` on `pi.events` before the next prompt to supply a `TelemetryRequestContext`: optional `userId`, `traceName`, `tags`, `metadata`, and a W3C `traceparent`. Context is consumed once at a new prompt boundary; steering and follow-ups keep the active context. Programmatic exporters expose `setContext(context)` for the same values. Metadata should contain explicit correlation facts rather than conversation content. Custom metadata requires `includePayloads: true` and passes through `redactEvent` as `event.contextMetadata` before export; `userId`, `tags` and `traceName` remain available without payload capture. Custom metadata retains at most 31 entries plus an omission marker within a 60 KB value budget; oversized values are explicitly omitted. Invalid traceparents fall back to a local root. Payload opt-in and credential masking remain in force.

```ts
pi.events.emit('pi-telemetry:request-context', {
  userId: 'operator-1',
  tags: ['batch'],
  metadata: { jobId: 'job-42' },
});
```

A child Pi process automatically inherits the unique active tool as its parent. When multiple tools are active, it falls back to the agent parent rather than guessing. For exact concurrent attribution, ask for the executing tool's context and merge the returned telemetry-only environment overrides into that specific child launch:

```ts
let telemetryEnv: Record<string, string> = {};
pi.events.emit('pi-telemetry:tool-context', {
  toolCallId,
  respond: (env: Record<string, string> | undefined) => { telemetryEnv = env ?? {}; },
});
// Pass { ...process.env, ...telemetryEnv } as the child process environment.
```

Programmatic exporters expose `getToolContext(sessionId, toolCallId)` for the same purpose. Completed or unknown tools return `undefined`. Existing launcher correlation variables are retained; do not share one launch's overrides with another concurrent launch. Nested runtime tools also preserve a reported `parentToolCallId`.

Extensions that perform their own model calls can emit `pi-telemetry:llm` using the exported `TelemetryAuxiliaryEvent` type. Emit `started`, then `completed` or `failed` with the same `llmGenerationId`, actual `model`, timestamps, `source` (`compaction`, `branch_summary`, or `tool`) and any reported request/response, usage, first-content timestamp and error. For tool calls, include `parentToolCallId`. Source attribution is marked `producer`; events are linked to the active trace or a shared standalone trace for that generation. Keep IDs unique per call. The event belongs inside the corresponding compaction, branch-summary or tool lifecycle; observed calls suppress that operation's reconstructed usage generation, so emit all calls rather than just a subset. The bridge does not intercept uninstrumented third-party model clients.

Field redaction applies to captured payload fields and explicitly supplied custom metadata, not runtime routing IDs. It also masks valid JSON embedded in strings. Invalid JSON and ordinary prose receive credential masking only; field-name redaction is not general PII detection. Oversized JSON requiring field redaction is replaced with an omission marker. Conversation display retains the newest messages within 500 KB / 100 messages before generic attribute truncation; omitted history is explicitly marked. Complete protocol input may itself be truncated at the existing attribute limit.
