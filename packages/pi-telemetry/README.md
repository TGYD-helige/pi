# @amaster.ai/pi-telemetry

![pi-telemetry preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-telemetry/preview.png)

Runtime telemetry contracts and exporters for pi.

The root package exposes stable exporter contracts plus no-op and composite exporters. Provider-specific implementations live behind explicit subpath entry points so applications can depend on the smallest public surface they need.

## Entry Points

- `@amaster.ai/pi-telemetry`: stable contracts, `NoopRuntimeEventExporter`, and `CompositeRuntimeEventExporter`.
- `@amaster.ai/pi-telemetry/config`: `TelemetryConfig` type, `resolveConfig`, and `loadConfigFromFile`.
- `@amaster.ai/pi-telemetry/langfuse`: Langfuse SDK exporter.
- `@amaster.ai/pi-telemetry/otel`: generic OTLP/HTTP traces exporter.

## Events

The extension hooks into the following Pi lifecycle events:

| Event | Telemetry action |
|-------|-----------------|
| `session_start` | Initialize exporters from config |
| `input` | Start a new trace (traceId boundary = user input) |
| `turn_start` | Begin a generation span |
| `before_provider_request` | Record model input |
| `after_provider_response` | Record model output, usage, latency |
| `turn_end` | End generation span |
| `tool_execution_start` | Begin tool span |
| `tool_execution_end` | End tool span with result |
| `message_end` | Publish accumulated trace to exporters |
| `model_select` | Record model switch events |
| `session_compact` | Record context compaction events |
| `session_shutdown` | Flush and shutdown exporters |

### Trace lifecycle

Traces are scoped to user input boundaries (not individual turns). A single user message may trigger multiple LLM turns and tool calls — all grouped under one trace. The trace is published on `message_end`.

Langfuse traces include the configured `serviceName` as both a tag and metadata so shared projects can filter traces by runtime. The extension also adds `taskRunId` correlation metadata when `PI_TELEMETRY_TASK_RUN_ID` is present.

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
| `errorLabel` | `string` | — | Custom label for error messages |

When the endpoint does not end with `/v1/traces`, the exporter appends `/v1/traces`.

## Programmatic Usage

```ts
import { loadConfigFromFile, resolveConfig } from "@amaster.ai/pi-telemetry/config";
import { createLangfuseExporter } from "@amaster.ai/pi-telemetry/langfuse";
import { createOtelExporter } from "@amaster.ai/pi-telemetry/otel";

const config = resolveConfig(loadConfigFromFile());
const langfuse = createLangfuseExporter(config);
const otel = createOtelExporter(config);
```

## Privacy

Runtime events omit user prompts, assistant responses, tool arguments, tool outputs, and model inputs/outputs by default. Set `includePayloads: true` to include them. For finer control, construct an exporter directly and pass `redactEvent`.
