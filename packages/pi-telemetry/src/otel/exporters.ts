import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  JsonObject,
  JsonValue,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseSpan } from '@langfuse/tracing';
import {
  type Attributes,
  type AttributeValue,
  type Context,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type IdGenerator,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { stringList } from '../config.js';
import type {
  RuntimeEventExporter,
  RuntimeLlmStreamEvent,
  RuntimeTelemetryEvent,
  TelemetryRequestContext,
} from '../index.js';
import {
  chatInputLifecycleOutput,
  chatInputObservationName,
  chatSpanKey,
  langfuseObservationAttributes,
  llmGenerationKey,
  llmGenerationObservationName,
  subagentObservationName,
  subagentSpanKey,
  telemetryEventSubagentSpanKey,
  toolObservationName,
  toolSpanKey,
} from '../langfuse/mapping.js';
import {
  langfuseTraceId,
  langfuseUsageAttributes,
  lifecycleMetadata,
  lineageMetadata,
  llmGenerationMetadata,
  toolMetadata,
} from '../langfuse/metadata.js';
import { FILTERABLE_METADATA_KEYS } from '../langfuse/types.js';
import { parsePositiveInteger } from '../parse.js';
import { createPhoenixSpanExporter } from '../phoenix/exporter.js';
import {
  DEFAULT_FLUSH_AT,
  DEFAULT_FLUSH_INTERVAL_MS,
  MAX_CLOSE_MS,
  MAX_STATUS_MESSAGE_CHARS,
  type OtelExporterConfig,
} from './types.js';
import {
  applyTelemetryRedaction,
  assertNever,
  isLlmGenerationEvent,
  isLlmStreamEvent,
  isToolEvent,
  normalizeOtelTracesEndpoint,
  redactTelemetryValue,
  requireTraceId,
  shortCorrelationId,
  truncateAttributePayload,
} from './utils.js';

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXPORT_TIMEOUT_MS = 15_000;
// Open spans retain their start attributes until the terminal event arrives;
// cap the map so a leaky producer cannot grow memory without bound.
const MAX_OPEN_SPANS = 512;

// Env var carrying the W3C traceparent of the nearest ancestor span, so a
// nested pi process (spawned via the bash tool) can parent its spans to it.
const TRACEPARENT_ENV = 'PI_TELEMETRY_TRACEPARENT';

// Lets a root span reuse the trace id the runtime already assigned to the
// event (hashed to 32 hex), so the whole tree shares one trace id. Set
// `nextTraceId` immediately before creating a parentless span; it is consumed
// once. Spans with a parent derive their trace id from the parent context and
// never consult the generator.
export class TelemetryIdGenerator implements IdGenerator {
  nextTraceId: string | undefined;

  generateTraceId(): string {
    const next = this.nextTraceId;
    this.nextTraceId = undefined;
    return next && /^[0-9a-f]{32}$/i.test(next) ? next : randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }
}

// Transport is the official OpenTelemetry SDK: a BasicTracerProvider with one
// span processor per destination. The Langfuse processor wraps a
// BatchSpanProcessor + OTLPTraceExporter with Langfuse auth; the generic OTEL
// path is a plain BatchSpanProcessor + OTLPTraceExporter. Queueing, batching,
// retry with backoff, and bounded request timeouts belong to the SDK — this
// class only translates runtime events into span start/end calls.
export class OtelRuntimeEventExporter implements RuntimeEventExporter {
  private readonly config: OtelExporterConfig;
  private readonly provider: BasicTracerProvider;
  private readonly tracer: Tracer;
  private readonly idGenerator = new TelemetryIdGenerator();
  private readonly openSpans = new Map<string, LangfuseSpan>();
  private readonly launchContexts = new WeakMap<LangfuseSpan, Record<string, string>>();
  private openSpanCapWarned = false;
  private exportFailures = new Set<string>();
  private rejectedSpans = new Map<string, number | string>();
  private flushFailed = false;
  private state = 'ready';
  private requestContext: TelemetryRequestContext = {};

  constructor(config: OtelExporterConfig, opts?: { provider?: BasicTracerProvider }) {
    this.config = normalizeExporterConfig(config);
    const labels = Object.fromEntries(
      [
        'serviceName',
        'serviceVersion',
        'userId',
        'environment',
        'release',
        'traceName',
        'tags',
      ].map((key) => [key, this.config[key as keyof OtelExporterConfig]]),
    );
    Object.assign(this.config, redactTelemetryValue({ ...this.config, redactFields: [] }, labels));
    this.provider =
      opts?.provider ??
      buildTracerProvider(
        this.config,
        this.idGenerator,
        (destination, succeeded, rejectedSpans) => {
          if (rejectedSpans !== undefined) {
            if (rejectedSpans) this.rejectedSpans.set(destination, rejectedSpans);
            else this.rejectedSpans.delete(destination);
          }
          if (rejectedSpans) {
            console.error(`[pi-telemetry] ${destination} rejected ${rejectedSpans} span(s)`);
          }
          if (succeeded) this.exportFailures.delete(destination);
          else {
            this.exportFailures.add(destination);
            console.error(`[pi-telemetry] ${destination} export failed`);
          }
        },
      );
    this.tracer = this.provider.getTracer(
      '@amaster.ai/pi-telemetry',
      (createRequire(import.meta.url)('../../package.json') as { version: string }).version,
    );
  }

  async publish(event: RuntimeTelemetryEvent): Promise<void> {
    const redactedEvent = applyTelemetryRedaction(this.config, event);
    if (!redactedEvent?.traceId) {
      return;
    }
    const createdAtMs = Date.parse(redactedEvent.createdAt);
    // ponytail: five minutes covers ordinary clock skew; future-dated replay
    // can add an explicit normalization policy if it ever becomes a real use.
    if (!Number.isFinite(createdAtMs) || createdAtMs > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS) {
      console.error('[pi-telemetry] dropping event with invalid or future createdAt timestamp');
      return;
    }
    if (isLlmStreamEvent(redactedEvent)) {
      this.publishLlmStreamEvent(redactedEvent, createdAtMs);
    } else if (isLlmGenerationEvent(redactedEvent)) {
      this.publishLlmGenerationEvent(redactedEvent, createdAtMs);
    } else if (isToolEvent(redactedEvent)) {
      this.publishToolEvent(redactedEvent, createdAtMs);
    } else {
      this.publishLifecycleEvent(redactedEvent, createdAtMs);
    }
  }

  setContext(context: TelemetryRequestContext): void {
    this.requestContext = redactTelemetryValue(
      { ...this.config, redactFields: [] },
      {
        ...(typeof context.userId === 'string' ? { userId: context.userId.slice(0, 256) } : {}),
        ...(typeof context.traceName === 'string'
          ? { traceName: context.traceName.slice(0, 90) }
          : {}),
        tags: stringList(context.tags),
        ...(context.metadata &&
        typeof context.metadata === 'object' &&
        !Array.isArray(context.metadata)
          ? { metadata: redactTelemetryValue(this.config, boundMetadata(context.metadata)) }
          : {}),
        ...(typeof context.traceparent === 'string' ? { traceparent: context.traceparent } : {}),
      },
    ) as TelemetryRequestContext;
  }

  getStatus() {
    const failed = this.flushFailed || this.exportFailures.size > 0 || this.rejectedSpans.size > 0;
    return {
      enabled: this.config.enabled,
      state: failed
        ? 'error'
        : this.config.configurationWarnings?.length
          ? 'configuration-warning'
          : this.state,
      ...(failed
        ? { error: 'Telemetry export failed, timed out, or was partially rejected' }
        : this.config.configurationWarnings?.length
          ? { error: this.config.configurationWarnings.join('; ') }
          : {}),
    };
  }

  async flush(): Promise<void> {
    this.flushFailed = false;
    const finished = await waitForExport(
      this.provider.forceFlush().catch(() => {
        this.flushFailed = true;
        console.error('[pi-telemetry] export flush failed');
      }),
    );
    if (!finished) this.flushFailed = true;
    if (!this.flushFailed) this.state = 'flushed';
  }

  async close(): Promise<void> {
    // Spans still open at shutdown (session exit mid-turn) never end on their
    // own and would never export — end them so their start attributes
    // (the root input included) survive.
    for (const span of this.openSpans.values()) {
      span.otelSpan.setAttributes({
        'langfuse.observation.level': 'WARNING',
        'langfuse.observation.metadata.terminatedBy': 'session_shutdown',
      });
      span.end();
    }
    if (this.openSpans.size > 0) {
      console.error(`[pi-telemetry] ended ${this.openSpans.size} open span(s) at session shutdown`);
    }
    this.openSpans.clear();
    this.refreshToolContexts();
    const finished = await waitForExport(
      this.provider.shutdown().catch(() => {
        this.flushFailed = true;
        console.error('[pi-telemetry] exporter shutdown failed');
      }),
    );
    if (!finished) this.flushFailed = true;
    this.state = 'closed';
  }

  private publishLifecycleEvent(event: RuntimeLifecycleEvent, createdAtMs: number): void {
    switch (event.type) {
      case 'chat_turn_started': {
        const span = this.startSpan(
          'chat-turn',
          event,
          createdAtMs,
          this.enrichSpanAttributes(
            {
              ...lifecycleMetadata(event),
              ...langfuseObservationAttributes({ input: event.details?.input, level: 'DEFAULT' }),
            },
            event,
          ),
        );
        this.trackOpenSpan(chatSpanKey(event), span);
        // A nested pi process parents its subagent span to this root.
        process.env[TRACEPARENT_ENV] = traceparent(span);
        this.refreshToolContexts();
        // The root span exports only when the turn ends; an instant child
        // span carries the input up front so the query reaches Langfuse even
        // if the root span is lost to an interrupt or a process kill.
        const input = event.details?.input;
        if (input !== undefined) {
          const inputSpan = this.startSpan(
            'chat-input',
            event,
            createdAtMs,
            this.enrichSpanAttributes(
              {
                ...lifecycleMetadata(event),
                'langfuse.trace.input': input,
                ...langfuseObservationAttributes({ input, level: 'DEFAULT' }),
              },
              event,
            ),
            parentContextOf(span),
          );
          inputSpan.end(createdAtMs);
        }
        return;
      }
      case 'chat_turn_completed':
      case 'chat_turn_failed': {
        const output = event.details?.output ?? (event.error ? { error: event.error } : undefined);
        const attributes = this.enrichSpanAttributes(
          {
            ...lifecycleMetadata(event),
            ...langfuseObservationAttributes({
              output,
              level: event.error ? 'ERROR' : 'DEFAULT',
            }),
          },
          event,
        );
        if (!this.endOpenSpan(chatSpanKey(event), attributes, event.error, createdAtMs)) {
          this.emitTerminalSpan('chat-turn', event, createdAtMs, attributes);
        }
        return;
      }
      case 'chat_turn_steered':
      case 'chat_turn_steer_delivered':
      case 'chat_turn_followup_queued':
      case 'chat_turn_followup_delivered': {
        const span = this.startSpan(
          chatInputObservationName(event),
          event,
          createdAtMs,
          this.enrichSpanAttributes(
            {
              ...lifecycleMetadata(event),
              ...langfuseObservationAttributes({
                input: event.details?.input,
                output: event.details?.output ?? chatInputLifecycleOutput(event),
                level: 'DEFAULT',
              }),
            },
            event,
          ),
          this.telemetryParentContext(event),
        );
        span.end(createdAtMs);
        return;
      }
      case 'subagent_spawned':
      case 'subagent_started': {
        const key = subagentSpanKey(event);
        const existing = this.openSpans.get(key);
        if (existing) {
          // spawned → started is the same lifecycle: update the open span
          // instead of ending it and exporting a duplicate observation.
          existing.otelSpan.setAttributes(
            this.enrichSpanAttributes(
              {
                ...lifecycleMetadata(event),
                ...langfuseObservationAttributes({ input: event.details?.input, level: 'DEFAULT' }),
              },
              event,
            ),
          );
          return;
        }
        const span = this.startSpan(
          subagentObservationName(event),
          event,
          createdAtMs,
          this.enrichSpanAttributes(
            {
              ...lifecycleMetadata(event),
              ...langfuseObservationAttributes({ input: event.details?.input, level: 'DEFAULT' }),
            },
            event,
          ),
          this.subagentParentContext(event),
        );
        this.trackOpenSpan(key, span);
        // The incoming pin has been consumed; descendants advertise their own launch context.
        delete process.env.PI_TELEMETRY_PARENT_TOOL_CALL_ID;
        process.env[TRACEPARENT_ENV] = traceparent(span);
        this.refreshToolContexts();
        return;
      }
      case 'subagent_completed':
      case 'subagent_failed':
      case 'subagent_cancelled': {
        const output = event.details?.output ?? (event.error ? { error: event.error } : undefined);
        const attributes = this.enrichSpanAttributes(
          {
            ...lifecycleMetadata(event),
            ...langfuseObservationAttributes({
              output,
              level: event.error ? 'ERROR' : 'DEFAULT',
            }),
          },
          event,
        );
        if (!this.endOpenSpan(subagentSpanKey(event), attributes, event.error, createdAtMs)) {
          this.emitTerminalSpan(
            subagentObservationName(event),
            event,
            createdAtMs,
            attributes,
            this.subagentParentContext(event),
          );
        }
        return;
      }
      default:
        assertNever(event.type);
    }
  }

  getToolContext(sessionId: string, toolCallId: string): Record<string, string> | undefined {
    const span = [...this.openSpans.entries()].find(([key]) =>
      key.startsWith(`tool:${sessionId}:${toolCallId}:`),
    )?.[1];
    const context = span ? this.launchContexts.get(span) : undefined;
    return context ? { ...context } : undefined;
  }

  private refreshToolContexts(): void {
    const contexts: Record<string, string> = {};
    for (const [key, span] of this.openSpans) {
      if (key.startsWith('tool:')) contexts[key] = traceparent(span);
      if (Object.keys(contexts).length === 2) break;
    }
    process.env.PI_TELEMETRY_TOOL_CONTEXTS = JSON.stringify(contexts);
  }

  private publishToolEvent(event: RuntimeToolEvent, createdAtMs: number): void {
    const key = toolSpanKey(event);
    if (event.status === 'started') {
      const span = this.startSpan(
        toolObservationName(event),
        event,
        createdAtMs,
        this.enrichSpanAttributes(
          {
            ...toolMetadata(event),
            ...(event.args ? { args: event.args } : {}),
            ...langfuseObservationAttributes({ type: 'tool', input: event.args, level: 'DEFAULT' }),
          },
          event,
        ),
        this.telemetryParentContext(event),
      );
      this.launchContexts.set(span, {
        PI_TELEMETRY_TRACE_ID: requireTraceId(event.traceId),
        PI_TELEMETRY_SESSION_ID: event.parentSessionId ?? event.sessionId,
        PI_TELEMETRY_OWNER_PID: String(process.pid),
        PI_TELEMETRY_TRACEPARENT: traceparent(span),
        PI_TELEMETRY_PARENT_TOOL_CALL_ID: event.toolCallId,
      });
      this.trackOpenSpan(key, span);
      this.refreshToolContexts();
      return;
    }
    const attributes = this.enrichSpanAttributes(
      {
        ...toolMetadata(event),
        ...langfuseObservationAttributes({
          type: 'tool',
          output: event.error
            ? { error: event.error }
            : (event.details?.displayOutput ?? event.details),
          level: event.error ? 'ERROR' : 'DEFAULT',
        }),
      },
      event,
    );
    if (!this.endOpenSpan(key, attributes, event.error, createdAtMs)) {
      this.emitTerminalSpan(
        toolObservationName(event),
        event,
        createdAtMs,
        attributes,
        this.telemetryParentContext(event),
      );
    }
    this.refreshToolContexts();
  }

  private publishLlmGenerationEvent(event: RuntimeLlmGenerationEvent, createdAtMs: number): void {
    const key = llmGenerationKey(event);
    const terminalAttributes: JsonObject = {
      ...llmGenerationMetadata(event),
      ...(event.output !== undefined && event.displayOutput !== undefined
        ? { 'langfuse.observation.metadata.rawOutput': event.output }
        : {}),
      // The langfuse-namespaced key is the first-priority mapping source for a
      // generation's model on the OTEL path; a bare `model` key risks sinking
      // into the unfilterable catch-all.
      'langfuse.observation.model.name': event.model.model,
      'langfuse.observation.model.parameters': JSON.stringify({
        provider: event.model.provider,
        ...(event.model.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
        ...event.modelParameters,
      }),
      ...langfuseObservationAttributes({
        type: 'generation',
        output:
          event.displayOutput ?? event.output ?? (event.error ? { error: event.error } : undefined),
        level: event.stopReason === 'superseded' ? 'WARNING' : event.error ? 'ERROR' : 'DEFAULT',
      }),
      ...(event.usage ? langfuseUsageAttributes(event.usage) : {}),
      ...(event.completionStartTime
        ? { 'langfuse.observation.completion_start_time': event.completionStartTime }
        : {}),
    };
    if (event.status === 'started') {
      const span = this.startSpan(
        event.observationName ?? llmGenerationObservationName(event),
        event,
        createdAtMs,
        this.enrichSpanAttributes(
          {
            ...terminalAttributes,
            ...(event.input !== undefined && event.displayInput !== undefined
              ? { 'langfuse.observation.metadata.rawInput': event.input }
              : {}),
            ...langfuseObservationAttributes({
              type: 'generation',
              input: event.displayInput ?? event.input,
              level: 'DEFAULT',
            }),
          },
          event,
        ),
        this.telemetryParentContext(event),
      );
      this.trackOpenSpan(key, span);
      return;
    }
    const attributes = this.enrichSpanAttributes(terminalAttributes, event);
    if (!this.endOpenSpan(key, attributes, event.error, createdAtMs)) {
      this.emitTerminalSpan(
        event.observationName ?? llmGenerationObservationName(event),
        event,
        createdAtMs,
        attributes,
        this.telemetryParentContext(event),
      );
    }
  }

  private publishLlmStreamEvent(event: RuntimeLlmStreamEvent, createdAtMs: number): void {
    const span = this.startSpan(
      'llm-stream',
      event,
      createdAtMs,
      this.enrichSpanAttributes(
        {
          ...lineageMetadata(event),
          llmGenerationId: event.llmGenerationId,
          ...langfuseObservationAttributes({
            input: event.input,
            output: event.streamEvents,
            level: 'DEFAULT',
          }),
        },
        event,
      ),
      parentContextOf(this.openSpans.get(llmGenerationKey(event))),
    );
    span.end(createdAtMs + (event.durationMs ?? 0));
  }

  private startSpan(
    name: string,
    event: RuntimeTelemetryEvent,
    startMs: number,
    attributes: Attributes,
    parentContext?: Context,
  ): LangfuseSpan {
    // Consumed only when the new span has no parent — see TelemetryIdGenerator.
    this.idGenerator.nextTraceId = langfuseTraceId(requireTraceId(event.traceId));
    const otelSpan = this.tracer.startSpan(
      name,
      { startTime: startMs, attributes },
      parentContext ?? contextFromTraceparent(this.requestContext.traceparent) ?? ROOT_CONTEXT,
    );
    const observation = new LangfuseSpan({ otelSpan });
    // The generic wrapper marks its span type as "span"; restore explicit
    // generation attributes produced by the runtime mapping.
    otelSpan.setAttributes(attributes);
    return observation;
  }

  // Terminal event whose start was never seen (or was evicted from the open
  // map): emit a zero-length span carrying only the terminal attributes.
  private emitTerminalSpan(
    name: string,
    event: RuntimeTelemetryEvent,
    atMs: number,
    attributes: Attributes,
    parentContext?: Context,
  ): void {
    const span = this.startSpan(name, event, atMs, attributes, parentContext);
    span.otelSpan.setStatus(statusFor(event.error));
    span.end(atMs);
  }

  // Ends the span registered under `key`. Returns false when no start is
  // open, so the caller can fall back to an output-only span.
  private endOpenSpan(
    key: string,
    attributes: Attributes,
    error: string | undefined,
    endMs: number,
  ): boolean {
    const span = this.openSpans.get(key);
    if (!span) {
      return false;
    }
    this.openSpans.delete(key);
    if (this.openSpans.size === 0) {
      this.openSpanCapWarned = false;
    }
    span.otelSpan.setAttributes(attributes);
    span.otelSpan.setStatus(statusFor(error));
    span.end(endMs);
    return true;
  }

  private trackOpenSpan(key: string, span: LangfuseSpan): void {
    // Same key tracked twice (e.g. a run ended without agent_end, then the
    // next input reuses the chat key): end the orphaned span so its trace
    // isn't silently incomplete.
    const existing = this.openSpans.get(key);
    if (existing) {
      console.error(`[pi-telemetry] open span "${key}" was never ended — ending it before reuse`);
      existing.end();
    }
    if (!this.openSpans.has(key) && this.openSpans.size >= MAX_OPEN_SPANS) {
      const oldest = this.openSpans.keys().next().value;
      if (oldest !== undefined) {
        this.openSpans.delete(oldest);
      }
      // Log once per overflow streak; the flag resets when the map empties.
      if (!this.openSpanCapWarned) {
        this.openSpanCapWarned = true;
        console.error(
          '[pi-telemetry] too many open spans — dropping the oldest; its terminal event will produce an output-only span',
        );
      }
    }
    this.openSpans.set(key, span);
  }

  private subagentParentContext(event: RuntimeLifecycleEvent): Context | undefined {
    const local =
      (event.parentSessionId && event.parentToolCallId
        ? [...this.openSpans.entries()].find(([key]) =>
            key.startsWith(`tool:${event.parentSessionId}:${event.parentToolCallId}:`),
          )?.[1]
        : undefined) ?? this.openSpans.get(chatSpanKey(event));
    // In a subagent (child) process there is no local root span — parent to
    // the main process's span advertised through the environment instead.
    return parentContextOf(local) ?? remoteParentContext();
  }

  private telemetryParentContext(event: RuntimeTelemetryEvent): Context | undefined {
    const subagentKey = telemetryEventSubagentSpanKey(event);
    const toolParent =
      'parentToolCallId' in event && event.parentToolCallId
        ? [...this.openSpans.entries()].find(([key]) =>
            key.startsWith(`tool:${event.sessionId}:${event.parentToolCallId}:`),
          )?.[1]
        : undefined;
    const local =
      toolParent ??
      (subagentKey ? this.openSpans.get(subagentKey) : undefined) ??
      this.openSpans.get(chatSpanKey(event));
    return parentContextOf(local) ?? remoteParentContext();
  }

  // langfuse.trace.metadata.* lands in the trace's top-level metadata and is
  // filterable; plain span attributes sink into the metadata.attributes
  // catch-all and are not. Set them on every span because Langfuse reads
  // trace-level attributes from any span in the trace.
  private enrichSpanAttributes(base: JsonObject, event: RuntimeTelemetryEvent): Attributes {
    const enriched: JsonObject = {
      ...base,
      'langfuse.trace.name': this.requestContext.traceName || this.config.traceName || 'chat-turn',
    };
    const contextMetadata = this.requestContext.metadata ?? {};
    for (const [key, value] of Object.entries(contextMetadata).slice(0, 32)) {
      if (value === undefined) continue;
      enriched[`langfuse.trace.metadata.${key.slice(0, 128)}`] = value;
      enriched[`langfuse.observation.metadata.${key.slice(0, 128)}`] = value;
    }
    const userId =
      ('userId' in event ? event.userId : undefined) ??
      this.requestContext.userId ??
      this.config.userId;
    if (userId) enriched['user.id'] = userId;
    if (this.config.environment) enriched['langfuse.environment'] = this.config.environment;
    if (this.config.release) enriched['langfuse.release'] = this.config.release;
    if (this.config.serviceName) {
      enriched['langfuse.trace.metadata.serviceName'] = this.config.serviceName;
      enriched['langfuse.observation.metadata.serviceName'] = this.config.serviceName;
    }
    enriched['langfuse.trace.tags'] = stringList([
      this.config.serviceName,
      ...(this.config.tags ?? []),
      ...(this.requestContext.tags ?? []),
    ]);
    const taskRunId = event.taskRunId ?? shortCorrelationId(event.runId);
    if (taskRunId) {
      enriched['langfuse.trace.metadata.taskRunId'] = taskRunId;
    }
    // Promote the SDK-path metadata keys out of the catch-all
    // metadata.attributes bucket into Langfuse's top-level observation
    // metadata, so the filters that worked on the SDK transport still work.
    for (const key of FILTERABLE_METADATA_KEYS) {
      const value = enriched[key];
      if (value !== undefined) {
        enriched[`langfuse.observation.metadata.${key}`] =
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
      }
    }
    return toOtelAttributes(enriched);
  }
}

function boundMetadata(value: Record<string, JsonValue>): JsonObject {
  const result: JsonObject = {};
  const limit = new Error('Metadata budget exceeded');
  const ancestors = new Set<object>();
  // Reserve omission markers and attribute-key overhead before copying values.
  let bytes = 6200;
  let nodes = 0;
  function copy(field: JsonValue | undefined, depth: number): JsonValue {
    if (++nodes > 128 || depth > 16 || bytes > 60_000) throw limit;
    if (typeof field === 'string') {
      if (Buffer.byteLength(field) > 60_000 - bytes) throw limit;
      bytes += Buffer.byteLength(JSON.stringify(field));
      if (bytes > 60_000) throw limit;
      return field;
    }
    if (!field || typeof field !== 'object') {
      bytes += 24;
      return field ?? null;
    }
    if (ancestors.has(field)) throw limit;
    ancestors.add(field);
    try {
      if (Array.isArray(field)) {
        const items: JsonValue[] = [];
        for (const item of field) {
          bytes += 1;
          items.push(copy(item, depth + 1));
        }
        return items;
      }
      const object: JsonObject = {};
      for (const key in field) {
        if (!Object.hasOwn(field, key)) continue;
        bytes += Buffer.byteLength(key) * 6 + 4;
        if (bytes > 60_000) throw limit;
        object[key] = copy(field[key], depth + 1);
      }
      return object;
    } finally {
      ancestors.delete(field);
    }
  }
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (count++ >= 31) {
      result.telemetryTruncated = '[additional metadata omitted]';
      break;
    }
    const before = bytes;
    const boundedKey = key.slice(0, 128);
    try {
      bytes += Buffer.byteLength(boundedKey) * 6 + 4;
      result[boundedKey] = copy(value[key], 0);
    } catch (error) {
      if (error !== limit) console.error('[pi-telemetry] invalid custom metadata');
      bytes = before;
      result[boundedKey] = '[metadata value omitted]';
    }
  }
  return result;
}

type OtlpExporterWithDelegate = SpanExporter & {
  _delegate?: {
    _responseHandler?: { handleResponse(response: unknown): void };
  };
};

function rejectedSpanCount(response: unknown): number | string {
  if (!response || typeof response !== 'object') return 0;
  const partial = (response as { partialSuccess?: unknown }).partialSuccess;
  if (!partial || typeof partial !== 'object') return 0;
  const count = (partial as { rejectedSpans?: unknown }).rejectedSpans;
  if (typeof count === 'number') return Number.isFinite(count) && count > 0 ? count : 0;
  return typeof count === 'string' && /^[1-9]\d*$/.test(count) ? count : 0;
}

// One span processor per destination inside a single provider; both are
// present when a config carries Langfuse credentials and a generic endpoint.
function buildTracerProvider(
  config: OtelExporterConfig,
  idGenerator: IdGenerator,
  onExport: (destination: string, succeeded: boolean, rejectedSpans?: number | string) => void,
): BasicTracerProvider {
  const spanProcessors: SpanProcessor[] = [];
  function trackExporter(destination: string, exporter: SpanExporter): SpanExporter {
    const delegate = (exporter as OtlpExporterWithDelegate)._delegate;
    const responseHandler = delegate?._responseHandler;
    if (delegate && responseHandler) {
      delegate._responseHandler = {
        handleResponse(response) {
          onExport(destination, true, rejectedSpanCount(response));
          responseHandler.handleResponse(response);
        },
      };
    }
    const originalExport = exporter.export.bind(exporter);
    exporter.export = (spans, callback) =>
      originalExport(spans, (result) => {
        onExport(destination, result.code === 0);
        callback(result);
      });
    return exporter;
  }
  function trackedExporter(
    destination: string,
    options: ConstructorParameters<typeof OTLPTraceExporter>[0],
  ): SpanExporter {
    return trackExporter(destination, new OTLPTraceExporter(options));
  }
  if (config.langfuse) {
    spanProcessors.push(
      new LangfuseSpanProcessor({
        exporter: trackedExporter('langfuse', {
          url: `${config.langfuse.baseUrl.replace(/\/+$/, '')}/api/public/otel/v1/traces`,
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.langfuse.publicKey}:${config.langfuse.secretKey}`).toString('base64')}`,
            'x-langfuse-ingestion-version': '4',
          },
          timeoutMillis: EXPORT_TIMEOUT_MS,
        }),
        publicKey: config.langfuse.publicKey,
        secretKey: config.langfuse.secretKey,
        baseUrl: config.langfuse.baseUrl,
        flushAt: config.langfuse.flushAt,
        // LangfuseSpanProcessor takes the flush interval in seconds.
        flushInterval: config.langfuse.flushIntervalMs / 1000,
        timeout: EXPORT_TIMEOUT_MS / 1000,
        shouldExportSpan: () => true,
        mediaUploadEnabled: config.includePayloads === true && config.mediaUploadEnabled === true,
        // Opt into real-time v4 ingestion — @langfuse/otel does not set this
        // itself, and without it data can lag the v2 read APIs.
        additionalHeaders: { 'x-langfuse-ingestion-version': '4' },
      }),
    );
  }
  if (config.endpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        trackedExporter('otel', {
          url: normalizeOtelTracesEndpoint(config.endpoint),
          ...(config.headers ? { headers: config.headers } : {}),
          timeoutMillis: EXPORT_TIMEOUT_MS,
        }),
        {
          maxExportBatchSize: config.flushAt,
          scheduledDelayMillis: config.flushIntervalMs,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        },
      ),
    );
  }
  if (config.phoenix) {
    spanProcessors.push(
      new BatchSpanProcessor(
        trackExporter(
          'phoenix',
          createPhoenixSpanExporter(
            { ...config.phoenix, includePayloads: config.includePayloads },
            EXPORT_TIMEOUT_MS,
          ),
        ),
        {
          maxExportBatchSize: config.phoenix.flushAt,
          scheduledDelayMillis: config.phoenix.flushIntervalMs,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        },
      ),
    );
  }
  // Without a resource the collector sees service.name=unknown_service:node —
  // set it from config so the traces identify their runtime.
  const resource = defaultResource().merge(
    resourceFromAttributes({
      'service.name': config.serviceName ?? 'pi',
      ...(config.serviceVersion ? { 'service.version': config.serviceVersion } : {}),
    }),
  );
  return new BasicTracerProvider({ spanProcessors, idGenerator, resource });
}

