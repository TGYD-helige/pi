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
import {
  displayContent,
  displayMessage,
  hasFirstToken,
  modelParameters,
  toTelemetryValue,
} from './observations.js';
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
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
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

function messageFailure(message: unknown): { error?: string; outcome?: string } {
  if (!message || typeof message !== 'object') return {};
  const msg = message as Record<string, unknown>;
  if (msg.stopReason !== 'error' && msg.stopReason !== 'aborted') return {};
  return {
    error:
      typeof msg.errorMessage === 'string' && msg.errorMessage
        ? msg.errorMessage
        : msg.stopReason === 'aborted'
          ? 'Generation cancelled'
          : 'Generation failed',
    outcome: msg.stopReason,
  };
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

function toolEventDetails(
  result: unknown,
  isError: boolean,
): { details?: JsonObject; error?: string } {
  const rawDetails =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).details
      : undefined;
  const details = sanitizeToolDetails(rawDetails);
  const output = summarizeToolResultOutput(result, rawDetails);
  if (output !== undefined && details.output === undefined) {
    details.output = output;
  }
  if (isError) {
    // Tool owners sanitize errors at source; telemetry preserves that text for diagnostics.
    return { error: typeof details.output === 'string' ? details.output : 'Tool execution failed' };
  }
  return Object.keys(details).length > 0 ? { details } : {};
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

function mapUsage(usage: Record<string, unknown>, modelPricingKnown?: boolean): RuntimeLlmUsage {
  const result: RuntimeLlmUsage = {};
  if (typeof usage.input === 'number') result.input = usage.input;
  if (typeof usage.output === 'number') result.output = usage.output;
  if (typeof usage.cacheRead === 'number') result.cacheRead = usage.cacheRead;
  if (typeof usage.cacheWrite === 'number') result.cacheWrite = usage.cacheWrite;
  if (typeof usage.cacheWrite1h === 'number') result.cacheWrite1h = usage.cacheWrite1h;
  if (typeof usage.reasoning === 'number') result.reasoning = usage.reasoning;
  if (typeof usage.totalTokens === 'number') result.totalTokens = usage.totalTokens;
  if (usage.cost && typeof usage.cost === 'object' && !Array.isArray(usage.cost)) {
    const cost: NonNullable<RuntimeLlmUsage['cost']> = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      const value = (usage.cost as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) cost[key] = value;
    }
    if (Object.keys(cost).length) result.cost = cost;
  }
  if (
    usage.costSource === 'unknown' ||
    usage.costSource === 'provided' ||
    usage.costSource === 'model-pricing'
  ) {
    result.costSource = usage.costSource;
  } else if (
    !result.cost ||
    (modelPricingKnown === false && Object.values(result.cost).every((value) => value === 0))
  ) {
    result.costSource = 'unknown';
  } else if (modelPricingKnown === true) {
    result.costSource = 'model-pricing';
  }
  return result;
}

