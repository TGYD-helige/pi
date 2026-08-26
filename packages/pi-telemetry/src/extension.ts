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
import {
  CompositeRuntimeEventExporter,
  NoopRuntimeEventExporter,
  type RuntimeEventExporter,
} from './index.js';
import { createLangfuseExporter } from './langfuse.js';
import { createOtelExporter } from './otel.js';

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
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return undefined;
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
    return summarizeString(result);
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
    return summarizeString(text);
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
    return summarizeString(value);
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

function summarizeString(value: string): string {
  return value.length > 500
    ? `${value.slice(0, 500)}... [truncated ${value.length - 500} chars]`
    : value;
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

  let exporter: RuntimeEventExporter = new NoopRuntimeEventExporter();
  const localSessionId = randomUUID();
  const sessionId = isSubagent && inheritedSessionId ? inheritedSessionId : localSessionId;
  const parentSessionId = isSubagent ? inheritedSessionId : undefined;
  let currentTraceId: string | undefined = isSubagent ? inheritedTraceId : undefined;
  let traceStartTime: number | undefined;
  let tracePublished = false;
  let llmGenerationCounter = 0;
  let terminalGenerationCounter = 0;
  let pendingInput: string | undefined;
  let lastModelConfig: RuntimeModelConfig = { provider: 'unknown', model: 'unknown' };

  const publishCompletedGeneration = async (message: unknown): Promise<boolean> => {
    if (!currentTraceId || llmGenerationCounter <= terminalGenerationCounter) {
      return false;
    }
    if (!message || typeof message !== 'object') {
      return false;
    }
    const msg = message as Record<string, unknown>;
    if (msg.role !== 'assistant') {
      return false;
    }

    const generationIndex = llmGenerationCounter;
    const previousTerminalGenerationCounter = terminalGenerationCounter;
    // Reserve the terminal before awaiting the exporter. message_end and turn_end may
    // be dispatched close together; only one of them may close this generation.
    terminalGenerationCounter = generationIndex;
    const content = simplifyContent(msg.content) ?? extractOutput(message);
    const usage = msg.usage as Record<string, unknown> | undefined;
    const mapped = usage ? mapUsage(usage) : undefined;
    const output: JsonObject = {};
    if (content !== undefined) output.content = content;
    if (usage !== undefined) output.usage = usage as JsonValue;

    try {
      await exporter.publish({
        id: randomUUID(),
        traceId: currentTraceId,
        ...runtimeCorrelation,
        sessionId: localSessionId,
        conversationId: localSessionId,
        ...(isSubagent
          ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
          : {}),
        llmGenerationId: `gen-${generationIndex}`,
        status: 'completed',
        createdAt: new Date().toISOString(),
        model: lastModelConfig,
        ...(Object.keys(output).length > 0 ? { output } : {}),
        ...(mapped ? { usage: mapped } : {}),
        ...(typeof msg.responseId === 'string' ? { responseId: msg.responseId } : {}),
        ...(typeof msg.stopReason === 'string' ? { stopReason: msg.stopReason } : {}),
      });
    } catch (error) {
      // Keep the synchronous reservation for duplicate suppression, but release
      // only our own reservation when delivery itself failed. A later turn_end
      // can then retry the same terminal from its authoritative assistant message.
      if (terminalGenerationCounter === generationIndex) {
        terminalGenerationCounter = previousTerminalGenerationCounter;
      }
      throw error;
    }
    return true;
  };

  pi.on('session_start', async (_event, ctx) => {
    const config = resolveConfig(
      loadConfigFromFile({
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
      }),
    );
    const langfuse = createLangfuseExporter(config);
    const otel = createOtelExporter(config);

    const active = [langfuse, otel].filter((e) => !(e instanceof NoopRuntimeEventExporter));
    exporter =
      active.length > 1
        ? new CompositeRuntimeEventExporter(active)
        : (active[0] ?? new NoopRuntimeEventExporter());
  });

  pi.on('input', async (event) => {
    pendingInput = event.text;
    if (!isSubagent) {
      currentTraceId = randomUUID().replace(/-/g, '');
      process.env.PI_TELEMETRY_TRACE_ID = currentTraceId;
      process.env.PI_TELEMETRY_SESSION_ID = sessionId;
      process.env.PI_TELEMETRY_OWNER_PID = String(process.pid);
    }
    traceStartTime = undefined;
    tracePublished = false;
    llmGenerationCounter = 0;
    terminalGenerationCounter = 0;
  });

  pi.on('turn_start', async (event) => {
    if (!currentTraceId) {
      currentTraceId = randomUUID().replace(/-/g, '');
      llmGenerationCounter = 0;
      terminalGenerationCounter = 0;
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

  pi.on('turn_end', async (event) => {
    if (!currentTraceId) return;
    // Some executor shutdown paths can reach turn_end before the message_end
    // listener has durably exported its terminal. Close from the same assistant
    // message first so the lifecycle flush cannot leave a span-only trace.
    await publishCompletedGeneration(event.message);
    const now = Date.now();
    const durationMs = traceStartTime ? now - traceStartTime : undefined;
    const output = extractOutput(event.message);

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
    const details = toolEventDetails(event.result);

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
      ...(event.isError
        ? { error: typeof event.result === 'string' ? event.result : JSON.stringify(event.result) }
        : {}),
    });
  });

  pi.on('before_provider_request', async (event, ctx) => {
    if (!currentTraceId) return;
    llmGenerationCounter++;
    lastModelConfig = modelConfigFromCtx(ctx);

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
    const generationIndex = llmGenerationCounter;
    if (generationIndex <= terminalGenerationCounter) return;
    terminalGenerationCounter = generationIndex;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
      llmGenerationId: `gen-${generationIndex}`,
      status: 'failed',
      createdAt: new Date().toISOString(),
      model: modelConfigFromCtx(ctx),
      error: `HTTP ${event.status}`,
    });
  });

  pi.on('message_end', async (event) => {
    await publishCompletedGeneration(event.message);
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
          ? { provider: String(model.provider ?? 'unknown'), model: String(model.id ?? 'unknown') }
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
    await exporter.flush?.();
    await exporter.close?.();
  });
}
