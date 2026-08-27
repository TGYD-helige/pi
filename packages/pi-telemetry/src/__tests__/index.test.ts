import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompositeRuntimeEventExporter,
  NoopRuntimeEventExporter,
  type RuntimeTelemetryEvent,
} from '../index.js';
import {
  createRuntimeEventExporterFromEnv as createLangfuseRuntimeEventExporterFromEnv,
  type LangfuseSdkClient,
  type LangfuseSdkGenerationClient,
  LangfuseSdkRuntimeEventExporter,
  type LangfuseSdkSpanClient,
  type LangfuseSdkTraceClient,
  resolveLangfuseConfig,
} from '../langfuse.js';
import {
  createOtelRuntimeEventExporterFromEnv,
  OtelRuntimeEventExporter,
  resolveOtelConfig,
} from '../otel.js';

const traceId = '11111111111111111111111111111111';

afterEach(() => {
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

  it('creates Langfuse SDK exporter from environment', () => {
    expect(createLangfuseRuntimeEventExporterFromEnv({ LANGFUSE_ENABLED: 'true' })).toBeInstanceOf(
      NoopRuntimeEventExporter,
    );
    expect(
      createLangfuseRuntimeEventExporterFromEnv({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
      }),
    ).toBeInstanceOf(LangfuseSdkRuntimeEventExporter);
  });

  it('strips payloads when includePayloads is false in SDK transport', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
        includePayloads: false,
      },
      client,
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'secret prompt', output: 'draft', content: 'raw content', kept: true },
    });
    await exporter.publish({
      id: 'tool-event-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      args: { command: 'cat private.txt' },
      details: { args: { command: 'cat private.txt' }, kept: true },
    });
    await exporter.publish({
      id: 'tool-event-2',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-2',
      toolName: 'run_shell',
      status: 'failed',
      createdAt: '2026-05-02T00:00:00.200Z',
      error: 'complete failed result with secret',
      details: {
        kept: true,
        apiKey: 'sdk-secret',
        nested: { content: 'secret output', token: 'nested-secret', safe: 'metadata' },
      },
    });

    const trace = client.traces[0];
    expect(trace?.body.input).toBeUndefined();
    const toolSpan = trace?.spans[0]?.spans[0];
    expect(toolSpan?.body.input).toBeUndefined();
    const serialized = JSON.stringify(client.traces);
    expect(serialized).not.toContain('complete failed result');
    expect(serialized).not.toContain('secret output');
    expect(serialized).not.toContain('sdk-secret');
    expect(serialized).not.toContain('nested-secret');
  });

  it('allows redaction hooks to drop telemetry events in SDK transport', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
        redactEvent: (event) => (event.id === 'drop-me' ? undefined : event),
      },
      client,
    );

    await exporter.publish({
      id: 'drop-me',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'keep-me',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { input: 'world' },
    });

    expect(client.traces).toHaveLength(1);
    expect(client.traces[0]?.body.input).toBe('world');
  });

  it('flushes Langfuse SDK telemetry after terminal events', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    expect(client.flushed).toBe(0);

    await exporter.publish({
      id: 'turn-end',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:02.000Z',
      durationMs: 2000,
      details: { output: 'done' },
    });

    expect(client.flushed).toBe(1);
  });

  it('retries a failed terminal Langfuse flush within the terminal handler', async () => {
    const client = new FakeLangfuseSdkClient();
    client.flushFailuresRemaining = 3;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-end-retry',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:02.000Z',
      durationMs: 2000,
      details: { output: 'done' },
    });

    expect(client.flushed).toBe(4);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenNthCalledWith(
      1,
      '[pi-telemetry] Langfuse telemetry flush failed (attempt 1/4): transient flush failure',
    );
  });

  it('rejects when every terminal Langfuse flush attempt is exhausted', async () => {
    const client = new FakeLangfuseSdkClient();
    client.flushFailuresRemaining = 4;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await expect(
      exporter.publish({
        id: 'turn-end-exhausted',
        traceId,
        type: 'chat_turn_completed',
        sessionId: 'session-1',
        conversationId: 'conversation-1',
        createdAt: '2026-05-02T00:00:02.000Z',
        durationMs: 2000,
        details: { output: 'done' },
      }),
    ).rejects.toThrow('transient flush failure');

    expect(client.flushed).toBe(4);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('flushes Langfuse SDK telemetry after point-in-time lifecycle events', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    expect(client.flushed).toBe(0);

    await exporter.publish({
      id: 'turn-steered',
      traceId,
      type: 'chat_turn_steered',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { input: 'use claude', turnMode: 'steer' },
    });

    expect(client.flushed).toBe(1);
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

  it('exports completed spans through a generic OTEL traces endpoint', async () => {
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

    const requests: Array<{
      input: string;
      init: { headers: Record<string, string>; body: string };
    }> = [];
    const exporter = createOtelRuntimeEventExporterFromEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20token',
        OTEL_SERVICE_NAME: 'pi-test',
        TELEMETRY_INCLUDE_PAYLOADS: 'false',
      },
      async (input, init) => {
        requests.push({ input, init });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'otel-event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'otel-event-2',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { output: 'world' },
    });
    await exporter.flush?.();

    expect(exporter).toBeInstanceOf(OtelRuntimeEventExporter);
    expect(requests[0]?.input).toBe('https://otel.example.com/v1/traces');
    expect(requests[0]?.init.headers.authorization).toBe('Bearer token');
    const payload = JSON.parse(requests[0]?.init.body ?? '{}');
    const resourceAttributes = payload.resourceSpans[0].resource.attributes;
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(getStringAttribute({ attributes: resourceAttributes }, 'service.name')).toBe('pi-test');
    expect(getStringAttribute(span, 'langfuse.observation.input')).toBeUndefined();
    expect(getStringAttribute(span, 'langfuse.observation.output')).toBeUndefined();
    expect(requests[0]?.init.body).not.toContain('hello');
    expect(requests[0]?.init.body).not.toContain('world');
  });

  it('keeps OTEL disabled without an endpoint and preserves trace endpoint paths', async () => {
    expect(createOtelRuntimeEventExporterFromEnv({})).toBeInstanceOf(NoopRuntimeEventExporter);
    expect(
      createOtelRuntimeEventExporterFromEnv({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      }),
    ).toBeInstanceOf(NoopRuntimeEventExporter);

    const requests: Array<{ input: string }> = [];
    const exporter = new OtelRuntimeEventExporter(
      {
        enabled: true,
        endpoint: 'https://otel.example.com/v1/traces',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      async (input) => {
        requests.push({ input });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'otel-event-1',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
    });
    await exporter.flush();

    expect(requests[0]?.input).toBe('https://otel.example.com/v1/traces');
  });

  it('keeps failed OTEL batches queued for retry', async () => {
    let attempt = 0;
    const exporter = new OtelRuntimeEventExporter(
      {
        enabled: true,
        endpoint: 'https://otel.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      async () => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, status: 502, text: async () => 'bad gateway' };
        }
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'otel-event-1',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
    });

    await expect(exporter.flush()).rejects.toThrow('OTEL export failed with 502');
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  it('exports traces and nested spans through the Langfuse SDK transport', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
        serviceName: 'pi-task-worker',
        serviceVersion: '0.1.0-test',
      },
      client,
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      taskRunId: '003cc514-4f61-4f9c-b497-6ec99967d6d1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'tool-event-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.500Z',
      args: { command: 'pwd' },
    });
    await exporter.publish({
      id: 'tool-event-2',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 500,
      details: { exitCode: 0 },
    });
    await exporter.publish({
      id: 'event-2',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:02.000Z',
      durationMs: 2000,
      details: { output: 'world' },
    });
    await exporter.publish({
      id: 'legacy-event-1',
      traceId: '33333333333333333333333333333333',
      type: 'subagent_started',
      sessionId: 'session-2',
      runId: '20b486e7-8832-45cf-8457-674d17a5f014',
      createdAt: '2026-05-02T00:00:03.000Z',
    });
    await exporter.flush();
    await exporter.close();

    expect(client.traces).toHaveLength(2);
    expect(client.flushed).toBe(3);
    expect(client.closed).toBe(1);
    expect(client.traces[0]?.body).toMatchObject({
      sessionId: 'session-1',
      name: 'chat-turn',
      input: 'hello',
      tags: ['pi-task-worker'],
      metadata: {
        serviceName: 'pi-task-worker',
        taskRunId: '003cc514-4f61-4f9c-b497-6ec99967d6d1',
      },
    });
    expect(client.traces[0]?.body.metadata).not.toHaveProperty('serviceVersion');
    expect(client.traces[1]?.body.metadata).toMatchObject({ taskRunId: '20b486e7' });
    const traceUpdates = client.traces[0]?.updates ?? [];
    expect(traceUpdates[traceUpdates.length - 1]).toMatchObject({
      output: 'world',
      metadata: { durationMs: 2000 },
    });
    const rootSpan = client.traces[0]?.spans[0];
    const toolSpan = rootSpan?.spans[0];
    expect(rootSpan?.body).toMatchObject({
      name: 'chat-turn',
      input: 'hello',
      level: 'DEFAULT',
    });
    const rootSpanUpdates = rootSpan?.updates ?? [];
    expect(rootSpanUpdates[rootSpanUpdates.length - 1]).toMatchObject({
      output: 'world',
      endTime: '2026-05-02T00:00:02.000Z',
      level: 'DEFAULT',
    });
    expect(toolSpan?.body).toMatchObject({
      name: 'run_shell [pwd]',
      input: { args: { command: 'pwd' } },
      level: 'DEFAULT',
    });
    const toolSpanUpdates = toolSpan?.updates ?? [];
    expect(toolSpanUpdates[toolSpanUpdates.length - 1]).toMatchObject({
      output: { exitCode: 0 },
      endTime: '2026-05-02T00:00:01.000Z',
      level: 'DEFAULT',
    });
  });

  it('exports LLM generations as Langfuse generations with usage', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'model-event-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      input: 'hello',
    });
    await exporter.publish({
      id: 'model-event-2',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 900,
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      output: 'world',
      usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16 },
      stopReason: 'stop',
    });

    const generation = client.traces[0]?.spans[0]?.generations[0];
    expect(generation?.body).toMatchObject({
      name: 'llm-generation [main] [hello]',
      startTime: '2026-05-02T00:00:00.100Z',
      endTime: '2026-05-02T00:00:01.000Z',
      model: 'kimi-k2.5',
      input: 'hello',
      output: 'world',
      level: 'DEFAULT',
      usage: { input: 10, output: 3, total: 16, unit: 'TOKENS' },
      usageDetails: { input: 10, output: 3, cache_read: 2, cache_write: 1, total: 16 },
    });
    expect(generation?.updates).toHaveLength(0);
  });

  it('keeps generation start and terminal data in one SDK create event', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'generation-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: {
        provider: 'anthropic-compatible',
        model: 'kimi-k2.5',
        thinkingLevel: 'off',
      },
      input: { messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(client.traces[0]?.spans[0]?.generations).toHaveLength(0);

    await exporter.publish({
      id: 'generation-complete',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'fallback-provider', model: 'fallback-model' },
      output: 'world',
      usage: { input: 10, output: 3, totalTokens: 13 },
    });

    const generation = client.traces[0]?.spans[0]?.generations[0];
    expect(generation?.body).toMatchObject({
      startTime: '2026-05-02T00:00:00.100Z',
      endTime: '2026-05-02T00:00:01.000Z',
      input: { messages: [{ role: 'user', content: 'hello' }] },
      output: 'world',
      usage: { input: 10, output: 3, total: 13, unit: 'TOKENS' },
      model: 'kimi-k2.5',
      modelParameters: { provider: 'anthropic-compatible', thinkingLevel: 'off' },
      metadata: {
        llmGenerationId: 'call-1',
        status: 'completed',
        model: 'anthropic-compatible/kimi-k2.5',
        thinkingLevel: 'off',
      },
    });
    expect(generation?.updates).toHaveLength(0);
  });

  it('keeps interleaved sessions isolated while completing generations', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );
    const otherTraceId = '22222222222222222222222222222222';

    for (const [sessionId, sessionTraceId, input] of [
      ['session-a', traceId, 'alpha'],
      ['session-b', otherTraceId, 'beta'],
    ] as const) {
      await exporter.publish({
        id: `turn-${sessionId}`,
        traceId: sessionTraceId,
        type: 'chat_turn_started',
        sessionId,
        conversationId: sessionId,
        createdAt: '2026-05-02T00:00:00.000Z',
      });
      await exporter.publish({
        id: `start-${sessionId}`,
        traceId: sessionTraceId,
        sessionId,
        conversationId: sessionId,
        llmGenerationId: 'call-1',
        status: 'started',
        createdAt: '2026-05-02T00:00:00.100Z',
        model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
        input,
      });
    }

    for (const [sessionId, sessionTraceId, output] of [
      ['session-b', otherTraceId, 'beta-result'],
      ['session-a', traceId, 'alpha-result'],
    ] as const) {
      await exporter.publish({
        id: `complete-${sessionId}`,
        traceId: sessionTraceId,
        sessionId,
        conversationId: sessionId,
        llmGenerationId: 'call-1',
        status: 'completed',
        createdAt: '2026-05-02T00:00:01.000Z',
        model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
        output,
        usage: { input: 10, output: 2, totalTokens: 12 },
      });
    }

    const generationBySession = new Map(
      client.traces.map((candidate) => [
        candidate.body.sessionId,
        candidate.spans[0]?.generations[0],
      ]),
    );
    expect(generationBySession.get('session-a')?.body).toMatchObject({
      input: 'alpha',
      output: 'alpha-result',
      endTime: '2026-05-02T00:00:01.000Z',
    });
    expect(generationBySession.get('session-b')?.body).toMatchObject({
      input: 'beta',
      output: 'beta-result',
      endTime: '2026-05-02T00:00:01.000Z',
    });
    expect(generationBySession.get('session-a')?.updates).toHaveLength(0);
    expect(generationBySession.get('session-b')?.updates).toHaveLength(0);
  });

  it('creates one closed error generation when the provider request fails', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'generation-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      input: 'hello',
    });
    await exporter.publish({
      id: 'generation-failed',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'failed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      error: 'HTTP 503',
    });

    const generation = client.traces[0]?.spans[0]?.generations[0];
    expect(generation?.body).toMatchObject({
      startTime: '2026-05-02T00:00:00.100Z',
      endTime: '2026-05-02T00:00:01.000Z',
      input: 'hello',
      output: { error: 'HTTP 503' },
      level: 'ERROR',
      statusMessage: 'HTTP 503',
      metadata: { llmGenerationId: 'call-1', status: 'failed' },
    });
    expect(generation?.updates).toHaveLength(0);
  });

  it('drops abandoned starts when their chat turn closes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'generation-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      input: 'abandoned input',
    });
    await exporter.publish({
      id: 'turn-failed',
      traceId,
      type: 'chat_turn_failed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.500Z',
      error: 'cancelled',
    });
    await exporter.publish({
      id: 'late-generation-terminal',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'call-1',
      status: 'failed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      error: 'cancelled',
    });

    const generation = client.traces[0]?.spans[0]?.generations[0];
    expect(generation?.body).toMatchObject({
      startTime: '2026-05-02T00:00:01.000Z',
      endTime: '2026-05-02T00:00:01.000Z',
      output: { error: 'cancelled' },
    });
    expect(generation?.body.input).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[pi-telemetry] dropped 1 pending Langfuse generation start during lifecycle cleanup; late terminal events will be output-only',
    );
  });

  it('drops abandoned starts when their subagent lifecycle closes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'parent',
      conversationId: 'parent',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'subagent-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      createdAt: '2026-05-02T00:00:00.050Z',
    });
    await exporter.publish({
      id: 'generation-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      input: 'abandoned subagent input',
    });
    await exporter.publish({
      id: 'subagent-cancelled',
      traceId,
      type: 'subagent_cancelled',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      createdAt: '2026-05-02T00:00:00.500Z',
      error: 'cancelled',
    });
    await exporter.publish({
      id: 'late-generation-terminal',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      llmGenerationId: 'call-1',
      status: 'failed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      error: 'cancelled',
    });

    const rootSpan = client.traces[0]?.spans[0];
    const subagentSpan = rootSpan?.spans.find((span) => span.body.name === 'subagent');
    const generation = subagentSpan?.generations[0];
    expect(generation?.body).toMatchObject({
      startTime: '2026-05-02T00:00:01.000Z',
      endTime: '2026-05-02T00:00:01.000Z',
      output: { error: 'cancelled' },
    });
    expect(generation?.body.input).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[pi-telemetry] dropped 1 pending Langfuse generation start during lifecycle cleanup; late terminal events will be output-only',
    );
  });

  it('clears abandoned starts when the exporter closes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'generation-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'session-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      input: 'abandoned input',
    });

    const pendingGenerations = (
      exporter as unknown as {
        pendingGenerations: Map<string, unknown>;
      }
    ).pendingGenerations;
    expect(pendingGenerations).toHaveLength(1);
    await exporter.close();

    expect(client.closed).toBe(1);
    expect(pendingGenerations).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      '[pi-telemetry] dropped 1 pending Langfuse generation start during exporter close; late terminal events will be output-only',
    );
  });

  it('bounds abandoned starts and degrades evicted terminals to closed output-only records', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 20,
        flushIntervalMs: 5_000,
        includePayloads: true,
      },
      client,
    );

    await exporter.publish({
      id: 'turn-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-0',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    for (let index = 0; index <= 128; index += 1) {
      await exporter.publish({
        id: `generation-start-${index}`,
        traceId,
        sessionId: `session-${index}`,
        conversationId: `session-${index}`,
        llmGenerationId: 'call-1',
        status: 'started',
        createdAt: '2026-05-02T00:00:00.100Z',
        model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
        input: `input-${index}`,
      });
    }
    await exporter.publish({
      id: 'evicted-generation-terminal',
      traceId,
      sessionId: 'session-0',
      conversationId: 'session-0',
      llmGenerationId: 'call-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5' },
      output: 'completed after eviction',
      usage: { input: 1, output: 1, totalTokens: 2 },
    });

    const generation = client.traces[0]?.spans[0]?.generations[0];
    expect(generation?.body).toMatchObject({
      startTime: '2026-05-02T00:00:01.000Z',
      endTime: '2026-05-02T00:00:01.000Z',
      output: 'completed after eviction',
    });
    expect(generation?.body.input).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[pi-telemetry] dropped 1 pending Langfuse generation start during capacity eviction; late terminal events will be output-only',
    );
  });

  it('nests subagent model and tool observations under the subagent span', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'root-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'parent',
      conversationId: 'parent',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'parent task' },
    });
    await exporter.publish({
      id: 'spawn-tool-start',
      traceId,
      sessionId: 'parent',
      conversationId: 'parent',
      toolCallId: 'spawn-call-1',
      toolName: 'sessions_spawn',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.050Z',
      args: { task: 'child task' },
    });
    await exporter.publish({
      id: 'subagent-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:00.100Z',
      details: {
        agent: 'legal',
        input: 'child task',
        taskRunId: 'run-1',
        spawnBatchId: 'trace:11111111111111111111111111111111',
      },
    });
    await exporter.publish({
      id: 'child-model-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.200Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      input: 'child task',
    });
    await exporter.publish({
      id: 'child-model-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-call-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.500Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      output: 'child answer',
    });
    await exporter.publish({
      id: 'child-tool-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.600Z',
      args: { path: 'README.md' },
    });
    await exporter.publish({
      id: 'child-tool-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.700Z',
      details: { policy: 'allow' },
    });

    const trace = client.traces.find((candidate) => candidate.body.sessionId === 'parent');
    const rootSpan = trace?.spans[0];
    const spawnToolSpan = rootSpan?.spans.find(
      (span) => span.body.name === 'sessions_spawn [child task]',
    );
    const batchSpan = rootSpan?.spans.find((span) => span.body.name === 'subagent fan-out');
    const subagentSpan = batchSpan?.spans[0];
    expect(trace?.body).toMatchObject({ sessionId: 'parent' });
    expect(rootSpan?.body).toMatchObject({ name: 'chat-turn' });
    expect(spawnToolSpan?.body).toMatchObject({ name: 'sessions_spawn [child task]' });
    expect(batchSpan?.body).toMatchObject({
      name: 'subagent fan-out',
      metadata: { spawnBatchId: '11111111' },
    });
    expect(subagentSpan?.body).toMatchObject({ name: 'subagent [legal]' });
    expect(subagentSpan?.generations[0]?.body).toMatchObject({
      name: 'llm-generation [subagent] [child task]',
      input: 'child task',
    });
    expect(subagentSpan?.spans[0]?.body).toMatchObject({
      name: 'read_file [README.md]',
      input: { args: { path: 'README.md' } },
    });
  });

  it('keeps nesting tool and LLM events under root span across multiple turns', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'event-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'gen-1-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'gen-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      input: 'hello',
    });
    await exporter.publish({
      id: 'gen-1-done',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'gen-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      output: 'I will use a tool',
    });
    await exporter.publish({
      id: 'turn-end-1',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.100Z',
      durationMs: 1100,
      details: { output: 'I will use a tool' },
    });

    await exporter.publish({
      id: 'tool-start-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'started',
      createdAt: '2026-05-02T00:00:01.200Z',
      args: { command: 'ls' },
    });
    await exporter.publish({
      id: 'tool-done-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.500Z',
      details: { exitCode: 0 },
    });
    await exporter.publish({
      id: 'gen-2-start',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'gen-2',
      status: 'started',
      createdAt: '2026-05-02T00:00:01.600Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      input: 'tool result',
    });
    await exporter.publish({
      id: 'gen-2-done',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'gen-2',
      status: 'completed',
      createdAt: '2026-05-02T00:00:02.000Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      output: 'done',
    });
    await exporter.publish({
      id: 'turn-end-2',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:02.100Z',
      durationMs: 2100,
      details: { output: 'done' },
    });

    const rootSpan = client.traces[0]?.spans[0];
    expect(rootSpan?.body).toMatchObject({ name: 'chat-turn' });
    expect(rootSpan?.generations).toHaveLength(2);
    expect(rootSpan?.generations[0]?.body).toMatchObject({ name: 'llm-generation [main] [hello]' });
    expect(rootSpan?.generations[1]?.body).toMatchObject({
      name: 'llm-generation [main] [tool result]',
    });
    expect(rootSpan?.spans).toHaveLength(1);
    expect(rootSpan?.spans[0]?.body).toMatchObject({ name: 'run_shell [ls]' });
  });

  it('keeps nesting subagent events under the subagent span across multiple turns', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'root-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'parent',
      conversationId: 'parent',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'parent task' },
    });
    await exporter.publish({
      id: 'subagent-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:00.100Z',
      details: { input: 'child task' },
    });

    await exporter.publish({
      id: 'child-gen-1-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-gen-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.200Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      input: 'child task',
    });
    await exporter.publish({
      id: 'child-gen-1-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-gen-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.500Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      output: 'using tool',
    });

    await exporter.publish({
      id: 'subagent-completed-1',
      traceId,
      type: 'subagent_completed',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:00.600Z',
      details: { output: 'using tool' },
    });

    await exporter.publish({
      id: 'child-tool-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.700Z',
      args: { path: 'src/index.ts' },
    });
    await exporter.publish({
      id: 'child-tool-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.900Z',
      details: { policy: 'allow' },
    });

    await exporter.publish({
      id: 'child-gen-2-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-gen-2',
      status: 'started',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      input: 'tool result',
    });
    await exporter.publish({
      id: 'child-gen-2-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-gen-2',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.300Z',
      model: { provider: 'anthropic', model: 'claude-4' },
      output: 'final answer',
    });

    await exporter.publish({
      id: 'subagent-completed-2',
      traceId,
      type: 'subagent_completed',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:01.400Z',
      details: { output: 'final answer' },
    });

    const trace = client.traces.find((candidate) => candidate.body.sessionId === 'parent');
    const rootSpan = trace?.spans[0];
    const batchSpan = rootSpan?.spans.find((span) => span.body.name === 'subagent fan-out');
    const subagentSpan = batchSpan?.spans[0];

    expect(subagentSpan?.body).toMatchObject({ name: 'subagent' });
    expect(subagentSpan?.generations).toHaveLength(2);
    expect(subagentSpan?.generations[0]?.body).toMatchObject({
      name: 'llm-generation [subagent] [child task]',
    });
    expect(subagentSpan?.generations[1]?.body).toMatchObject({
      name: 'llm-generation [subagent] [tool result]',
    });
    expect(subagentSpan?.spans).toHaveLength(1);
    expect(subagentSpan?.spans[0]?.body).toMatchObject({
      name: 'read_file [src/index.ts]',
    });
  });

  it('preserves batch span for new subagents after closeSdkSubagentBatchSpans', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'root-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'parent',
      conversationId: 'parent',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'spawn agents' },
    });

    await exporter.publish({
      id: 'subagent-1-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:00.100Z',
      details: { agent: 'legal', input: 'task-1' },
    });
    await exporter.publish({
      id: 'subagent-1-done',
      traceId,
      type: 'subagent_completed',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { output: 'result-1' },
    });

    await exporter.publish({
      id: 'turn-end-1',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'parent',
      conversationId: 'parent',
      createdAt: '2026-05-02T00:00:01.100Z',
      durationMs: 1100,
      details: { output: 'partial' },
    });

    await exporter.publish({
      id: 'subagent-2-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent:subagent:2',
      conversationId: 'parent:subagent:2',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:2',
      runId: 'run-2',
      taskRunId: 'run-2',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-2',
      createdAt: '2026-05-02T00:00:01.200Z',
      details: { agent: 'finance', input: 'task-2' },
    });
    await exporter.publish({
      id: 'subagent-2-done',
      traceId,
      type: 'subagent_completed',
      sessionId: 'parent:subagent:2',
      conversationId: 'parent:subagent:2',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:2',
      runId: 'run-2',
      taskRunId: 'run-2',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-2',
      createdAt: '2026-05-02T00:00:02.000Z',
      details: { output: 'result-2' },
    });

    const trace = client.traces.find((candidate) => candidate.body.sessionId === 'parent');
    const rootSpan = trace?.spans[0];
    const batchSpan = rootSpan?.spans.find((span) => span.body.name === 'subagent fan-out');

    expect(batchSpan).toBeDefined();
    expect(batchSpan?.spans).toHaveLength(2);
    expect(batchSpan?.spans[0]?.body).toMatchObject({ name: 'subagent [legal]' });
    expect(batchSpan?.spans[1]?.body).toMatchObject({ name: 'subagent [finance]' });
    const sub0Updates = batchSpan?.spans[0]?.updates ?? [];
    const sub1Updates = batchSpan?.spans[1]?.updates ?? [];
    expect(sub0Updates[sub0Updates.length - 1]).toMatchObject({ output: 'result-1' });
    expect(sub1Updates[sub1Updates.length - 1]).toMatchObject({ output: 'result-2' });
  });
});