function hasModelPricing(ctx: ExtensionContext): boolean {
  return Object.values(ctx.model?.cost ?? {}).some(
    (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0,
  );
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function subagentLifecycleDetails(input: {
  agent?: string | undefined;
  input?: JsonValue | undefined;
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
  const correlationKeys = [
    'PI_TELEMETRY_TRACE_ID',
    'PI_TELEMETRY_SESSION_ID',
    'PI_TELEMETRY_OWNER_PID',
    'PI_TELEMETRY_TRACEPARENT',
  ];
  const inheritedEnvironment = new Map(correlationKeys.map((key) => [key, process.env[key]]));
  function restoreCorrelation(): void {
    for (const [key, value] of inheritedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  let localSessionId: string = randomUUID();
  let sessionId = isSubagent && inheritedSessionId ? inheritedSessionId : localSessionId;
  const parentSessionId = isSubagent ? inheritedSessionId : undefined;
  let currentTraceId: string | undefined = isSubagent ? inheritedTraceId : undefined;
  let traceStartTime: number | undefined;
  let tracePublished = false;
  let llmGenerationCounter = 0;
  let pendingInput: string | undefined;
  let pendingImages: unknown[] = [];
  let systemPrompt: string | undefined;
  let contextHistory: JsonObject[] | undefined;
  let hasFullContext = false;
  let mediaEnabled = false;
  let lastModelConfig: RuntimeModelConfig = { provider: 'unknown', model: 'unknown' };
  let streamStartedAt: number | undefined;
  let completionStartTime: string | undefined;
  let requestParameters: JsonObject = {};
  let modelPricingKnown = false;
  let generationOpen = false;
  let boundaryFailure: { error?: string; outcome?: string } = {};
  let streamEvents: JsonValue[] = [];
  let streamBytes = 0;
  let streamTruncated = false;
  let finalMessages: readonly unknown[] = [];
  let promptNumber = 0;
  let activePromptNumber = 0;
  let inputNumbered = false;
  let compactionStartedAt: number | undefined;
  let branchSummaryStartedAt: number | undefined;
  const toolStarts = new Map<string, { startedAt: number; toolName: string }>();
  let supportsSettlement = false;
  let convertMessages: typeof import('@earendil-works/pi-coding-agent').convertToLlm | undefined;

  function observationLineage(traceId: string) {
    return {
      traceId,
      ...runtimeCorrelation,
      sessionId: localSessionId,
      conversationId: localSessionId,
      ...(isSubagent
        ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
        : {}),
    };
  }

  function showStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const status = exporter.getStatus?.();
    ctx.ui.setStatus?.('telemetry', `telemetry: ${status?.state ?? 'enabled'}`);
  }

  pi.registerCommand('telemetry', {
    description: 'Inspect telemetry status or flush pending spans: /telemetry [status|flush]',
    async handler(args, ctx) {
      const action = args.trim() || 'status';
      if (action !== 'status' && action !== 'flush') {
        if (ctx.hasUI) ctx.ui.notify('Usage: /telemetry [status|flush]', 'warning');
        return;
      }
      if (action === 'flush') await exporter.flush?.();
      const status = exporter.getStatus?.();
      showStatus(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          action === 'flush' && status?.error
            ? status.error
            : action === 'flush'
              ? 'Telemetry flush finished; backend delivery is not confirmed'
              : `Telemetry: ${status?.state ?? 'enabled'}; session: ${sessionId}`,
          action === 'flush' && status?.error ? 'error' : 'info',
        );
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    // Keep the runtime peer optional for callers importing programmatic exporters.
    const runtime = await import('@earendil-works/pi-coding-agent');
    const [major = 0, minor = 0, patch = 0] = runtime.VERSION.split('.').map(Number);
    supportsSettlement = major > 0 || minor > 84 || (minor === 84 && patch >= 2);
    convertMessages = runtime.convertToLlm;
    localSessionId = ctx.sessionManager?.getSessionId() ?? randomUUID();
    sessionId = isSubagent && inheritedSessionId ? inheritedSessionId : localSessionId;
    currentTraceId = isSubagent ? inheritedTraceId : undefined;
    tracePublished = false;
    traceStartTime = undefined;
    finalMessages = [];
    pendingInput = undefined;
    pendingImages = [];
    contextHistory = undefined;
    hasFullContext = false;
    systemPrompt = undefined;
    promptNumber = (ctx.sessionManager?.getEntries?.() ?? []).filter(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    ).length;
    inputNumbered = false;
    generationOpen = false;
    boundaryFailure = {};
    toolStarts.clear();
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
    mediaEnabled = config.includePayloads === true && config.mediaUploadEnabled === true;
    showStatus(ctx);
  });

  pi.on('input', async (event) => {
    if (event.streamingBehavior && currentTraceId) {
      promptNumber += 1;
      await exporter.publish({
        id: randomUUID(),
        traceId: currentTraceId,
        ...runtimeCorrelation,
        type:
          event.streamingBehavior === 'followUp'
            ? 'chat_turn_followup_queued'
            : 'chat_turn_steered',
        sessionId,
        ...(isSubagent
          ? { ...(parentSessionId ? { parentSessionId } : {}), childSessionId: localSessionId }
          : {}),
        createdAt: new Date().toISOString(),
        details: {
          input: event.images?.length
            ? [
                {
                  role: 'user',
                  content: displayContent(
                    [{ type: 'text', text: event.text }, ...event.images],
                    mediaEnabled,
                  ),
                },
              ]
            : event.text,
          turnMode: event.streamingBehavior,
        },
      });
      return;
    }
    if (tracePublished)
      await completeTrace({ error: 'Run superseded by a new input', outcome: 'aborted' });
    promptNumber += 1;
    inputNumbered = true;
    pendingInput = event.text;
    pendingImages = event.images ?? [];
    contextHistory = undefined;
    hasFullContext = false;
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

  pi.on('before_agent_start', (event) => {
    pendingInput ??= event.prompt;
    pendingImages = event.images ?? pendingImages;
    systemPrompt = event.systemPrompt;
  });
  pi.on('agent_start', (_event, ctx) => {
    systemPrompt = ctx.getSystemPrompt?.() ?? systemPrompt;
  });
  pi.on('context', (event) => {
    hasFullContext = false;
    contextHistory = (convertMessages ? convertMessages(event.messages) : event.messages)
      .map((message) => displayMessage(message))
      .filter((message) => message !== undefined);
  });
  pi.on('context_with_system', (event) => {
    hasFullContext = true;
    contextHistory = (convertMessages ? convertMessages(event.messages) : event.messages)
      .map((message, index) => displayMessage(message, index > 0))
      .filter((message) => message !== undefined);
  });

  pi.on('turn_start', async (event) => {
    if (!currentTraceId) {
      currentTraceId =
        (isSubagent ? inheritedTraceId : undefined) ?? randomUUID().replace(/-/g, '');
      llmGenerationCounter = 0;
      tracePublished = false;
    }
    if (!traceStartTime) {
      traceStartTime = event.timestamp;
    }

    if (!tracePublished) {
      tracePublished = true;
      if (!inputNumbered) promptNumber += 1;
      activePromptNumber = promptNumber;
      if (!isSubagent) {
        process.env.PI_TELEMETRY_TRACE_ID = currentTraceId;
        process.env.PI_TELEMETRY_SESSION_ID = sessionId;
        process.env.PI_TELEMETRY_OWNER_PID = String(process.pid);
      }
      const input: JsonValue | undefined = pendingImages.length
        ? [
            {
              role: 'user',
              content: displayContent(
                [{ type: 'text', text: pendingInput ?? '' }, ...pendingImages],
                mediaEnabled,
              ),
            },
          ]
        : pendingInput;
      if (isSubagent) {
        const details = subagentLifecycleDetails({
          agent: subagentAgent,
          input,
        });
        await exporter.publish({
          id: randomUUID(),
          traceId: currentTraceId,
          ...runtimeCorrelation,
          type: 'subagent_started',
          sessionId,
          promptNumber: activePromptNumber,
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
          promptNumber: activePromptNumber,
          createdAt: new Date(event.timestamp).toISOString(),
          ...(input !== undefined ? { details: { input } } : {}),
        });
      }
      pendingInput = undefined;
      pendingImages = [];
    }
  });

  pi.on('agent_end', async (event) => {
    finalMessages = event.messages;
    if (!supportsSettlement) await completeTrace();
  });

  pi.on('agent_before_settle', (event) => {
    boundaryFailure =
      event.outcome === 'completed'
        ? {}
        : {
            error: event.outcome === 'aborted' ? 'Run cancelled' : 'Run failed',
            outcome: event.outcome,
          };
  });

  pi.on('agent_settled', async (_event, ctx) => {
    await completeTrace();
    await exporter.flush?.();
    showStatus(ctx);
  });

  async function completeTrace(forcedFailure?: { error: string; outcome: string }): Promise<void> {
    if (!currentTraceId) return;
    const now = Date.now();
    const durationMs = traceStartTime ? now - traceStartTime : undefined;
    const output = extractLastOutput(finalMessages);
    const lastAssistant = [...finalMessages]
      .reverse()
      .find(
        (message) =>
          message &&
          typeof message === 'object' &&
          (message as Record<string, unknown>).role === 'assistant',
      );
    const failure =
      forcedFailure ?? (boundaryFailure.error ? boundaryFailure : messageFailure(lastAssistant));
    if (generationOpen)
      await failOpenGeneration(
        failure.error ?? 'Generation interrupted before settlement',
        failure.outcome ?? 'aborted',
      );
    for (const [toolCallId, tool] of toolStarts) {
      await exporter.publish({
        id: randomUUID(),
        ...observationLineage(currentTraceId),
        toolCallId,
        toolName: tool.toolName,
        status: 'failed',
        createdAt: new Date().toISOString(),
        error: 'Tool interrupted before settlement',
      });
    }
    toolStarts.clear();

    if (isSubagent) {
      const details = subagentLifecycleDetails({
        agent: subagentAgent,
        output,
      });
      await exporter.publish({
        id: randomUUID(),
        traceId: currentTraceId,
        ...runtimeCorrelation,
        type:
          failure.outcome === 'aborted'
            ? 'subagent_cancelled'
            : failure.error
              ? 'subagent_failed'
              : 'subagent_completed',
        ...(failure.error ? { error: failure.error } : {}),
        sessionId,
        promptNumber: activePromptNumber,
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
        type: failure.error ? 'chat_turn_failed' : 'chat_turn_completed',
        ...(failure.error ? { error: failure.error } : {}),
        sessionId,
        promptNumber: activePromptNumber,
        createdAt: new Date(now).toISOString(),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(output !== undefined || failure.outcome
          ? {
              details: {
                ...(output !== undefined ? { output } : {}),
                ...(failure.outcome ? { outcome: failure.outcome } : {}),
              },
            }
          : {}),
      });
    }
    currentTraceId = undefined;
    tracePublished = false;
    traceStartTime = undefined;
    finalMessages = [];
    inputNumbered = false;
    boundaryFailure = {};
    restoreCorrelation();
  }

  pi.on('tool_execution_start', async (event) => {
    if (!currentTraceId) return;
    if (toolStarts.size >= 512) toolStarts.delete(toolStarts.keys().next().value!);
    toolStarts.set(event.toolCallId, { startedAt: Date.now(), toolName: event.toolName });

    await exporter.publish({
      id: randomUUID(),
      ...observationLineage(currentTraceId),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: 'started',
      createdAt: new Date().toISOString(),
      args: event.args as JsonObject,
    });
  });

  pi.on('tool_execution_end', async (event) => {
    if (!currentTraceId) return;
    toolStarts.delete(event.toolCallId);
    const resultDetails = toolEventDetails(event.result, event.isError);

    await exporter.publish({
      id: randomUUID(),
      ...observationLineage(currentTraceId),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: event.isError ? 'failed' : 'completed',
      createdAt: new Date().toISOString(),
      ...resultDetails,
      ...(!event.isError &&
      Array.isArray(event.result?.content) &&
      !shouldSuppressToolOutput(event.result?.details)
        ? {
            details: {
              ...resultDetails.details,
              displayOutput: displayContent(event.result?.content, mediaEnabled),
            },
          }
        : {}),
    });
  });

  async function publishAuxiliary(
    source: 'compaction' | 'branch_summary' | 'tool',
    ctx: ExtensionContext,
    entry: { summary?: string; usage?: unknown; fromHook?: boolean },
    startedAt?: number,
    parentToolCallId?: string,
  ): Promise<void> {
    const now = Date.now();
    const traceId = currentTraceId ?? randomUUID().replace(/-/g, '');
    const base = {
      id: randomUUID(),
      ...observationLineage(traceId),
      llmGenerationId: `${source}-${randomUUID()}`,
      source,
      observationName:
        source === 'compaction'
          ? 'Compaction'
          : source === 'branch_summary'
            ? 'Branch Summary'
            : 'Tool LLM Usage',
      model:
        source === 'tool' ? { provider: 'unknown', model: 'unknown' } : modelConfigFromCtx(ctx),
      modelParameters: { modelAttribution: source === 'tool' ? 'unreported' : 'session-config' },
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
    await exporter.publish({
      ...base,
      status: 'started',
      createdAt: new Date(startedAt ?? now).toISOString(),
    });
    await exporter.publish({
      ...base,
      id: randomUUID(),
      status: 'completed',
      createdAt: new Date(now).toISOString(),
      ...(entry.summary !== undefined
        ? { output: entry.summary, displayOutput: { role: 'assistant', content: entry.summary } }
        : {}),
      ...(entry.usage && typeof entry.usage === 'object'
        ? {
            usage: mapUsage(
              entry.usage as Record<string, unknown>,
              source === 'tool' || entry.fromHook ? undefined : hasModelPricing(ctx),
            ),
          }
        : {}),
    });
  }

  pi.on('tool_result', async (event, ctx) => {
    if (!currentTraceId || !event.usage) return;
    await publishAuxiliary(
      'tool',
      ctx,
      { usage: event.usage },
      toolStarts.get(event.toolCallId)?.startedAt,
      event.toolCallId,
    );
  });

  pi.on('session_before_compact', () => {
    compactionStartedAt = Date.now();
  });
  pi.on('session_before_tree', () => {
    branchSummaryStartedAt = Date.now();
  });
  pi.on('session_tree', async (event, ctx) => {
    const startedAt = branchSummaryStartedAt;
    branchSummaryStartedAt = undefined;
    if (event.summaryEntry)
      await publishAuxiliary('branch_summary', ctx, event.summaryEntry, startedAt);
  });

  function generationDisplayInput(): JsonValue {
    if (hasFullContext) return contextHistory ?? [];
    const messages: JsonObject[] = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...(contextHistory ?? []),
    ];
    const active = new Set(pi.getActiveTools?.() ?? []);
    const tools = (pi.getAllTools?.() ?? [])
      .filter((tool) => active.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toTelemetryValue(tool.parameters),
      }));
    if (tools.length && messages[0]) messages[0] = { ...messages[0], tools };
    return messages;
  }

  async function failOpenGeneration(error: string, stopReason: string): Promise<void> {
    if (!currentTraceId || !generationOpen) return;
    generationOpen = false;
    await exporter.publish({
      id: randomUUID(),
      ...observationLineage(currentTraceId),
      llmGenerationId: `gen-${llmGenerationCounter}`,
      status: 'failed',
      createdAt: new Date().toISOString(),
      model: lastModelConfig,
      error,
      stopReason,
      modelParameters: requestParameters,
      ...(completionStartTime ? { completionStartTime } : {}),
    });
  }

  pi.on('before_provider_request', async (event, ctx) => {
    if (!currentTraceId) return;
    if (generationOpen) await failOpenGeneration('Superseded by provider retry', 'superseded');
    llmGenerationCounter++;
    generationOpen = true;
    lastModelConfig = modelConfigFromCtx(ctx);
    modelPricingKnown = hasModelPricing(ctx);
    requestParameters = modelParameters(event.payload, ctx.thinkingLevel);
    systemPrompt = ctx.getSystemPrompt?.() ?? systemPrompt;
    completionStartTime = undefined;
    streamStartedAt = undefined;
    streamEvents = [];
    streamBytes = 0;
    streamTruncated = false;

    await exporter.publish({
      id: randomUUID(),
      ...observationLineage(currentTraceId),
      llmGenerationId: `gen-${llmGenerationCounter}`,
      source: 'agent',
      status: 'started',
      createdAt: new Date().toISOString(),
      model: lastModelConfig,
      input: event.payload as JsonValue,
      modelParameters: requestParameters,
      ...(contextHistory || systemPrompt ? { displayInput: generationDisplayInput() } : {}),
    });
  });

  pi.on('after_provider_response', async (event) => {
    if (event.status >= 400) await failOpenGeneration(`HTTP ${event.status}`, 'error');
  });

  pi.on('message_update', async (event) => {
    if (!currentTraceId || !generationOpen) return;
    const update = event.assistantMessageEvent as unknown as Record<string, unknown>;
    if (!completionStartTime && hasFirstToken(update, event.message)) {
      completionStartTime = new Date().toISOString();
    }
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
    if (!currentTraceId || !generationOpen) return;
    const msg = event.message as unknown as Record<string, unknown>;
    if (msg.role !== 'assistant') return;
    generationOpen = false;

    const content = simplifyContent(msg.content) ?? extractOutput(event.message);
    const usage = msg.usage as Record<string, unknown> | undefined;
    const mapped = usage ? mapUsage(usage, modelPricingKnown) : undefined;
    const failure = messageFailure(msg);
    const displayOutput = displayMessage(msg);

    if (streamStartedAt !== undefined && streamEvents.length > 0) {
      const endedAt = Date.now();
      await exporter.publish({
        id: randomUUID(),
        ...observationLineage(currentTraceId),
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
      ...observationLineage(currentTraceId),
      llmGenerationId: `gen-${llmGenerationCounter}`,
      source: 'agent',
      status: failure.error ? 'failed' : 'completed',
      ...(failure.error ? { error: failure.error } : {}),
      createdAt: new Date().toISOString(),
      model: {
        ...lastModelConfig,
        model:
          typeof msg.responseModel === 'string'
            ? msg.responseModel
            : typeof msg.model === 'string'
              ? msg.model
              : lastModelConfig.model,
        ...(typeof msg.provider === 'string' ? { provider: msg.provider } : {}),
      },
      requestedModel: lastModelConfig.model,
      modelParameters: requestParameters,
      ...(completionStartTime ? { completionStartTime } : {}),
      ...(typeof msg.api === 'string' ? { api: msg.api } : {}),
      ...(Object.keys(output).length > 0 ? { output } : {}),
      ...(displayOutput ? { displayOutput } : {}),
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

  pi.on('session_compact', async (event, ctx) => {
    const startedAt = compactionStartedAt;
    compactionStartedAt = undefined;
    if (event.compactionEntry?.summary !== undefined || event.compactionEntry?.usage) {
      await publishAuxiliary('compaction', ctx, event.compactionEntry, startedAt);
    }
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
    restoreCorrelation();
  });
}
