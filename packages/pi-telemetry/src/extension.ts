import { randomUUID } from 'node:crypto';
import type {
  JsonObject,
  JsonValue,
  RuntimeLlmUsage,
  RuntimeModelConfig,
} from '@amaster.ai/pi-shared';
import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfigFromFile, resolveConfig } from './config.js';
import { NoopRuntimeEventExporter } from './exporters.js';
import type { RuntimeEventExporter } from './index.js';
import { createTelemetryExporter } from './otel.js';

const MAX_STREAM_CAPTURE_BYTES = 1_000_000;

function modelConfigFromCtx(ctx: ExtensionContext): RuntimeModelConfig {
  const model = ctx.model;
  if (!model) {
    return { provider: 'unknown', model: 'unknown' };
  }
  return {
    provider: (model.provider as string) ?? 'unknown',
    model: model.id ?? model.name ?? 'unknown',
  };
}

function extractOutput(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return undefined;
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return undefined;
  const texts: string[] = [];
  for (const block of msg.content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block
    ) {
      texts.push(String(block.text));
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function extractLastOutput(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const output = extractOutput(messages[index]);
    if (output !== undefined) return output;
  }
  return undefined;
}

function simplifyContent(content: unknown): JsonValue | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return content as JsonValue | undefined;
  const allText = content.every(
    (b: unknown) =>
      b && typeof b === 'object' && 'type' in b && (b as Record<string, unknown>).type === 'text',
  );
  if (allText) {
    const texts = content.map((b: unknown) => String((b as Record<string, unknown>).text));
    return texts.join('\n');
  }
  return content as JsonValue;
}

function toolEventDetails(result: unknown): JsonObject | undefined {
  const rawDetails =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).details
      : undefined;
  const details = sanitizeToolDetails(rawDetails);
  const output = summarizeToolResultOutput(result, rawDetails);
  if (output !== undefined && details.output === undefined) {
    details.output = output;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function sanitizeToolDetails(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const sanitized: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'fullOutput' || key === 'fullOutputMimeType') {
      continue;
    }
    sanitized[key] = toTelemetryValue(raw);
  }
  return sanitized;
}

function summarizeToolResultOutput(result: unknown, details: unknown): JsonValue | undefined {
  if (result === undefined || shouldSuppressToolOutput(details)) {
    return undefined;
  }
  if (typeof result === 'string') {
    return result;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return toTelemetryValue(result);
  }
  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.output !== undefined) {
    return toTelemetryValue(resultRecord.output);
  }
  const text = textContentFromToolResult(resultRecord);
  if (text) {
    return text;
  }
  return resultRecord.content !== undefined ? toTelemetryValue(resultRecord.content) : undefined;
}

function textContentFromToolResult(result: Record<string, unknown>): string | undefined {
  if (!Array.isArray(result.content)) {
    return undefined;
  }
  const text = result.content
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const record = item as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : undefined;
    })
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function shouldSuppressToolOutput(details: unknown): boolean {
  return Boolean(
    details &&
      typeof details === 'object' &&
      !Array.isArray(details) &&
      (details as Record<string, unknown>).outputSuppressed === true,
  );
}

function toTelemetryValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toTelemetryValue).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => [key, toTelemetryValue(raw)]),
    );
  }
  return String(value);
}