function getStringAttribute(
  span: { attributes: Array<{ key: string; value: { stringValue?: string } }> },
  key: string,
): string | undefined {
  return span.attributes.find((attribute) => attribute.key === key)?.value.stringValue;
}

class FakeLangfuseSdkClient implements LangfuseSdkClient {
  readonly traces: FakeLangfuseSdkTraceClient[] = [];
  flushed = 0;
  flushFailuresRemaining = 0;
  closed = 0;

  trace(body?: Record<string, unknown>): LangfuseSdkTraceClient {
    const trace = new FakeLangfuseSdkTraceClient(body ?? {});
    this.traces.push(trace);
    return trace;
  }

  async flushAsync(): Promise<void> {
    this.flushed += 1;
    if (this.flushFailuresRemaining > 0) {
      this.flushFailuresRemaining -= 1;
      throw new Error('transient flush failure');
    }
  }

  async shutdownAsync(): Promise<void> {
    this.closed += 1;
  }
}

class FakeLangfuseSdkTraceClient implements LangfuseSdkTraceClient {
  readonly updates: Array<Record<string, unknown>> = [];
  readonly spans: FakeLangfuseSdkSpanClient[] = [];
  readonly generations: FakeLangfuseSdkGenerationClient[] = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): unknown {
    this.updates.push(body);
    return this;
  }

  span(body: Record<string, unknown>): LangfuseSdkSpanClient {
    const span = new FakeLangfuseSdkSpanClient(body);
    this.spans.push(span);
    return span;
  }

  generation(body: Record<string, unknown>): LangfuseSdkGenerationClient {
    const generation = new FakeLangfuseSdkGenerationClient(body);
    this.generations.push(generation);
    return generation;
  }
}

class FakeLangfuseSdkSpanClient implements LangfuseSdkSpanClient {
  readonly updates: Array<Record<string, unknown>> = [];
  readonly spans: FakeLangfuseSdkSpanClient[] = [];
  readonly generations: FakeLangfuseSdkGenerationClient[] = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): unknown {
    this.updates.push(body);
    return this;
  }

  span(body: Record<string, unknown>): LangfuseSdkSpanClient {
    const span = new FakeLangfuseSdkSpanClient(body);
    this.spans.push(span);
    return span;
  }

  generation(body: Record<string, unknown>): LangfuseSdkGenerationClient {
    const generation = new FakeLangfuseSdkGenerationClient(body);
    this.generations.push(generation);
    return generation;
  }
}

class FakeLangfuseSdkGenerationClient implements LangfuseSdkGenerationClient {
  readonly updates: Array<Record<string, unknown>> = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): unknown {
    this.updates.push(body);
    return this;
  }
}
