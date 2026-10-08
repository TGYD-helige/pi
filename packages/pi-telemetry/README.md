# @amaster.ai/pi-telemetry

![pi-telemetry preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-telemetry/preview-observability.png)

Runtime traces, first-token latency, token and cost accounting, and diagnostics for Pi. Langfuse and generic OpenTelemetry export share one private provider.

Uses the official Langfuse JS v5 and OpenTelemetry SDKs. Langfuse export runs through `@langfuse/tracing` and `@langfuse/otel`; generic OTLP export uses `OTLPTraceExporter`. Requests time out after 15 seconds and lifecycle flushes are capped at 30 seconds.

## Entry Points

- `@amaster.ai/pi-telemetry`: stable contracts, `NoopRuntimeEventExporter`, and `CompositeRuntimeEventExporter`.
- `@amaster.ai/pi-telemetry/config`: `TelemetryConfig` type, `resolveConfig`, and `loadConfigFromFile`.
- `@amaster.ai/pi-telemetry/langfuse`: Langfuse JS v5 exporter using `@langfuse/tracing` and `@langfuse/otel`.
- `@amaster.ai/pi-telemetry/otel`: generic OTLP/HTTP traces exporter.

## Events

The extension hooks into the following Pi lifecycle events:

| Event | Telemetry action |
|-------|-----------------|
| `session_start` | Initialize exporters from config |
| `input` | Start a new trace (traceId boundary = user input) |
| `turn_start` | Begin the root or subagent span on the first turn |
| `before_provider_request` | Begin an LLM generation span and record model input |
| `after_provider_response` | Mark failed provider responses |
| `message_update` | Record provider stream events beneath the active LLM generation |
| `agent_end` | Store the latest result; complete immediately on legacy Pi |
| `agent_before_settle` | Record the final run outcome when available |
| `agent_settled` | Complete the root or subagent span and flush after retries and queued continuations finish |
| `tool_execution_start` | Begin tool span |
| `tool_execution_end` | End tool span with result |
| `message_end` | Complete an LLM generation span with output and usage |
| `model_select` | Record model switch events |
| `tool_result` | Record reported tool-internal LLM usage under its tool span |
| `session_before_compact` / `session_compact` | Record compaction duration, summary and reported token/cost usage |
| `session_before_tree` / `session_tree` | Record branch-summary duration and reported usage |
| `session_shutdown` | End any spans still open (marked `terminatedBy: session_shutdown`), then flush and shutdown exporters |

### Trace lifecycle

Traces are scoped to new user prompt boundaries. Steering and follow-ups queued during streaming remain in the running trace as input observations until settlement. A single user message may trigger multiple model requests, retries and tool calls, grouped under one trace. Pi 0.84.2 and later finish the trace on `agent_settled`; earlier peers retain `agent_end`. Errors, cancellation and superseded requests are recorded explicitly.

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
| `release` | `string` | — | Langfuse release label; independent of OTEL serviceVersion |

### Langfuse Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable Langfuse exporter |
| `publicKey` | `string` | — | Langfuse public API key |
| `secretKey` | `string` | — | Langfuse secret API key |
| `baseUrl` | `string` | `"https://cloud.langfuse.com"` | Langfuse server URL |
| `flushAt` | `number` | `20` | Batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |

### OTEL Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OTEL exporter |
| `endpoint` | `string` | — | OTLP traces endpoint |
| `headers` | `Record<string, string>` | — | Request headers |
| `flushAt` | `number` | `20` | Batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |

When the endpoint does not end with `/v1/traces`, the exporter appends `/v1/traces`.

## Programmatic Usage

```ts
import { loadConfigFromFile, resolveConfig } from "@amaster.ai/pi-telemetry/config";
import { createTelemetryExporter } from "@amaster.ai/pi-telemetry/otel";

const config = resolveConfig(loadConfigFromFile());
const telemetry = createTelemetryExporter(config); // one provider for both destinations
```

## Privacy

Runtime events omit user prompts, assistant responses, tool arguments, tool outputs, and model inputs/outputs by default. Error messages are always exported. Set `includePayloads: true` to include payloads. For finer control, construct an exporter directly and pass `redactEvent`.


## Observation details

Generation input/output use readable conversation roles, structured thinking blocks and tool calls when available. On runtimes with `context_with_system`, input includes the full system transcript, named sections and tool additions. Tool removals appear as `[Tools removed: name, ...]` annotations on the corresponding system message in the display transcript; these annotations are not sent to the provider. Older runtimes use the system prompt getter and active tool registry. The captured provider request and original output remain separate in observation metadata (`rawInput` / `rawOutput`), rather than adding display fields to the provider request. Context and supported model parameters are captured at the extension hook; later extensions can still alter a request. Response model, requested model, API, response ID and stop reason are recorded separately. Tool executions use Langfuse's `TOOL` observation type. The instrumentation scope records the installed package version.

TTFT starts at `before_provider_request` and ends at the first nonempty text, thinking or tool-call content, rather than the initial stream-start event. Generations carry Langfuse's standard completion-start timestamp even when payload export is disabled.

Cache read/write usage and costs use Langfuse's standard input buckets. Reported reasoning is a subset of output and is split without increasing the total; invalid reasoning splits fall back to combined output. Reasoning cost is a proportional split of reported output cost, marked `proportional-output-cost`. One-hour cache writes remain subset metadata, not an additional token/cost bucket. No missing usage is estimated.

All-zero SDK costs from a model without positive pricing are marked `costSource: "unknown"` and omitted from Langfuse cost details, allowing backend model-price inference. A matching Langfuse model definition is still required for inference. Explicit event or hook costs, including zero, are preserved; producers can set `usage.costSource: "provided"` for a known free request. Costs calculated using configured positive model rates are marked `model-pricing`.

Compaction and branch summaries are generations in the active trace or standalone traces grouped by session when idle. Their model attribution is explicitly `session-config`, since summary entries do not report the served model. Tool-internal usage is nested beneath its tool; its model is `unknown` because a tool need not use the session model. Plain branch navigation without a summary does not create a generation.

## Commands and status

- `/telemetry status` (or `/telemetry`): show exporter state and session ID without exposing credentials.
- `/telemetry flush`: flush pending finished spans and report export errors/timeouts. This does not end active spans or confirm backend ingestion.

The TUI status indicates readiness, disabled export, missing credentials/endpoint, flush completion, or export failure. Configuration warnings remain visible when the other destination is active. Export callbacks track failures separately for Langfuse and generic OTLP; one destination succeeding does not hide the other's failure. Status refreshes at session startup, settlement and explicit commands.

## Images and credential masking

Images require both payload and media switches. Prompt and tool images use validated inline image data supported by the Langfuse SDK; conversation history uses image markers. Disabled, invalid or oversized image binaries are replaced with markers, including binaries embedded in provider requests. Inline media is capped at 600 KB of base64 per content value and 750 KB per event; larger inputs retain an explicit omitted-image marker. Oversized attribute truncation removes media before generating a preview to prevent partial image uploads. Generic OTLP may contain opted-in inline media; its collector does not perform Langfuse media uploads.

All configured Langfuse credentials and sensitive OTLP header values, including those for disabled destinations, and Langfuse key patterns are masked before either destination, including error messages and raw request metadata. This is credential masking, not general PII removal. The default remains no conversation/tool payload export, and `redactEvent` remains available for application-specific policies.