function mapUsage(usage: Record<string, unknown>): RuntimeLlmUsage {
  const result: RuntimeLlmUsage = {};
  if (typeof usage.input === 'number') result.input = usage.input;
  if (typeof usage.output === 'number') result.output = usage.output;
  if (typeof usage.cacheRead === 'number') result.cacheRead = usage.cacheRead;
  if (typeof usage.cacheWrite === 'number') result.cacheWrite = usage.cacheWrite;
  if (typeof usage.totalTokens === 'number') result.totalTokens = usage.totalTokens;
  if (usage.cost != null && typeof usage.cost === 'object')
    result.cost = usage.cost as NonNullable<RuntimeLlmUsage['cost']>;
  return result;
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function subagentLifecycleDetails(input: {
  agent?: string | undefined;
  input?: string | undefined;
  output?: string | undefined;
}): JsonObject | undefined {
  const details: JsonObject = {};
  if (input.agent !== undefined) {
    details.agent = input.agent;
  }
  if (input.input !== undefined) {
    details.input = input.input;
  }
  if (input.output !== undefined) {
    details.output = input.output;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export default function telemetryExtension(pi: ExtensionAPI): void {
  const inheritedTraceId = process.env.PI_TELEMETRY_TRACE_ID;
  const inheritedSessionId = process.env.PI_TELEMETRY_SESSION_ID;
  const ownerPid = process.env.PI_TELEMETRY_OWNER_PID;
  const subagentAgent =
    nonEmptyEnv('PI_SUBAGENT_CHILD_AGENT') ??
    nonEmptyEnv('PI_TELEMETRY_SUBAGENT_NAME') ??
    nonEmptyEnv('PI_TELEMETRY_SUBAGENT_AGENT');
  const taskRunId = nonEmptyEnv('PI_TELEMETRY_TASK_RUN_ID');
  const runtimeCorrelation = taskRunId ? { taskRunId } : {};
  const isSubagent = Boolean(inheritedTraceId && ownerPid && ownerPid !== String(process.pid));
  let presetRootTraceId = isSubagent ? undefined : inheritedTraceId;

  let exporter: RuntimeEventExporter = new NoopRuntimeEventExporter();
  const localSessionId = randomUUID();
  const sessionId = isSubagent && inheritedSessionId ? inheritedSessionId : localSessionId;
  const parentSessionId = isSubagent ? inheritedSessionId : undefined;
  let currentTraceId: string | undefined = isSubagent ? inheritedTraceId : undefined;
  let traceStartTime: number | undefined;
  let tracePublished = false;
  let llmGenerationCounter = 0;
  let pendingInput: string | undefined;
  let lastModelConfig: RuntimeModelConfig = { provider: 'unknown', model: 'unknown' };
  let streamStartedAt: number | undefined;
  let streamEvents: JsonValue[] = [];
  let streamBytes = 0;
  let streamTruncated = false;

  pi.on('session_start', async (_event, ctx) => {
    const config = resolveConfig(
      loadConfigFromFile({
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
      }),
    );
    // One exporter/provider even when both Langfuse and a generic OTLP
    // endpoint are configured: two providers would mint different span ids for
    // the same logical span and cross-wire PI_TELEMETRY_TRACEPARENT.
    exporter = createTelemetryExporter(config);
  });

  pi.on('input', async (event) => {
    pendingInput = event.text;
    if (!isSubagent) {
      currentTraceId = presetRootTraceId ?? randomUUID().replace(/-/g, '');
      presetRootTraceId = undefined;
      process.env.PI_TELEMETRY_TRACE_ID = currentTraceId;
      process.env.PI_TELEMETRY_SESSION_ID = sessionId;
      process.env.PI_TELEMETRY_OWNER_PID = String(process.pid);
    }
    traceStartTime = undefined;
    tracePublished = false;
    llmGenerationCounter = 0;
  });

  pi.on('turn_start', async (event) => {
    if (!currentTraceId) {
      currentTraceId = randomUUID().replace(/-/g, '');
      llmGenerationCounter = 0;
      tracePublished = false;
    }
    if (!traceStartTime) {
      traceStartTime = event.timestamp;
    }

    if (!tracePublished) {
      tracePublished = true;
      if (isSubagent) {
        const details = subagentLifecycleDetails({
          agent: subagentAgent,
          input: pendingInput,
        });
        await exporter.publish({
          id: randomUUID(),
          traceId: currentTraceId,
          ...runtimeCorrelation,
          type: 'subagent_started',
          sessionId,
          ...(parentSessionId ? { parentSessionId } : {}),
          childSessionId: localSessionId,
          createdAt: new Date(event.timestamp).toISOString(),
          ...(details ? { details } : {}),
        });
      } else {
        await exporter.publish({
          id: randomUUID(),
          traceId: currentTraceId,
          ...runtimeCorrelation,
          type: 'chat_turn_started',
          sessionId,
          createdAt: new Date(event.timestamp).toISOString(),
          ...(pendingInput !== undefined ? { details: { input: pendingInput } } : {}),
        });
      }
      pendingInput = undefined;
    }
  });

  pi.on('agent_end', async (event) => {
    if (!currentTraceId) return;
    const now = Date.now();
    const durationMs = traceStartTime ? now - traceStartTime : undefined;
    const output = extractLastOutput(event.messages);

    if (isSubagent) {
      const details = subagentLifecycleDetails({
        agent: subagentAgent,
        output,
      });
      await exporter.publish({
        id: randomUUID(),
        traceId: currentTraceId,
        ...runtimeCorrelation,
        type: 'subagent_completed',
        sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
        childSessionId: localSessionId,
        createdAt: new Date(now).toISOString(),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(details ? { details } : {}),
      });
    } else {
      await exporter.publish({
        id: randomUUID(),
        traceId: currentTraceId,
        ...runtimeCorrelation,
        type: 'chat_turn_completed',
        sessionId,
        createdAt: new Date(now).toISOString(),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(output !== undefined ? { details: { output } } : {}),
      });
    }
  });

  pi.on('tool_execution_start', async (event) => {
    if (!currentTraceId) return;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: 'started',
      createdAt: new Date().toISOString(),
      args: event.args as JsonObject,
    });
  });

  pi.on('tool_execution_end', async (event) => {
    if (!currentTraceId) return;
    // Failed tool results can contain credentials, internal paths, or stacks.
    // Keep the failure signal but never forward the raw result as telemetry.
    const details = event.isError ? undefined : toolEventDetails(event.result);

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: event.isError ? 'failed' : 'completed',
      createdAt: new Date().toISOString(),
      ...(details ? { details } : {}),
      ...(event.isError ? { error: 'Tool execution failed' } : {}),
    });
  });

  pi.on('before_provider_request', async (event, ctx) => {
    if (!currentTraceId) return;
    llmGenerationCounter++;
    lastModelConfig = modelConfigFromCtx(ctx);
    streamStartedAt = undefined;
    streamEvents = [];
    streamBytes = 0;
    streamTruncated = false;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
      llmGenerationId: `gen-${llmGenerationCounter}`,
      status: 'started',
      createdAt: new Date().toISOString(),
      model: lastModelConfig,
      input: event.payload as JsonValue,
    });
  });

  pi.on('after_provider_response', async (event, ctx) => {
    if (!currentTraceId) return;
    if (event.status < 400) return;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
      llmGenerationId: `gen-${llmGenerationCounter}`,
      status: 'failed',
      createdAt: new Date().toISOString(),
      model: modelConfigFromCtx(ctx),
      error: `HTTP ${event.status}`,
    });
  });

  pi.on('message_update', async (event) => {
    if (!currentTraceId || llmGenerationCounter === 0) return;
    const update = event.assistantMessageEvent as unknown as Record<string, unknown>;
    const { partial: _partial, message: _message, error: _error, ...frame } = update;
    const value = toTelemetryValue(frame);
    if (value === undefined) return;
    streamStartedAt ??= Date.now();
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (!streamTruncated && streamBytes + bytes <= MAX_STREAM_CAPTURE_BYTES) {
      streamEvents.push(value);
      streamBytes += bytes;
    } else if (!streamTruncated) {
      streamEvents.push({ type: 'truncated', maxBytes: MAX_STREAM_CAPTURE_BYTES });
      streamTruncated = true;
    }
  });

  pi.on('message_end', async (event) => {
    if (!currentTraceId) return;
    const msg = event.message as unknown as Record<string, unknown>;
    if (msg.role !== 'assistant') return;

    const content = simplifyContent(msg.content) ?? extractOutput(event.message);
    const usage = msg.usage as Record<string, unknown> | undefined;
    const mapped = usage ? mapUsage(usage) : undefined;

    if (streamStartedAt !== undefined && streamEvents.length > 0) {
      const endedAt = Date.now();
      await exporter.publish({
        id: randomUUID(),
        traceId: currentTraceId,
        ...runtimeCorrelation,
        sessionId: localSessionId,
        conversationId: localSessionId,
        ...(isSubagent
          ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
          : {}),
        llmGenerationId: `gen-${llmGenerationCounter}`,
        createdAt: new Date(streamStartedAt).toISOString(),
        durationMs: endedAt - streamStartedAt,
        streamEvents,
      });
      streamStartedAt = undefined;
      streamEvents = [];
      streamBytes = 0;
      streamTruncated = false;
    }

    const output: JsonObject = {};
    if (content !== undefined) output.content = content;
    if (usage !== undefined) output.usage = usage as JsonValue;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
      llmGenerationId: `gen-${llmGenerationCounter}`,
      status: 'completed',
      createdAt: new Date().toISOString(),
      model: lastModelConfig,
      ...(Object.keys(output).length > 0 ? { output } : {}),
      ...(mapped ? { usage: mapped } : {}),
      ...(typeof msg.responseId === 'string' ? { responseId: msg.responseId } : {}),
      ...(typeof msg.stopReason === 'string' ? { stopReason: msg.stopReason } : {}),
    });
  });

  pi.on('model_select', async (event) => {
    if (!currentTraceId) return;
    const evt = event as unknown as Record<string, unknown>;
    const model = evt.model as Record<string, unknown> | undefined;
    const previousModel = evt.previousModel as Record<string, unknown> | undefined;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      type: 'chat_turn_steered',
      sessionId,
      createdAt: new Date().toISOString(),
      details: {
        eventType: 'model_switch',
        from: previousModel
          ? {
              provider: String(previousModel.provider ?? 'unknown'),
              model: String(previousModel.id ?? 'unknown'),
            }
          : null,
        to: model
          ? {
              provider: String(model.provider ?? 'unknown'),
              model: String(model.id ?? 'unknown'),
            }
          : null,
        source: String(evt.source ?? 'unknown'),
      } as JsonObject,
    });
  });

  pi.on('session_compact', async (event) => {
    if (!currentTraceId) return;
    const evt = event as unknown as Record<string, unknown>;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      type: 'chat_turn_steered',
      sessionId,
      createdAt: new Date().toISOString(),
      details: {
        eventType: 'session_compact',
        fromExtension: (evt.fromExtension as boolean) ?? false,
      } as JsonObject,
    });
  });

  pi.on('session_shutdown', async () => {
    await exporter.close?.();
  });
}
