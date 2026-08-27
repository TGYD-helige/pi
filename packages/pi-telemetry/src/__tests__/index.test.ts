import { getLangfuseTracerProvider, setLangfuseTracerProvider } from '@langfuse/tracing';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompositeRuntimeEventExporter,
  NoopRuntimeEventExporter,
  type RuntimeTelemetryEvent,
} from '../index.js';
import { OtelRuntimeEventExporter, TelemetryIdGenerator } from '../langfuse/exporters.js';
import { MAX_CLOSE_MS } from '../langfuse/types.js';
import { normalizeOtelTracesEndpoint } from '../langfuse/utils.js';
import {
  createRuntimeEventExporterFromEnv as createLangfuseRuntimeEventExporterFromEnv,
  resolveLangfuseConfig,
  resolveLangfuseExporterConfig,
} from '../langfuse.js';
import {
  createOtelRuntimeEventExporterFromEnv,
  createTelemetryExporter,
  type OtelExporterConfig,
  resolveOtelConfig,
  resolveOtelExporterConfig,
} from '../otel.js';

const { delayMock } = vi.hoisted(() => ({
  delayMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: delayMock,
}));

const traceId = '11111111111111111111111111111111';

// Drives the exporter with an in-memory SDK pipeline: spans land in
// `inMemory` as soon as they end, so tests assert on finished spans directly
// instead of intercepting HTTP requests (the SDK owns the transport now).
function makeExporter(configOverrides: Partial<OtelExporterConfig> = {}) {
  const inMemory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(inMemory)],
  });
  const exporter = new OtelRuntimeEventExporter(
    {
      enabled: true,
      endpoint: '',
      flushAt: 10,
      flushIntervalMs: 60_000,
      ...configOverrides,
    },
    { provider },
  );
  return { exporter, inMemory };
}

function completedTurnEvent(id: string): RuntimeTelemetryEvent {
  return {
    id,
    traceId,
    type: 'chat_turn_completed',
    sessionId: 'session-1',
    createdAt: '2026-05-02T00:00:01.000Z',
  };
}

function hrTimeToMs([seconds, nanos]: [number, number]): number {
  return seconds * 1000 + nanos / 1_000_000;
}

afterEach(() => {
  delete process.env.PI_TELEMETRY_TRACEPARENT;
  setLangfuseTracerProvider(null);
  delayMock.mockClear();
  vi.restoreAllMocks();
});

