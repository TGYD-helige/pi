# @amaster.ai/pi-telemetry

![pi-telemetry preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-telemetry/preview.png)

Runtime telemetry contracts and exporters for pi.

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
| `agent_end` | Complete the root or subagent span once per user prompt |
| `tool_execution_start` | Begin tool span |
| `tool_execution_end` | End tool span with result |
| `message_end` | Complete an LLM generation span with output and usage |
| `model_select` | Record model switch events |
| `session_compact` | Record context compaction events |
| `session_shutdown` | Flush and shutdown exporters |

### Trace lifecycle

Traces are scoped to user input boundaries (not individual turns). A single user message may trigger multiple LLM turns and tool calls — all grouped under one trace and completed once on `agent_end`.

Langfuse traces carry the configured `serviceName` as resource/metadata attributes and `langfuse.session.id` on every span so shared projects can filter traces by runtime and session. The extension also adds `taskRunId` correlation metadata when `PI_TELEMETRY_TASK_RUN_ID` is present.

## Configuration

Configuration is read from the `"pi-telemetry"` section of, in increasing priority, `~/.pi/agent/settings.json`, the configured agent directory's `settings.json` (for example `$PI_CODING_AGENT_DIR/settings.json`), and a trusted project's `.pi/settings.json`. Project settings are ignored when project trust is declined. Environment variables are expanded only in user and agent-directory settings.

```json
{
  "pi-telemetry": {
    "serviceName": "my-service",
    "serviceVersion": "1.0.0",
    "includePayloads": true,
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
| `includePayloads` | `boolean` | `false` | Include chat payloads, tool args, LLM I/O |

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
