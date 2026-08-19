import { createHash } from 'node:crypto';
import type {
  JsonObject,
  JsonValue,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeLlmUsage,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';
import { Langfuse } from 'langfuse';
import type { TelemetryConfig } from './config.js';
import {
  NoopRuntimeEventExporter,
  type RuntimeEventExporter,
  type RuntimeTelemetryEvent,
  type RuntimeTelemetryOptions,
  type TelemetryEnvironment,
  type TelemetryFetch,
} from './index.js';

export type LangfuseExporterConfig = {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  flushAt: number;
  flushIntervalMs: number;
} & RuntimeTelemetryOptions;

export type OtelExporterConfig = {
  enabled: boolean;
  endpoint: string;
  headers?: Record<string, string>;
  flushAt: number;
  flushIntervalMs: number;
  errorLabel?: string;
} & RuntimeTelemetryOptions;

export type LangfuseFetch = TelemetryFetch;

export interface LangfuseSdkClient {
  trace(body?: Record<string, unknown>): LangfuseSdkTraceClient;
  flushAsync(): Promise<void>;
  shutdownAsync(): Promise<void>;
}

export interface LangfuseSdkTraceClient {
  update(body: Record<string, unknown>): unknown;
  span(body: Record<string, unknown>): LangfuseSdkSpanClient;
  generation(body: Record<string, unknown>): LangfuseSdkGenerationClient;
}

export interface LangfuseSdkSpanClient {
  update(body: Record<string, unknown>): unknown;
  span(body: Record<string, unknown>): LangfuseSdkSpanClient;
  generation(body: Record<string, unknown>): LangfuseSdkGenerationClient;
}

export interface LangfuseSdkGenerationClient {
  update(body: Record<string, unknown>): unknown;
}

type OtelSpanStart = {
  traceId: string;
  spanId: string;
  name: string;
  startTime: string;
  parentSpanId?: string;
  attributes: JsonObject;
};

type OtelSpan = OtelSpanStart & {
  endTime: string;
  status?: { code: number; message?: string };
};

type OtelAttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

export class LangfuseSdkRuntimeEventExporter implements RuntimeEventExporter {
  private readonly client: LangfuseSdkClient;
  private readonly traces = new Map<string, LangfuseSdkTraceClient>();
  private readonly spans = new Map<string, LangfuseSdkSpanClient>();
  // Keep each start local until its terminal event so Langfuse receives one complete
  // generation-create instead of separate create/update batches that can be merged out of order.
  // A call that never reaches a terminal event is intentionally absent rather than permanently open.
  private readonly pendingGenerations = new Map<string, RuntimeLlmGenerationEvent>();

  constructor(
    private readonly config: LangfuseExporterConfig,
    client?: LangfuseSdkClient,
  ) {
    this.client =
      client ??
      new Langfuse({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        flushAt: config.flushAt,
        flushInterval: config.flushIntervalMs,
        enabled: true,
      });
  }

  async publish(event: RuntimeTelemetryEvent): Promise<void> {
    const redactedEvent = applyTelemetryRedaction(this.config, event);
    if (!redactedEvent?.traceId) {
      return;
    }
    if (isLlmGenerationEvent(redactedEvent)) {
      this.publishLlmGenerationEvent(redactedEvent);
      await this.flushIfTerminalEvent(redactedEvent);
      return;
    }
    if (isToolEvent(redactedEvent)) {
      this.publishToolEvent(redactedEvent);
      await this.flushIfTerminalEvent(redactedEvent);
      return;
    }
    this.publishLifecycleEvent(redactedEvent);
    await this.flushIfTerminalEvent(redactedEvent);
  }

  async flush(): Promise<void> {
    await this.client.flushAsync();
  }

  async close(): Promise<void> {
    await this.client.shutdownAsync();
  }

  private async flushIfTerminalEvent(event: RuntimeTelemetryEvent): Promise<void> {
    if (!isTerminalTelemetryEvent(event)) {
      return;
    }
    try {
      await this.client.flushAsync();
    } catch (error) {
      console.warn(
        `Langfuse telemetry flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private publishLifecycleEvent(event: RuntimeLifecycleEvent): void {
    const traceId = requireTraceId(event.traceId);
    const trace = this.getOrCreateSdkTrace(event);
    const rootKey = chatSpanKey(event);
    const rootSpanId = langfuseSpanId(traceId, rootKey);

    switch (event.type) {
      case 'chat_turn_started': {
        const body = {
          id: rootSpanId,
          name: 'chat-turn',
          startTime: event.createdAt,
          input: event.details?.input,
          level: 'DEFAULT',
          metadata: lifecycleMetadata(event),
        };
        const span = this.spans.get(rootKey);
        if (span) {
          span.update({
            input: event.details?.input,
            level: 'DEFAULT',
            metadata: lifecycleMetadata(event),
          });
        } else {
          this.spans.set(rootKey, trace.span(body));
        }
        break;
      }
      case 'chat_turn_completed':
      case 'chat_turn_failed': {
        const output = event.details?.output ?? (event.error ? { error: event.error } : undefined);
        this.closeSdkSubagentBatchSpans(traceId, event);
        trace.update({
          sessionId: event.sessionId,
          name: 'chat-turn',
          output,
          metadata: lifecycleMetadata(event),
        });
        const span =
          this.spans.get(rootKey) ??
          trace.span({
            id: rootSpanId,
            name: 'chat-turn',
            startTime: event.createdAt,
            metadata: lifecycleMetadata(event),
          });
        span.update({
          output,
          endTime: event.createdAt,
          level: event.error ? 'ERROR' : 'DEFAULT',
          ...(event.error ? { statusMessage: event.error } : {}),
          metadata: lifecycleMetadata(event),
        });
        break;
      }
      case 'chat_turn_steered':
      case 'chat_turn_steer_delivered':
      case 'chat_turn_followup_queued':
      case 'chat_turn_followup_delivered': {
        const output = event.details?.output ?? chatInputLifecycleOutput(event);
        this.getSdkSpanParent(trace, rootKey).span({
          id: langfuseSpanId(traceId, chatInputSpanKey(event)),
          name: chatInputObservationName(event),
          startTime: event.createdAt,
          endTime: event.createdAt,
          input: event.details?.input,
          output,
          level: 'DEFAULT',
          metadata: lifecycleMetadata(event),
        });
        break;
      }
      case 'subagent_spawned':
      case 'subagent_started': {
        const key = subagentSpanKey(event);
        this.ensureSdkRootSpan(trace, rootKey, event);
        const body = {
          id: langfuseSpanId(traceId, key),
          name: subagentObservationName(event),
          startTime: event.createdAt,
          input: event.details?.input,
          level: 'DEFAULT',
          metadata: lifecycleMetadata(event),
        };
        const span = this.spans.get(key);
        if (span) {
          span.update({
            input: event.details?.input,
            level: 'DEFAULT',
            metadata: lifecycleMetadata(event),
          });
        } else {
          this.spans.set(key, this.getSdkSubagentParent(trace, rootKey, event).span(body));
        }
        break;
      }
      case 'subagent_completed':
      case 'subagent_failed':
      case 'subagent_cancelled': {
        const key = subagentSpanKey(event);
        const output = event.details?.output ?? (event.error ? { error: event.error } : undefined);
        this.ensureSdkRootSpan(trace, rootKey, event);
        const span =
          this.spans.get(key) ??
          this.getSdkSubagentParent(trace, rootKey, event).span({
            id: langfuseSpanId(traceId, key),
            name: subagentObservationName(event),
            startTime: event.createdAt,
            metadata: lifecycleMetadata(event),
          });
        span.update({
          output,
          endTime: event.createdAt,
          level: event.error ? 'ERROR' : 'DEFAULT',
          ...(event.error ? { statusMessage: event.error } : {}),
          metadata: lifecycleMetadata(event),
        });
        break;
      }
      default:
        assertNever(event.type);
    }
  }

  private publishToolEvent(event: RuntimeToolEvent): void {
    const traceId = requireTraceId(event.traceId);
    const trace = this.getOrCreateSdkTrace(event);
    const rootKey = chatSpanKey(event);
    const parent = this.getSdkEventParent(trace, rootKey, event);
    const key = toolSpanKey(event);
    const id = langfuseSpanId(traceId, key);

    if (event.status === 'started') {
      const body = {
        id,
        name: toolObservationName(event),
        startTime: event.createdAt,
        input: event.args ? { args: event.args } : undefined,
        level: 'DEFAULT',
        metadata: toolMetadata(event),
      };
      const span = this.spans.get(key);
      if (span) {
        span.update({
          input: event.args ? { args: event.args } : undefined,
          level: 'DEFAULT',
          metadata: toolMetadata(event),
        });
      } else {
        this.spans.set(key, parent.span(body));
      }
      return;
    }

    const output = event.error ? { error: event.error } : (event.details ?? {});
    const span =
      this.spans.get(key) ??
      parent.span({
        id,
        name: toolObservationName(event),
        startTime: event.createdAt,
        metadata: toolMetadata(event),
      });
    span.update({
      output,
      endTime: event.createdAt,
      level: event.error ? 'ERROR' : 'DEFAULT',
      ...(event.error ? { statusMessage: event.error } : {}),
      metadata: toolMetadata(event),
    });
    this.spans.delete(key);
  }

  private publishLlmGenerationEvent(event: RuntimeLlmGenerationEvent): void {
    const traceId = requireTraceId(event.traceId);
    const key = llmGenerationKey(event);

    if (event.status === 'started') {
      this.pendingGenerations.set(key, event);
      return;
    }

    const started = this.pendingGenerations.get(key);
    const trace = this.getOrCreateSdkTrace(event);
    const rootKey = chatSpanKey(event);
    const parent = this.getSdkEventParent(trace, rootKey, event);
    parent.generation({
      id: langfuseSpanId(traceId, key),
      name: llmGenerationObservationName(started ?? event),
      startTime: started?.createdAt ?? event.createdAt,
      input: started?.input,
      output: event.output ?? (event.error ? { error: event.error } : undefined),
      endTime: event.createdAt,
      level: event.error ? 'ERROR' : 'DEFAULT',
      ...(event.error ? { statusMessage: event.error } : {}),
      ...(event.usage
        ? { usage: toLangfuseUsage(event.usage), usageDetails: toLangfuseUsageDetails(event.usage) }
        : {}),
      model: event.model.model,
      modelParameters: {
        provider: event.model.provider,
        ...(event.model.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
      },
      metadata: llmGenerationMetadata(event),
    });
    this.pendingGenerations.delete(key);
  }

  private getOrCreateSdkTrace(event: RuntimeTelemetryEvent): LangfuseSdkTraceClient {
    const traceId = requireTraceId(event.traceId);
    const existing = this.traces.get(traceId);
    if (existing) {
      return existing;
    }
    const eventMetadata = isToolEvent(event)
      ? toolMetadata(event)
      : isLlmGenerationEvent(event)
        ? llmGenerationMetadata(event)
        : lifecycleMetadata(event);
    const trace = this.client.trace({
      id: langfuseTraceId(traceId),
      sessionId: event.sessionId,
      name: 'chat-turn',
      timestamp: event.createdAt,
      input: !isToolEvent(event) && !isLlmGenerationEvent(event) ? event.details?.input : undefined,
      ...(this.config.serviceName ? { tags: [this.config.serviceName] } : {}),
      metadata: {
        ...(this.config.serviceName ? { serviceName: this.config.serviceName } : {}),
        ...eventMetadata,
      },
    });
    this.traces.set(traceId, trace);
    return trace;
  }

  private getSdkSpanParent(
    trace: LangfuseSdkTraceClient,
    rootKey: string,
  ): LangfuseSdkTraceClient | LangfuseSdkSpanClient {
    return this.spans.get(rootKey) ?? trace;
  }

  private getSdkEventParent(
    trace: LangfuseSdkTraceClient,
    rootKey: string,
    event: RuntimeToolEvent | RuntimeLlmGenerationEvent,
  ): LangfuseSdkTraceClient | LangfuseSdkSpanClient {
    const subagentKey = telemetryEventSubagentSpanKey(event);
    if (subagentKey) {
      return this.spans.get(subagentKey) ?? this.getSdkSpanParent(trace, rootKey);
    }
    return this.getSdkSpanParent(trace, rootKey);
  }

  private getSdkSubagentParent(
    trace: LangfuseSdkTraceClient,
    rootKey: string,
    event: RuntimeLifecycleEvent,
  ): LangfuseSdkSpanClient {
    const rootSpan = this.ensureSdkRootSpan(trace, rootKey, event);
    const batchKey = subagentBatchSpanKey(event);
    if (batchKey) {
      const existing = this.spans.get(batchKey);
      if (existing) {
        return existing;
      }
      const batchSpan = rootSpan.span({
        id: langfuseSpanId(requireTraceId(event.traceId), batchKey),
        name: 'subagent fan-out',
        startTime: event.createdAt,
        input: event.details?.input,
        level: 'DEFAULT',
        metadata: lifecycleMetadata(event),
      });
      this.spans.set(batchKey, batchSpan);
      return batchSpan;
    }
    const spawnToolKey = subagentSpawnToolSpanKey(event);
    return (spawnToolKey ? this.spans.get(spawnToolKey) : undefined) ?? rootSpan;
  }

  private closeSdkSubagentBatchSpans(traceId: string, event: RuntimeLifecycleEvent): void {
    const prefix = `subagent-batch:${traceId}:`;
    for (const [key, span] of [...this.spans.entries()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      span.update({
        endTime: event.createdAt,
        level: event.error ? 'ERROR' : 'DEFAULT',
        ...(event.error ? { statusMessage: event.error } : {}),
        metadata: lifecycleMetadata(event),
      });
    }
  }

  private ensureSdkRootSpan(
    trace: LangfuseSdkTraceClient,
    rootKey: string,
    event: RuntimeTelemetryEvent,
  ): LangfuseSdkSpanClient {
    const existing = this.spans.get(rootKey);
    if (existing) {
      return existing;
    }
    const traceId = requireTraceId(event.traceId);
    const span = trace.span({
      id: langfuseSpanId(traceId, rootKey),
      name: 'chat-turn',
      startTime: event.createdAt,
      metadata: isToolEvent(event)
        ? toolMetadata(event)
        : isLlmGenerationEvent(event)
          ? llmGenerationMetadata(event)
          : lifecycleMetadata(event),
    });
    this.spans.set(rootKey, span);
    return span;
  }
}

export class OtelRuntimeEventExporter implements RuntimeEventExporter {
  private readonly endpoint: string;
  private readonly fetchImpl: LangfuseFetch;
  private readonly pendingStarts = new Map<string, OtelSpanStart>();
  private readonly queue: OtelSpan[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly config: OtelExporterConfig,
    fetchImpl?: LangfuseFetch,
  ) {
    this.endpoint = normalizeOtelTracesEndpoint(config.endpoint);
    this.fetchImpl =
      fetchImpl ??
      (async (input, init) => {
        const response = await fetch(input, init);
        return {
          ok: response.ok,
          status: response.status,
          text: () => response.text(),
        };
      });
  }

  async publish(event: RuntimeTelemetryEvent): Promise<void> {
    const redactedEvent = applyTelemetryRedaction(this.config, event);
    if (!redactedEvent) {
      return;
    }
    for (const span of mapRuntimeEventToOtelSpans(redactedEvent, this.pendingStarts)) {
      this.queue.push(span);
    }
    if (this.queue.length === 0) {
      return;
    }
    if (this.queue.length >= this.config.flushAt) {
      await this.flush();
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const spans = this.queue.splice(0, this.queue.length);
    if (spans.length === 0) {
      return;
    }
    this.flushing = this.sendSpans(spans)
      .catch((error) => {
        this.queue.unshift(...spans);
        throw error;
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, this.config.flushIntervalMs);
    this.flushTimer.unref();
  }

  private async sendSpans(spans: OtelSpan[]): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(toOtelTracePayload(spans, this.config)),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `${this.config.errorLabel ?? 'OTEL export'} failed with ${response.status}${text ? `: ${text}` : ''}`,
      );
    }
  }
}

export function createRuntimeEventExporterFromEnv(env: TelemetryEnvironment): RuntimeEventExporter {
  const config = resolveLangfuseConfig(env);
  if (!config.enabled) {
    return new NoopRuntimeEventExporter();
  }
  return new LangfuseSdkRuntimeEventExporter(config);
}

export function createLangfuseExporter(telemetryConfig: TelemetryConfig): RuntimeEventExporter {
  const config = resolveLangfuseExporterConfig(telemetryConfig);
  if (!config.enabled) {
    return new NoopRuntimeEventExporter();
  }
  return new LangfuseSdkRuntimeEventExporter(config);
}

export function resolveLangfuseExporterConfig(
  telemetryConfig: TelemetryConfig,
): LangfuseExporterConfig {
  const lf = telemetryConfig.langfuse;
  const publicKey = lf?.publicKey ?? '';
  const secretKey = lf?.secretKey ?? '';
  const credentialsPresent = Boolean(publicKey && secretKey);
  return {
    enabled: Boolean(lf?.enabled && credentialsPresent),
    publicKey,
    secretKey,
    baseUrl: lf?.baseUrl ?? DEFAULT_LANGFUSE_BASE_URL,
    flushAt: lf?.flushAt ?? DEFAULT_FLUSH_AT,
    flushIntervalMs: lf?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    serviceName: telemetryConfig.serviceName ?? 'pi-server',
    ...(telemetryConfig.serviceVersion ? { serviceVersion: telemetryConfig.serviceVersion } : {}),
    includePayloads: telemetryConfig.includePayloads ?? false,
  };
}

export function resolveLangfuseConfig(env: TelemetryEnvironment): LangfuseExporterConfig {
  const enabled = parseBoolean(env.LANGFUSE_ENABLED);
  const publicKey = trim(env.LANGFUSE_PUBLIC_KEY);
  const secretKey = trim(env.LANGFUSE_SECRET_KEY);
  const baseUrl = trim(env.LANGFUSE_BASE_URL) ?? DEFAULT_LANGFUSE_BASE_URL;
  const credentialsPresent = Boolean(publicKey && secretKey);
  const serviceVersion = trim(env.TELEMETRY_SERVICE_VERSION);
  return {
    enabled: Boolean(enabled && credentialsPresent),
    publicKey: publicKey ?? '',
    secretKey: secretKey ?? '',
    baseUrl,
    flushAt: parsePositiveInteger(env.LANGFUSE_FLUSH_AT, DEFAULT_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(
      env.LANGFUSE_FLUSH_INTERVAL_MS,
      DEFAULT_FLUSH_INTERVAL_MS,
    ),
    serviceName: trim(env.TELEMETRY_SERVICE_NAME ?? env.OTEL_SERVICE_NAME) ?? 'pi-server',
    ...(serviceVersion ? { serviceVersion } : {}),
    includePayloads: parseBooleanWithDefault(
      env.TELEMETRY_INCLUDE_PAYLOADS ?? env.LANGFUSE_INCLUDE_PAYLOADS,
      false,
    ),
  };
}

function mapRuntimeEventToOtelSpans(
  event: RuntimeTelemetryEvent,
  pendingStarts: Map<string, OtelSpanStart>,
): OtelSpan[] {
  if (!event.traceId) {
    return [];
  }
  if (isLlmGenerationEvent(event)) {
    return mapLlmGenerationEventToOtelSpans(event, pendingStarts);
  }
  return isToolEvent(event)
    ? mapToolEventToOtelSpans(event, pendingStarts)
    : mapLifecycleEventToOtelSpans(event, pendingStarts);
}

function mapLifecycleEventToOtelSpans(
  event: RuntimeLifecycleEvent,
  pendingStarts: Map<string, OtelSpanStart>,
): OtelSpan[] {
  const traceId = requireTraceId(event.traceId);
  const rootKey = chatSpanKey(event);
  const rootSpanId = langfuseSpanId(traceId, rootKey);
  switch (event.type) {
    case 'chat_turn_started':
      pendingStarts.set(rootKey, {
        traceId: langfuseTraceId(traceId),
        spanId: rootSpanId,
        name: 'chat-turn',
        startTime: event.createdAt,
        attributes: {
          ...lifecycleMetadata(event),
          ...langfuseObservationAttributes({ input: event.details?.input, level: 'DEFAULT' }),
          ...langfuseTraceAttributes({ input: event.details?.input }),
        },
      });
      return [];
    case 'chat_turn_completed':
    case 'chat_turn_failed':
      return [
        completeOtelSpan(
          pendingStarts,
          rootKey,
          {
            traceId: langfuseTraceId(traceId),
            spanId: rootSpanId,
            name: 'chat-turn',
            startTime: event.createdAt,
            attributes: {
              ...lifecycleMetadata(event),
              ...langfuseObservationAttributes({
                output: event.details?.output ?? (event.error ? { error: event.error } : undefined),
                level: event.error ? 'ERROR' : 'DEFAULT',
              }),
              ...langfuseTraceAttributes({
                output: event.details?.output ?? (event.error ? { error: event.error } : undefined),
              }),
            },
          },
          event.createdAt,
          event.error,
        ),
      ];
    case 'chat_turn_steered':
    case 'chat_turn_steer_delivered':
    case 'chat_turn_followup_queued':
    case 'chat_turn_followup_delivered':
      return [
        {
          traceId: langfuseTraceId(traceId),
          spanId: langfuseSpanId(traceId, chatInputSpanKey(event)),
          parentSpanId: rootSpanId,
          name: chatInputObservationName(event),
          startTime: event.createdAt,
          endTime: event.createdAt,
          attributes: {
            ...lifecycleMetadata(event),
            ...langfuseObservationAttributes({
              input: event.details?.input,
              output: event.details?.output ?? chatInputLifecycleOutput(event),
              level: 'DEFAULT',
            }),
          },
        },
      ];
    case 'subagent_spawned':
    case 'subagent_started': {
      const key = subagentSpanKey(event);
      pendingStarts.set(key, {
        traceId: langfuseTraceId(traceId),
        spanId: langfuseSpanId(traceId, key),
        parentSpanId: langfuseSpanId(traceId, subagentSpawnToolSpanKey(event) ?? rootKey),
        name: subagentObservationName(event),
        startTime: event.createdAt,
        attributes: {
          ...lifecycleMetadata(event),
          ...langfuseObservationAttributes({ input: event.details?.input, level: 'DEFAULT' }),
        },
      });
      return [];
    }
    case 'subagent_completed':
    case 'subagent_failed':
    case 'subagent_cancelled': {
      const key = subagentSpanKey(event);
      return [
        completeOtelSpan(
          pendingStarts,
          key,
          {
            traceId: langfuseTraceId(traceId),
            spanId: langfuseSpanId(traceId, key),
            parentSpanId: langfuseSpanId(traceId, subagentSpawnToolSpanKey(event) ?? rootKey),
            name: subagentObservationName(event),
            startTime: event.createdAt,
            attributes: {
              ...lifecycleMetadata(event),
              ...langfuseObservationAttributes({
                output: event.details?.output ?? (event.error ? { error: event.error } : undefined),
                level: event.error ? 'ERROR' : 'DEFAULT',
              }),
            },
          },
          event.createdAt,
          event.error,
        ),
      ];
    }
    default:
      return assertNever(event.type);
  }
}

function mapToolEventToOtelSpans(
  event: RuntimeToolEvent,
  pendingStarts: Map<string, OtelSpanStart>,
): OtelSpan[] {
  const traceId = requireTraceId(event.traceId);
  const key = toolSpanKey(event);
  const fallbackStart: OtelSpanStart = {
    traceId: langfuseTraceId(traceId),
    spanId: langfuseSpanId(traceId, key),
    parentSpanId: langfuseParentObservationId(traceId, event),
    name: toolObservationName(event),
    startTime: event.createdAt,
    attributes: {
      ...toolMetadata(event),
      ...langfuseObservationAttributes({
        output: event.error ? { error: event.error } : event.details,
        level: event.error ? 'ERROR' : 'DEFAULT',
      }),
    },
  };
  if (event.status === 'started') {
    pendingStarts.set(key, {
      ...fallbackStart,
      attributes: {
        ...fallbackStart.attributes,
        ...(event.args ? { args: event.args } : {}),
        ...langfuseObservationAttributes({ input: event.args, level: 'DEFAULT' }),
      },
    });
    return [];
  }
  return [completeOtelSpan(pendingStarts, key, fallbackStart, event.createdAt, event.error)];
}

function mapLlmGenerationEventToOtelSpans(
  event: RuntimeLlmGenerationEvent,
  pendingStarts: Map<string, OtelSpanStart>,
): OtelSpan[] {
  const traceId = requireTraceId(event.traceId);
  const key = llmGenerationKey(event);
  const fallbackStart: OtelSpanStart = {
    traceId: langfuseTraceId(traceId),
    spanId: langfuseSpanId(traceId, key),
    parentSpanId: langfuseParentObservationId(traceId, event),
    name: llmGenerationObservationName(event),
    startTime: event.createdAt,
    attributes: {
      ...llmGenerationMetadata(event),
      'langfuse.observation.type': 'generation',
      model: event.model.model,
      provider: event.model.provider,
      ...(event.model.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
      ...langfuseObservationAttributes({
        output: event.output ?? (event.error ? { error: event.error } : undefined),
        level: event.error ? 'ERROR' : 'DEFAULT',
      }),
      ...(event.usage ? flattenUsageAttributes(event.usage) : {}),
    },
  };
  if (event.status === 'started') {
    pendingStarts.set(key, {
      ...fallbackStart,
      attributes: {
        ...fallbackStart.attributes,
        ...langfuseObservationAttributes({ input: event.input, level: 'DEFAULT' }),
      },
    });
    return [];
  }
  return [completeOtelSpan(pendingStarts, key, fallbackStart, event.createdAt, event.error)];
}

function completeOtelSpan(
  pendingStarts: Map<string, OtelSpanStart>,
  key: string,
  fallbackStart: OtelSpanStart,
  endTime: string,
  error?: string,
): OtelSpan {
  const started = pendingStarts.get(key) ?? fallbackStart;
  pendingStarts.delete(key);
  return {
    ...started,
    endTime: ensureEndAfterStart(started.startTime, endTime),
    attributes: {
      ...started.attributes,
      ...fallbackStart.attributes,
    },
    ...(error ? { status: { code: 2, message: error } } : { status: { code: 1 } }),
  };
}

function langfuseObservationAttributes(input: {
  input?: JsonValue | undefined;
  output?: JsonValue | undefined;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
}): JsonObject {
  return {
    'langfuse.observation.type': 'span',
    ...(input.input !== undefined
      ? {
          'langfuse.observation.input': toLangfuseObservationPayload(input.input),
          'input.value': toLangfuseObservationPayload(input.input),
        }
      : {}),
    ...(input.output !== undefined
      ? {
          'langfuse.observation.output': toLangfuseObservationPayload(input.output),
          'output.value': toLangfuseObservationPayload(input.output),
        }
      : {}),
    ...(input.level ? { 'langfuse.observation.level': input.level } : {}),
  };
}

function langfuseTraceAttributes(input: {
  input?: JsonValue | undefined;
  output?: JsonValue | undefined;
}): JsonObject {
  return {
    ...(input.input !== undefined
      ? { 'langfuse.trace.input': toLangfuseTracePayload(input.input) }
      : {}),
    ...(input.output !== undefined
      ? { 'langfuse.trace.output': toLangfuseTracePayload(input.output) }
      : {}),
  };
}

function toLangfuseObservationPayload(value: JsonValue): string {
  return JSON.stringify(value);
}

function toLangfuseTracePayload(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function chatSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'sessionId' | 'conversationId' | 'parentSessionId'>,
): string {
  const sessionId = event.parentSessionId ?? event.sessionId;
  const conversationId = event.parentSessionId ?? event.conversationId ?? sessionId;
  return `chat:${sessionId}:${conversationId}`;
}

function chatInputSpanKey(event: Pick<RuntimeLifecycleEvent, 'id' | 'sessionId'>): string {
  return `chat-input:${event.sessionId}:${event.id}`;
}

function subagentSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'runId' | 'childSessionId' | 'id'>,
): string {
  return `subagent:${event.runId ?? event.childSessionId ?? event.id}`;
}

function subagentBatchSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'traceId' | 'spawnBatchId' | 'details'>,
): string | undefined {
  const batchId = event.spawnBatchId ?? stringFromJsonObject(event.details, 'spawnBatchId');
  return event.traceId && batchId ? `subagent-batch:${event.traceId}:${batchId}` : undefined;
}

function telemetryEventSubagentSpanKey(
  event: Pick<RuntimeToolEvent | RuntimeLlmGenerationEvent, 'runId' | 'childSessionId'>,
): string | undefined {
  return event.runId || event.childSessionId
    ? `subagent:${event.runId ?? event.childSessionId}`
    : undefined;
}

function langfuseParentObservationId(
  traceId: string,
  event: RuntimeToolEvent | RuntimeLlmGenerationEvent,
): string {
  const subagentKey = telemetryEventSubagentSpanKey(event);
  return langfuseSpanId(traceId, subagentKey ?? chatSpanKey(event));
}

function toolSpanKey(
  event: Pick<RuntimeToolEvent, 'sessionId' | 'toolCallId' | 'toolName'>,
): string {
  return `tool:${event.sessionId}:${event.toolCallId}:${event.toolName}`;
}

function subagentSpawnToolSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'parentSessionId' | 'parentToolCallId'>,
): string | undefined {
  return event.parentSessionId && event.parentToolCallId
    ? `tool:${event.parentSessionId}:${event.parentToolCallId}:sessions_spawn`
    : undefined;
}

function llmGenerationKey(
  event: Pick<RuntimeLlmGenerationEvent, 'sessionId' | 'llmGenerationId'>,
): string {
  return `llm-generation:${event.sessionId}:${event.llmGenerationId}`;
}

function toolObservationName(event: Pick<RuntimeToolEvent, 'toolName' | 'args'>): string {
  const summary = summarizeToolArgsForName(event.toolName, event.args);
  return summary ? `${event.toolName} [${summary}]` : event.toolName;
}

function chatInputObservationName(event: RuntimeLifecycleEvent): string {
  const prefix = chatInputObservationPrefix(event.type);
  const input =
    typeof event.details?.input === 'string'
      ? truncateObservationSummary(event.details.input)
      : undefined;
  return input ? `${prefix} [${input}]` : prefix;
}

function chatInputObservationPrefix(type: RuntimeLifecycleEvent['type']): string {
  if (type === 'chat_turn_steered') {
    return 'chat-steer';
  }
  if (type === 'chat_turn_steer_delivered') {
    return 'chat-steer-delivered';
  }
  if (type === 'chat_turn_followup_delivered') {
    return 'chat-followup-delivered';
  }
  return 'chat-followup';
}

function chatInputLifecycleOutput(event: RuntimeLifecycleEvent): JsonObject {
  return event.type === 'chat_turn_steer_delivered' || event.type === 'chat_turn_followup_delivered'
    ? { delivered: true, turnMode: event.details?.turnMode }
    : { accepted: true, turnMode: event.details?.turnMode };
}

function subagentObservationName(event: RuntimeLifecycleEvent): string {
  const agent = stringFromJsonObject(event.details, 'agent');
  return agent ? `subagent [${truncateObservationSummary(agent)}]` : 'subagent';
}

function summarizeToolArgsForName(
  toolName: string,
  args: JsonObject | undefined,
): string | undefined {
  if (!args) {
    return undefined;
  }
  const pathValue =
    stringArg(args, 'path') ?? stringArg(args, 'filePath') ?? stringArg(args, 'absolutePath');
  if (pathValue) {
    return truncateObservationSummary(pathValue);
  }
  const command = stringArg(args, 'command');
  if (command) {
    return truncateObservationSummary(command);
  }
  const query = stringArg(args, 'query');
  if (query) {
    return truncateObservationSummary(query);
  }
  const task = stringArg(args, 'task');
  if (task && toolName === 'sessions_spawn') {
    return truncateObservationSummary(task);
  }
  const code = stringArg(args, 'code');
  if (code) {
    return truncateObservationSummary(code);
  }
  const name = stringArg(args, 'name');
  if (name && toolName.startsWith('mcp_')) {
    return truncateObservationSummary(name);
  }
  return undefined;
}

function llmGenerationObservationName(
  event: Pick<RuntimeLlmGenerationEvent, 'input' | 'runId' | 'childSessionId'>,
): string {
  return `llm-generation [${event.runId || event.childSessionId ? 'subagent' : 'main'}] [${summarizeLlmGenerationInputForName(event.input)}]`;
}

function summarizeLlmGenerationInputForName(input: JsonValue | undefined): string {
  if (typeof input === 'string') {
    return truncateObservationSummary(input);
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const continuation = input.continuation === true;
    const index =
      typeof input.llmGenerationIndex === 'number' ? input.llmGenerationIndex : undefined;
    const toolResults =
      typeof input.previousToolResultCount === 'number' ? input.previousToolResultCount : undefined;
    if (continuation) {
      return truncateObservationSummary(
        `continuation${index !== undefined ? ` #${index}` : ''}${toolResults !== undefined ? ` after ${toolResults} tool result(s)` : ''}`,
      );
    }
  }
  return 'request';
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringFromJsonObject(value: JsonObject | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function truncateObservationSummary(value: string, maxLength = 90): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function ensureEndAfterStart(startTime: string, endTime: string): string {
  return Date.parse(endTime) >= Date.parse(startTime) ? endTime : startTime;
}

function toOtelTracePayload(
  spans: OtelSpan[],
  config: Pick<LangfuseExporterConfig, 'serviceName' | 'serviceVersion'>,
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            otelAttribute('service.name', config.serviceName ?? 'pi-server'),
            ...(config.serviceVersion
              ? [otelAttribute('service.version', config.serviceVersion)]
              : []),
            otelAttribute('telemetry.sdk.name', '@amaster.ai/pi-telemetry'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: '@amaster.ai/pi-telemetry', version: '0.1.0' },
            spans: spans.map(toOtelSpanPayload),
          },
        ],
      },
    ],
  };
}

function toOtelSpanPayload(span: OtelSpan): JsonObject {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: toUnixNano(span.startTime),
    endTimeUnixNano: toUnixNano(span.endTime),
    attributes: Object.entries(span.attributes)
      .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
      .map(([key, value]) => otelAttribute(key, value)),
    ...(span.status ? { status: span.status } : {}),
  };
}

function otelAttribute(key: string, value: JsonValue): JsonObject {
  return { key, value: otelAttributeValue(value) };
}

function otelAttributeValue(value: JsonValue): OtelAttributeValue {
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  return { stringValue: JSON.stringify(value) };
}

function toUnixNano(iso: string): string {
  const millis = Date.parse(iso);
  return String(BigInt(Number.isFinite(millis) ? millis : Date.now()) * 1_000_000n);
}

function normalizeOtelTracesEndpoint(endpoint: string): string {
  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

function shortCorrelationId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.startsWith('trace:') ? value.slice('trace:'.length) : value;
  const uuid = normalized.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];
  if (uuid) {
    return uuid.slice(0, 8);
  }
  if (/^[0-9a-f]{32}$/i.test(normalized)) {
    return normalized.slice(0, 8);
  }
  return normalized.length > 24 ? normalized.slice(0, 12) : normalized;
}

function compactSessionId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [root, ...subagents] = value.split(':subagent:');
  if (subagents.length === 0) {
    return value;
  }
  return [
    root,
    ...subagents.map((sessionId) => `sub:${shortCorrelationId(sessionId) ?? sessionId}`),
  ].join('/');
}

function lineageMetadata(event: {
  sessionId: string;
  conversationId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  taskRunId?: string;
  spawnBatchId?: string;
}): JsonObject {
  const sessionId = compactSessionId(event.sessionId);
  const conversationId = compactSessionId(event.conversationId);
  const taskRunId = event.taskRunId ?? shortCorrelationId(event.runId);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId && conversationId !== sessionId ? { conversationId } : {}),
    ...(event.parentSessionId ? { parentSessionId: compactSessionId(event.parentSessionId) } : {}),
    ...(event.childSessionId ? { childSessionId: compactSessionId(event.childSessionId) } : {}),
    ...(taskRunId ? { taskRunId } : {}),
    ...(event.spawnBatchId ? { spawnBatchId: shortCorrelationId(event.spawnBatchId) } : {}),
  };
}

function lifecycleMetadata(event: RuntimeLifecycleEvent): JsonObject {
  return {
    eventType: event.type,
    ...lineageMetadata(event),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.model ? { model: `${event.model.provider}/${event.model.model}` } : {}),
    ...(event.model?.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
    ...(event.toolPolicyProfile ? { toolPolicyProfile: event.toolPolicyProfile } : {}),
    ...(event.details ? { details: event.details } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function toolMetadata(event: RuntimeToolEvent): JsonObject {
  return {
    ...lineageMetadata(event),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.details ? { details: event.details } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function llmGenerationMetadata(event: RuntimeLlmGenerationEvent): JsonObject {
  return {
    ...lineageMetadata(event),
    llmGenerationId: event.llmGenerationId,
    status: event.status,
    model: `${event.model.provider}/${event.model.model}`,
    ...(event.model.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.responseId ? { responseId: event.responseId } : {}),
    ...(event.stopReason ? { stopReason: event.stopReason } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function toLangfuseUsage(usage: RuntimeLlmUsage): JsonObject {
  return {
    ...(usage.input !== undefined ? { input: usage.input } : {}),
    ...(usage.output !== undefined ? { output: usage.output } : {}),
    ...(usage.totalTokens !== undefined ? { total: usage.totalTokens } : {}),
    unit: 'TOKENS',
    ...(usage.cost?.input !== undefined ? { inputCost: usage.cost.input } : {}),
    ...(usage.cost?.output !== undefined ? { outputCost: usage.cost.output } : {}),
    ...(usage.cost?.total !== undefined ? { totalCost: usage.cost.total } : {}),
  };
}

function toLangfuseUsageDetails(usage: RuntimeLlmUsage): JsonObject {
  return {
    ...(usage.input !== undefined ? { input: usage.input } : {}),
    ...(usage.output !== undefined ? { output: usage.output } : {}),
    ...(usage.cacheRead !== undefined ? { cache_read: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cache_write: usage.cacheWrite } : {}),
    ...(usage.totalTokens !== undefined ? { total: usage.totalTokens } : {}),
  };
}

function flattenUsageAttributes(usage: RuntimeLlmUsage): JsonObject {
  return {
    ...(usage.input !== undefined ? { 'usage.input': usage.input } : {}),
    ...(usage.output !== undefined ? { 'usage.output': usage.output } : {}),
    ...(usage.cacheRead !== undefined ? { 'usage.cache_read': usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { 'usage.cache_write': usage.cacheWrite } : {}),
    ...(usage.totalTokens !== undefined ? { 'usage.total_tokens': usage.totalTokens } : {}),
    ...(usage.cost?.total !== undefined ? { 'usage.cost.total': usage.cost.total } : {}),
  };
}

function langfuseTraceId(traceId: string): string {
  return stableHex(`trace:${traceId}`, 32);
}

function langfuseSpanId(traceId: string, key: string): string {
  return stableHex(`span:${traceId}:${key}`, 16);
}

function stableHex(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function applyTelemetryRedaction(
  config: Pick<LangfuseExporterConfig, 'includePayloads' | 'redactEvent'>,
  event: RuntimeTelemetryEvent,
): RuntimeTelemetryEvent | undefined {
  const redacted = config.redactEvent ? config.redactEvent(event) : event;
  if (!redacted) {
    return undefined;
  }
  return config.includePayloads === false ? stripTelemetryPayloads(redacted) : redacted;
}

function stripTelemetryPayloads(event: RuntimeTelemetryEvent): RuntimeTelemetryEvent {
  if (isLlmGenerationEvent(event)) {
    const { input: _input, output: _output, error: _error, ...rest } = event;
    return rest as RuntimeTelemetryEvent;
  }
  if (isToolEvent(event)) {
    const { args: _args, details: _details, error: _error, ...rest } = event;
    return rest as RuntimeTelemetryEvent;
  }
  const { details: _details, error: _error, ...rest } = event;
  return rest as RuntimeTelemetryEvent;
}

function isToolEvent(event: RuntimeTelemetryEvent): event is RuntimeToolEvent {
  return 'toolCallId' in event;
}

function isLlmGenerationEvent(event: RuntimeTelemetryEvent): event is RuntimeLlmGenerationEvent {
  return 'llmGenerationId' in event;
}

function isTerminalTelemetryEvent(event: RuntimeTelemetryEvent): boolean {
  if (isToolEvent(event) || isLlmGenerationEvent(event)) {
    return event.status !== 'started';
  }
  switch (event.type) {
    case 'chat_turn_started':
    case 'subagent_spawned':
    case 'subagent_started':
      return false;
    case 'chat_turn_steered':
    case 'chat_turn_steer_delivered':
    case 'chat_turn_followup_queued':
    case 'chat_turn_followup_delivered':
    case 'chat_turn_completed':
    case 'chat_turn_failed':
    case 'subagent_completed':
    case 'subagent_failed':
    case 'subagent_cancelled':
      return true;
    default:
      assertNever(event.type);
  }
}

function parseBoolean(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes';
}

function parseBooleanWithDefault(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return parseBoolean(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected telemetry event type: ${String(value)}`);
}

function requireTraceId(traceId: string | undefined): string {
  if (!traceId) {
    throw new Error('Telemetry event is missing traceId');
  }
  return traceId;
}