function normalizeExporterConfig(config: OtelExporterConfig): OtelExporterConfig {
  return {
    ...config,
    tags: stringList(config.tags),
    redactFields: stringList(config.redactFields),
    includePayloads: config.includePayloads === true,
    mediaUploadEnabled: config.includePayloads === true && config.mediaUploadEnabled === true,
    flushAt: parsePositiveInteger(config.flushAt, DEFAULT_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(config.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    ...(config.langfuse
      ? {
          langfuse: {
            ...config.langfuse,
            flushAt: parsePositiveInteger(config.langfuse.flushAt, DEFAULT_FLUSH_AT),
            flushIntervalMs: parsePositiveInteger(
              config.langfuse.flushIntervalMs,
              DEFAULT_FLUSH_INTERVAL_MS,
            ),
          },
        }
      : {}),
    ...(config.phoenix
      ? {
          phoenix: {
            ...config.phoenix,
            endpoint: config.phoenix.endpoint.replace(/\/+$/, ''),
            flushAt: parsePositiveInteger(config.phoenix.flushAt, DEFAULT_FLUSH_AT),
            flushIntervalMs: parsePositiveInteger(
              config.phoenix.flushIntervalMs,
              DEFAULT_FLUSH_INTERVAL_MS,
            ),
          },
        }
      : {}),
  };
}

function parentContextOf(span: LangfuseSpan | undefined): Context | undefined {
  return span ? trace.setSpanContext(ROOT_CONTEXT, span.otelSpan.spanContext()) : undefined;
}

// Parses the W3C traceparent a parent pi process published for us.
function remoteParentContext(): Context | undefined {
  let value = process.env[TRACEPARENT_ENV];
  // A launch can pin its exact parent. Otherwise inherit only an unambiguous tool snapshot.
  if (!process.env.PI_TELEMETRY_PARENT_TOOL_CALL_ID) {
    try {
      const contexts = JSON.parse(process.env.PI_TELEMETRY_TOOL_CONTEXTS ?? '{}');
      const parents =
        contexts && typeof contexts === 'object' && !Array.isArray(contexts)
          ? Object.values(contexts)
          : [];
      if (parents.length === 1 && typeof parents[0] === 'string') value = parents[0];
    } catch {
      /* Invalid inherited context falls back to the agent parent. */
    }
  }
  return contextFromTraceparent(value);
}

function contextFromTraceparent(value: string | undefined): Context | undefined {
  const match = value
    ? /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(value)
    : null;
  if (!match) {
    return undefined;
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: Number(match[3]),
    isRemote: true,
  });
}

function traceparent(span: LangfuseSpan): string {
  const { traceId, spanId } = span.otelSpan.spanContext();
  return `00-${traceId}-${spanId}-01`;
}

function statusFor(error: string | undefined): { code: SpanStatusCode; message?: string } {
  if (!error) {
    return { code: SpanStatusCode.OK };
  }
  const message =
    error.length > MAX_STATUS_MESSAGE_CHARS
      ? `${error.slice(0, MAX_STATUS_MESSAGE_CHARS)}... [truncated]`
      : error;
  return { code: SpanStatusCode.ERROR, message };
}

async function waitForExport(operation: Promise<void>): Promise<boolean> {
  return Promise.race([
    operation.then(() => true),
    delay(MAX_CLOSE_MS, undefined, { ref: false }).then(() => false),
  ]);
}

// OTEL attribute values are scalar (or homogeneous string arrays); objects
// flatten to JSON strings, exactly like the previous hand-rolled serializer.
// Strings are truncated at set time, so no byte accounting happens later.
function toOtelAttributes(json: JsonObject): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(json)) {
    const converted = toOtelAttributeValue(value);
    if (converted !== undefined) {
      attributes[key] = converted;
    }
  }
  return attributes;
}

function toOtelAttributeValue(value: JsonValue | undefined): AttributeValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return truncateAttributePayload(value);
  }
  // Real string arrays (e.g. langfuse.trace.tags) instead of a
  // JSON-stringified blob Langfuse cannot map.
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return truncateAttributePayload(JSON.stringify(value));
}