describe('telemetry', () => {
  it('keeps root exporters resilient when one delegate fails', async () => {
    const event: RuntimeTelemetryEvent = {
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    };
    const delivered: string[] = [];
    const composite = new CompositeRuntimeEventExporter([
      {
        publish: async () => {
          throw new Error('boom');
        },
        flush: async () => {
          throw new Error('flush failed');
        },
        close: async () => {
          throw new Error('close failed');
        },
      },
      {
        publish: async (published) => {
          delivered.push(published.id);
        },
        flush: async () => {
          delivered.push('flushed');
        },
        close: async () => {
          delivered.push('closed');
        },
      },
    ]);

    await expect(new NoopRuntimeEventExporter().publish(event)).resolves.toBeUndefined();
    await expect(composite.publish(event)).resolves.toBeUndefined();
    await expect(composite.close()).resolves.toBeUndefined();

    expect(delivered).toEqual(['event-1', 'flushed', 'closed']);
  });

  it('keeps Langfuse disabled until keys are present', () => {
    expect(resolveLangfuseConfig({ LANGFUSE_ENABLED: 'true' })).toMatchObject({
      enabled: false,
      baseUrl: 'https://cloud.langfuse.com',
      flushAt: 20,
      flushIntervalMs: 5000,
      includePayloads: false,
    });

    expect(
      resolveLangfuseConfig({
        LANGFUSE_ENABLED: '1',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
        LANGFUSE_BASE_URL: 'https://langfuse.example.com/',
        LANGFUSE_FLUSH_AT: '2',
        LANGFUSE_FLUSH_INTERVAL_MS: '100',
      }),
    ).toMatchObject({
      enabled: true,
      publicKey: 'public',
      secretKey: 'secret',
      baseUrl: 'https://langfuse.example.com/',
      flushAt: 2,
      flushIntervalMs: 100,
    });

    expect(
      resolveLangfuseConfig({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
      }),
    ).toMatchObject({
      enabled: true,
    });
  });

  it('falls back from invalid settings batch sizes', () => {
    expect(
      resolveLangfuseExporterConfig({
        langfuse: {
          enabled: true,
          publicKey: 'public',
          secretKey: 'secret',
          flushAt: 0,
        },
      }).flushAt,
    ).toBe(20);
    expect(
      resolveOtelExporterConfig({
        otel: { enabled: true, endpoint: 'https://otel.example.com', flushAt: -1 },
      }).flushAt,
    ).toBe(20);
    expect(
      resolveOtelExporterConfig({
        otel: { enabled: true, endpoint: 'https://otel.example.com', flushAt: 0.5 },
      }).flushAt,
    ).toBe(20);
  });

  it('creates a Langfuse OTEL exporter from environment', async () => {
    expect(createLangfuseRuntimeEventExporterFromEnv({ LANGFUSE_ENABLED: 'true' })).toBeInstanceOf(
      NoopRuntimeEventExporter,
    );
    // The Langfuse write path is the official stack: a BasicTracerProvider
    // carrying a LangfuseSpanProcessor, which wraps a BatchSpanProcessor +
    // OTLPTraceExporter with Langfuse auth against
    // `<baseUrl>/api/public/otel/v1/traces`. Constructing it with fake keys is
    // fine offline as long as nothing is published through it.
    const exporter = createLangfuseRuntimeEventExporterFromEnv({
      LANGFUSE_ENABLED: 'true',
      LANGFUSE_PUBLIC_KEY: 'public',
      LANGFUSE_SECRET_KEY: 'secret',
      LANGFUSE_BASE_URL: 'https://langfuse.example.com/',
    });
    expect(exporter).toBeInstanceOf(OtelRuntimeEventExporter);
    await expect(exporter.close?.()).resolves.toBeUndefined();
  });

  it('excludes OTEL payloads by default', () => {
    expect(
      resolveOtelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      }),
    ).toMatchObject({
      enabled: true,
      includePayloads: false,
    });
  });

  it('creates a generic OTEL exporter from environment and normalizes the endpoint', async () => {
    expect(
      resolveOtelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20token,x-tenant=demo',
        OTEL_SERVICE_NAME: 'pi-test',
        TELEMETRY_INCLUDE_PAYLOADS: 'false',
      }),
    ).toMatchObject({
      enabled: true,
      endpoint: 'https://otel.example.com',
      headers: {
        authorization: 'Bearer token',
        'x-tenant': 'demo',
      },
      serviceName: 'pi-test',
      includePayloads: false,
    });

    expect(createOtelRuntimeEventExporterFromEnv({})).toBeInstanceOf(NoopRuntimeEventExporter);
    expect(
      createOtelRuntimeEventExporterFromEnv({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      }),
    ).toBeInstanceOf(NoopRuntimeEventExporter);

    const exporter = createOtelRuntimeEventExporterFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20token',
      OTEL_SERVICE_NAME: 'pi-test',
    });
    expect(exporter).toBeInstanceOf(OtelRuntimeEventExporter);
    await expect(exporter.close?.()).resolves.toBeUndefined();

    expect(normalizeOtelTracesEndpoint('https://otel.example.com')).toBe(
      'https://otel.example.com/v1/traces',
    );
    expect(normalizeOtelTracesEndpoint('https://otel.example.com/v1/traces')).toBe(
      'https://otel.example.com/v1/traces',
    );
  });

  it('does not replace the process-wide Langfuse tracer provider', async () => {
    setLangfuseTracerProvider(null);
    const processProvider = getLangfuseTracerProvider();
    const { exporter } = makeExporter();

    expect(getLangfuseTracerProvider()).toBe(processProvider);
    await exporter.close();
    expect(getLangfuseTracerProvider()).toBe(processProvider);
  });

  it('normalizes direct-constructor batch sizes', async () => {
    const exporter = new OtelRuntimeEventExporter({
      enabled: true,
      endpoint: 'https://otel.example.com',
      flushAt: 0,
      flushIntervalMs: 1000,
      langfuse: {
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 0.5,
        flushIntervalMs: 1000,
      },
    });
    const internals = exporter as unknown as {
      provider: {
        _activeSpanProcessor: {
          _spanProcessors: Array<{
            processor?: { _maxExportBatchSize: number };
            _maxExportBatchSize?: number;
          }>;
        };
      };
    };

    const [langfuseProcessor, otelProcessor] =
      internals.provider._activeSpanProcessor._spanProcessors;
    expect(langfuseProcessor?.processor?._maxExportBatchSize).toBe(20);
    expect(otelProcessor?._maxExportBatchSize).toBe(20);
    await exporter.close();
  });

  it('keeps batching settings separate for Langfuse and generic OTLP', async () => {
    const exporter = createTelemetryExporter({
      langfuse: {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        flushAt: 7,
        flushIntervalMs: 250,
      },
      otel: {
        enabled: true,
        endpoint: 'https://otel.example.com',
        flushAt: 31,
        flushIntervalMs: 31000,
      },
    });
    const internals = exporter as unknown as {
      config: OtelExporterConfig;
      provider: {
        _activeSpanProcessor: {
          _spanProcessors: Array<{
            processor?: { _maxExportBatchSize: number; _scheduledDelayMillis: number };
            _maxExportBatchSize?: number;
            _scheduledDelayMillis?: number;
          }>;
        };
      };
    };

    expect(internals.config).toMatchObject({
      flushAt: 31,
      flushIntervalMs: 31000,
      langfuse: { flushAt: 7, flushIntervalMs: 250 },
    });
    const [langfuseProcessor, otelProcessor] =
      internals.provider._activeSpanProcessor._spanProcessors;
    expect(langfuseProcessor?.processor).toMatchObject({
      _maxExportBatchSize: 7,
      _scheduledDelayMillis: 250,
    });
    expect(otelProcessor).toMatchObject({
      _maxExportBatchSize: 31,
      _scheduledDelayMillis: 31000,
    });
    await exporter.close?.();
  });

  it('preserves default SDK resource attributes with configured service identity', async () => {
    const exporter = createTelemetryExporter({
      serviceName: 'pi-test',
      serviceVersion: '1.2.3',
      otel: { enabled: true, endpoint: 'https://otel.example.com' },
    });
    const internals = exporter as unknown as {
      provider: { _resource: { attributes: Record<string, unknown> } };
    };

    expect(internals.provider._resource.attributes).toMatchObject({
      'service.name': 'pi-test',
      'service.version': '1.2.3',
      'telemetry.sdk.name': 'opentelemetry',
      'telemetry.sdk.language': 'nodejs',
    });
    await exporter.close?.();
  });

  it('exports a chat turn as linked spans', async () => {
    const { exporter, inMemory } = makeExporter({ serviceName: 'pi-test' });

    await exporter.publish({
      id: 'turn-1-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'tool-1-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      args: { command: 'echo hi' },
    });
    await exporter.publish({
      id: 'gen-1-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'gen-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.200Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      input: 'hello',
    });
    await exporter.publish({
      id: 'gen-1-end',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'gen-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.800Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      output: { content: 'world' },
      usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.01 } },
    });
    await exporter.publish({
      id: 'tool-1-end',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.900Z',
      details: { output: 'hi' },
    });
    await exporter.publish({
      id: 'turn-1-end',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { output: 'world' },
    });

    const spans = inMemory.getFinishedSpans();
    // End order: generation, tool, root.
    const [generation, tool, root] = spans as [ReadableSpan, ReadableSpan, ReadableSpan];
    expect(root.name).toBe('chat-turn');
    expect(tool.name).toBe('bash [echo hi]');
    expect(generation.name).toBe('llm-generation [main] [hello]');
    expect(root.parentSpanContext).toBeUndefined();
    expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(generation.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);

    expect(hrTimeToMs(root.startTime)).toBe(Date.parse('2026-05-02T00:00:00.000Z'));
    expect(hrTimeToMs(root.endTime)).toBe(Date.parse('2026-05-02T00:00:01.000Z'));
    expect(root.status.code).toBe(SpanStatusCode.OK);
    expect(root.attributes['langfuse.observation.input']).toBe(JSON.stringify('hello'));
    expect(root.attributes['langfuse.observation.output']).toBe(JSON.stringify('world'));
    expect(root.attributes['langfuse.trace.name']).toBe('chat-turn');
    // The root span advertises itself so a nested pi process can parent to it.
    expect(process.env.PI_TELEMETRY_TRACEPARENT).toBe(
      `00-${root.spanContext().traceId}-${root.spanContext().spanId}-01`,
    );

    expect(generation.attributes['langfuse.observation.type']).toBe('generation');
    expect(
      JSON.parse(String(generation.attributes['langfuse.observation.usage_details'])),
    ).toMatchObject({ input: 3, output: 4, total: 7 });
    expect(
      JSON.parse(String(generation.attributes['langfuse.observation.cost_details'])),
    ).toMatchObject({ total: 0.01 });
    expect(
      JSON.parse(String(generation.attributes['langfuse.observation.model.parameters'])),
    ).toMatchObject({ provider: 'deepseek' });
    expect(generation.attributes['langfuse.observation.model.name']).toBe('deepseek-v4-flash');
    expect(generation.attributes['langfuse.session.id']).toBe('session-1');
    expect(generation.attributes['langfuse.trace.metadata.serviceName']).toBe('pi-test');
    expect(generation.attributes['langfuse.observation.metadata.serviceName']).toBe('pi-test');
    expect(generation.attributes['langfuse.trace.tags']).toEqual(['pi-test']);
    expect(tool.attributes['langfuse.observation.input']).toBe(
      JSON.stringify({ command: 'echo hi' }),
    );
    expect(tool.attributes['langfuse.observation.output']).toBe(JSON.stringify({ output: 'hi' }));
  });

  it('keeps SDK metadata fields filterable on the OTEL path', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish({
      id: 'turn-1',
      traceId,
      type: 'chat_turn_failed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 250,
      toolPolicyProfile: 'trusted',
      details: { phase: 'provider' },
      error: 'request failed',
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    // Scalars are promoted to filterable observation metadata...
    expect(span.attributes['langfuse.observation.metadata.durationMs']).toBe('250');
    expect(span.attributes['langfuse.observation.metadata.toolPolicyProfile']).toBe('trusted');
    expect(span.attributes['langfuse.observation.metadata.eventType']).toBe('chat_turn_failed');
    // ...while object/long-string payloads (details, usage, error) are not:
    // unusable as filters and they duplicate the trace's largest values.
    expect(span.attributes['langfuse.observation.metadata.details']).toBeUndefined();
    expect(span.attributes['langfuse.observation.metadata.error']).toBeUndefined();
    // They remain in the plain (catch-all) attributes.
    expect(JSON.parse(String(span.attributes.details))).toEqual({ phase: 'provider' });
    // Explicit errors are sanitized before they reach any attribute.
    expect(span.attributes.error).toBe('Telemetry operation failed');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('Telemetry operation failed');
  });

  it('sanitizes explicit telemetry errors before export', async () => {
    const { exporter, inMemory } = makeExporter({ includePayloads: true });
    await exporter.publish({
      id: 'failed-tool',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'failed',
      createdAt: '2026-05-02T00:00:01.000Z',
      error: 'Authorization: Bearer super-secret-token\ninternal stack trace',
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    const serialized = JSON.stringify(span.attributes);
    expect(serialized).toContain('Telemetry operation failed');
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('internal stack trace');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('Telemetry operation failed');
  });

  it('strips payloads when includePayloads is false', async () => {
    const { exporter, inMemory } = makeExporter({ includePayloads: false });
    await exporter.publish({
      id: 'turn-1-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'turn-1-end',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { output: 'world' },
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    expect(span.attributes['langfuse.observation.input']).toBeUndefined();
    expect(span.attributes['langfuse.observation.output']).toBeUndefined();
    const serialized = JSON.stringify(span.attributes);
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain('world');
  });

  it('truncates oversized attribute values at set time', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish({
      id: 'gen-1-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'gen-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.000Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      input: { content: '你'.repeat(500_000) },
    });
    await exporter.publish({
      id: 'gen-1-end',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'gen-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      output: 'done',
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    // Truncated structured payloads stay valid JSON.
    expect(JSON.parse(String(span.attributes['langfuse.observation.input']))).toMatchObject({
      truncated: true,
    });
    expect(span.attributes['langfuse.observation.output']).toBe(JSON.stringify('done'));
  });

  it('emits an output-only span when the terminal event has no start', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish({
      ...completedTurnEvent('turn-1'),
      details: { output: 'world' },
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    expect(span.name).toBe('chat-turn');
    expect(span.attributes['langfuse.observation.output']).toBe(JSON.stringify('world'));
    expect(span.attributes['langfuse.observation.input']).toBeUndefined();
    expect(span.parentSpanContext).toBeUndefined();
    expect(hrTimeToMs(span.startTime)).toBe(hrTimeToMs(span.endTime));
  });

  it('keeps an output-only LLM event classified as a generation', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish({
      id: 'gen-1-end',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'gen-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      output: 'done',
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    expect(span.attributes['langfuse.observation.type']).toBe('generation');
  });

  it('parents captured stream frames beneath the active generation', async () => {
    const { exporter, inMemory } = makeExporter();
    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'gen-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'gen-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    });
    await exporter.publish({
      id: 'stream',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'gen-1',
      createdAt: '2026-05-02T00:00:00.200Z',
      durationMs: 300,
      streamEvents: [{ type: 'text_delta', delta: 'hello' }],
    });
    await exporter.publish({
      id: 'gen-end',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'gen-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.600Z',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    });

    const [stream, generation] = inMemory.getFinishedSpans() as [ReadableSpan, ReadableSpan];
    expect(stream.name).toBe('llm-stream');
    expect(stream.parentSpanContext?.spanId).toBe(generation.spanContext().spanId);
    expect(JSON.parse(String(stream.attributes['langfuse.observation.output']))).toEqual([
      { type: 'text_delta', delta: 'hello' },
    ]);
  });

  it('emits short chat-input spans parented to the root span', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish({
      id: 'turn-1-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'steer-1',
      traceId,
      type: 'chat_turn_steered',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.500Z',
      details: { input: 'actually, use zsh' },
    });
    await exporter.publish(completedTurnEvent('turn-1-end'));

    const [steer, root] = inMemory.getFinishedSpans() as [ReadableSpan, ReadableSpan];
    expect(steer.name).toBe('chat-steer [actually, use zsh]');
    expect(steer.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(hrTimeToMs(steer.startTime)).toBe(hrTimeToMs(steer.endTime));
    expect(steer.attributes['langfuse.observation.input']).toBe(
      JSON.stringify('actually, use zsh'),
    );
  });

  it('parents subagent spans to the local root span', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish({
      id: 'turn-1-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'sub-1-start',
      traceId,
      type: 'subagent_spawned',
      sessionId: 'session-1',
      runId: 'run-1',
      createdAt: '2026-05-02T00:00:00.100Z',
      details: { agent: 'research' },
    });
    await exporter.publish({
      id: 'sub-1-tool-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'web_search',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.200Z',
      args: { query: 'pi telemetry' },
    });
    await exporter.publish({
      id: 'sub-1-tool-end',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'web_search',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.800Z',
    });
    await exporter.publish({
      id: 'sub-1-end',
      traceId,
      type: 'subagent_completed',
      sessionId: 'session-1',
      runId: 'run-1',
      createdAt: '2026-05-02T00:00:00.900Z',
      details: { output: 'found it' },
    });
    await exporter.publish(completedTurnEvent('turn-1-end'));

    // End order: tool, subagent, root.
    const [tool, subagent, root] = inMemory.getFinishedSpans() as [
      ReadableSpan,
      ReadableSpan,
      ReadableSpan,
    ];
    expect(subagent.name).toBe('subagent [research]');
    expect(subagent.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(subagent.spanContext().spanId);
    expect(new Set(inMemory.getFinishedSpans().map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it('parents subagent spans to PI_TELEMETRY_TRACEPARENT in a child process', async () => {
    const { exporter, inMemory } = makeExporter();
    process.env.PI_TELEMETRY_TRACEPARENT =
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';

    await exporter.publish({
      id: 'sub-1-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent-session',
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { agent: 'legal', input: 'review this' },
    });
    // The env var now points at the subagent span, so grandchildren parent to it.
    const written = process.env.PI_TELEMETRY_TRACEPARENT;
    expect(written).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(written).not.toContain('bbbbbbbbbbbbbbbb');

    await exporter.publish({
      id: 'sub-1-end',
      traceId,
      type: 'subagent_completed',
      sessionId: 'parent-session',
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { agent: 'legal', output: 'done' },
    });

    const [span] = inMemory.getFinishedSpans() as [ReadableSpan];
    expect(span.name).toBe('subagent [legal]');
    expect(span.spanContext().traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(span.parentSpanContext?.spanId).toBe('bbbbbbbbbbbbbbbb');
    expect(span.parentSpanContext?.isRemote).toBe(true);
    expect(written).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });

  it('caps open spans, dropping the oldest with one stderr log', async () => {
    const { exporter, inMemory } = makeExporter();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toolStarted = (index: number): RuntimeTelemetryEvent => ({
      id: `tool-start-${index}`,
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      toolCallId: `call-${index}`,
      toolName: 'bash',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.000Z',
      args: { command: `cmd-${index}` },
    });
    const toolCompleted = (index: number): RuntimeTelemetryEvent => ({
      id: `tool-end-${index}`,
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      toolCallId: `call-${index}`,
      toolName: 'bash',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { output: 'done' },
    });

    // 512 is the open-span cap; the first start is evicted by the 513th.
    for (let index = 0; index <= 512; index += 1) {
      await exporter.publish(toolStarted(index));
    }
    await exporter.publish(toolCompleted(0)); // evicted → output-only span
    await exporter.publish(toolCompleted(512)); // still open → input survives

    const [evicted, kept] = inMemory.getFinishedSpans() as [ReadableSpan, ReadableSpan];
    expect(evicted.attributes['langfuse.observation.input']).toBeUndefined();
    expect(evicted.attributes['langfuse.observation.output']).toBe(
      JSON.stringify({ output: 'done' }),
    );
    expect(kept.attributes['langfuse.observation.input']).toBe(
      JSON.stringify({ command: 'cmd-512' }),
    );
    const capLogs = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes('too many open spans'),
    );
    expect(capLogs).toHaveLength(1);
  });

  it('drops events with invalid or future-dated createdAt', async () => {
    const { exporter, inMemory } = makeExporter();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await exporter.publish({
      ...completedTurnEvent('invalid-timestamp'),
      createdAt: 'not-a-timestamp',
    });
    await exporter.publish({
      ...completedTurnEvent('future-timestamp'),
      createdAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    expect(inMemory.getFinishedSpans()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('flushes and closes through the SDK provider', async () => {
    const { exporter, inMemory } = makeExporter();

    await exporter.publish(completedTurnEvent('turn-1'));
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(inMemory.getFinishedSpans()).toHaveLength(1);
    // InMemorySpanExporter.shutdown() clears its buffer, so assert before close.
    await expect(exporter.close()).resolves.toBeUndefined();
  });

  it('bounds a hung SDK flush with the lifecycle deadline', async () => {
    const provider = new BasicTracerProvider();
    vi.spyOn(provider, 'forceFlush').mockReturnValue(new Promise<void>(() => {}));
    const exporter = new OtelRuntimeEventExporter(
      { enabled: true, endpoint: '', flushAt: 10, flushIntervalMs: 1000 },
      { provider },
    );

    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(delayMock).toHaveBeenCalledWith(MAX_CLOSE_MS, undefined, { ref: false });
  });
});

describe('TelemetryIdGenerator', () => {
  it('consumes a seeded trace id once, then falls back to random ids', () => {
    const generator = new TelemetryIdGenerator();
    generator.nextTraceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(generator.generateTraceId()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(generator.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generator.generateTraceId()).not.toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    generator.nextTraceId = 'not-a-hex-trace-id';
    expect(generator.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generator.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
