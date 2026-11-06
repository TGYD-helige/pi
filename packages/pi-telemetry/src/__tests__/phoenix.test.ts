import { once } from 'node:events';
import { createServer } from 'node:http';
import { SpanStatusCode } from '@opentelemetry/api';
import { OTLPTraceExporter as OtlpJsonExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OtlpProtoExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryExporter } from '../otel.js';
import {
  phoenixTestContext as context,
  phoenixTestModel as model,
  publishPromptTrace,
} from './phoenix-fixture.js';

function hrTimeToMs([seconds, nanos]: [number, number]): number {
  return seconds * 1000 + nanos / 1_000_000;
}

afterEach(() => {
  delete process.env.PI_TELEMETRY_TRACEPARENT;
  vi.restoreAllMocks();
});

describe('Phoenix telemetry export', () => {
  it('exports OpenInference protobuf spans alongside unchanged Langfuse and generic OTLP', async () => {
    const phoenixSpans: ReadableSpan[] = [];
    const otherSpans: ReadableSpan[] = [];
    const protoExport = OtlpProtoExporter.prototype.export;
    const jsonExport = OtlpJsonExporter.prototype.export;
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation(function (
      this: OtlpProtoExporter,
      spans,
      callback,
    ) {
      phoenixSpans.push(...spans);
      return protoExport.call(this, spans, callback);
    });
    vi.spyOn(OtlpJsonExporter.prototype, 'export').mockImplementation(function (
      this: OtlpJsonExporter,
      spans,
      callback,
    ) {
      otherSpans.push(...spans);
      return jsonExport.call(this, spans, callback);
    });

    const requests: Array<{
      url: string;
      contentType: string;
      authorization: string;
      bytes: number;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        url: request.url ?? '',
        contentType: String(request.headers['content-type']),
        authorization: String(request.headers.authorization),
        bytes: Buffer.concat(chunks).length,
      });
      const protobuf = request.headers['content-type'] === 'application/x-protobuf';
      response.writeHead(200, {
        'content-type': protobuf ? 'application/x-protobuf' : 'application/json',
      });
      response.end(protobuf ? undefined : '{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server port');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const exporter = createTelemetryExporter({
      includePayloads: true,
      langfuse: {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: endpoint,
        flushAt: 100,
        flushIntervalMs: 60_000,
      },
      otel: {
        enabled: true,
        endpoint,
        headers: { Authorization: 'Bearer generic-secret' },
        flushAt: 100,
        flushIntervalMs: 60_000,
      },
      phoenix: {
        enabled: true,
        endpoint: `${endpoint}/phoenix/`,
        apiKey: 'phoenix-secret',
        projectName: 'pi-tests',
        flushAt: 100,
        flushIntervalMs: 60_000,
      },
    });

    try {
      await publishPromptTrace(exporter);
      await exporter.flush?.();

      expect(phoenixSpans).toHaveLength(5);
      expect(otherSpans).toHaveLength(10);
      const otherById = new Map(
        otherSpans.map((span) => [
          `${span.spanContext().traceId}/${span.spanContext().spanId}`,
          span,
        ]),
      );
      for (const span of phoenixSpans) {
        const other = otherById.get(`${span.spanContext().traceId}/${span.spanContext().spanId}`);
        expect(other).toBeDefined();
        expect(span.parentSpanContext?.spanId).toBe(other?.parentSpanContext?.spanId);
        expect(span.startTime).toEqual(other?.startTime);
        expect(span.endTime).toEqual(other?.endTime);
        expect(span.resource.attributes['openinference.project.name']).toBe('pi-tests');
        expect(other?.resource.attributes['openinference.project.name']).toBeUndefined();
        expect(Object.keys(span.attributes).some((key) => key.startsWith('langfuse.'))).toBe(false);
      }
      expect(
        otherSpans.every((span) => span.attributes['openinference.span.kind'] === undefined),
      ).toBe(true);

      const root = phoenixSpans.find((span) => span.name === 'chat-turn')!;
      const generation = phoenixSpans.find(
        (span) => span.attributes.llmGenerationId === 'generation-1',
      )!;
      const tool = phoenixSpans.find((span) => span.attributes.toolCallId === 'call-1')!;
      expect(root.attributes).toMatchObject({
        'openinference.span.kind': 'AGENT',
        'session.id': 'session-1',
        'input.value': 'hello',
        'input.mime_type': 'text/plain',
        'output.value': 'done',
        'output.mime_type': 'text/plain',
      });
      expect(phoenixSpans.find((span) => span.name === 'chat-input')?.attributes).toMatchObject({
        'openinference.span.kind': 'CHAIN',
      });
      expect(generation.attributes).toMatchObject({
        'openinference.span.kind': 'LLM',
        'llm.system': 'deepseek',
        'llm.provider': 'deepseek',
        'llm.model_name': 'deepseek-v4-flash',
        'llm.token_count.prompt': 150,
        'llm.token_count.prompt_details.cache_read': 20,
        'llm.token_count.prompt_details.cache_write': 30,
        'llm.token_count.completion': 40,
        'llm.token_count.completion_details.reasoning': 10,
        'llm.token_count.total': 190,
        'llm.cost.prompt': 1.5,
        'llm.cost.prompt_details.input': 1,
        'llm.cost.prompt_details.cache_read': 0.2,
        'llm.cost.prompt_details.cache_write': 0.3,
        'llm.cost.completion': 4,
        'llm.cost.total': 5.5,
        'input.mime_type': 'application/json',
        'output.mime_type': 'application/json',
      });
      expect(generation.attributes['llm.cost.completion_details.output']).toBeUndefined();
      const firstToken = generation.events.find((event) => event.name === 'first_token');
      expect(firstToken).toBeDefined();
      expect(hrTimeToMs(firstToken!.time)).toBe(Date.parse('2026-05-02T00:00:00.300Z'));
      expect(tool.attributes).toMatchObject({
        'openinference.span.kind': 'TOOL',
        'tool.name': 'bash',
        'tool.id': 'call-1',
        'input.value': JSON.stringify({ command: 'echo hi' }),
      });
      expect(tool.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'command failed' });

      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: '/phoenix/v1/traces',
            contentType: 'application/x-protobuf',
            authorization: 'Bearer phoenix-secret',
          }),
          expect.objectContaining({
            url: '/v1/traces',
            contentType: 'application/json',
            authorization: 'Bearer generic-secret',
          }),
          expect.objectContaining({
            url: '/api/public/otel/v1/traces',
            contentType: 'application/json',
          }),
        ]),
      );
      expect(
        requests.find((request) => request.url === '/phoenix/v1/traces')?.bytes,
      ).toBeGreaterThan(0);
    } finally {
      await exporter.close?.();
      server.close();
      await once(server, 'close');
    }
  });

  it('omits aggregates when their required usage components were not reported', async () => {
    const phoenixSpans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((spans, callback) => {
      phoenixSpans.push(...spans);
      callback({ code: 0 });
    });
    const exporter = createTelemetryExporter({
      phoenix: { enabled: true, endpoint: 'https://phoenix.example.com' },
    });

    try {
      await exporter.publish({
        ...context,
        id: 'partial-usage',
        llmGenerationId: 'partial-usage',
        status: 'completed',
        createdAt: '2026-05-02T00:00:00.500Z',
        model,
        usage: {
          output: 2,
          cacheRead: 20,
          costSource: 'provided',
          cost: { cacheRead: 0.2 },
        },
      });
      await exporter.flush?.();
      const attributes = phoenixSpans[0]!.attributes;
      expect(attributes['llm.token_count.prompt']).toBeUndefined();
      expect(attributes['llm.token_count.total']).toBeUndefined();
      expect(attributes['llm.cost.prompt']).toBeUndefined();
      expect(attributes['llm.token_count.completion']).toBe(2);
      expect(attributes['llm.token_count.prompt_details.cache_read']).toBe(20);
      expect(attributes['llm.cost.prompt_details.cache_read']).toBe(0.2);
    } finally {
      await exporter.close?.();
    }
  });

  it('reports a Phoenix failure even when generic OTLP succeeds', async () => {
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((_spans, callback) => {
      callback({ code: 1 });
    });
    vi.spyOn(OtlpJsonExporter.prototype, 'export').mockImplementation((_spans, callback) => {
      callback({ code: 0 });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exporter = createTelemetryExporter({
      otel: { enabled: true, endpoint: 'https://otel.example.com' },
      phoenix: {
        enabled: true,
        endpoint: 'https://phoenix.example.com',
        apiKey: 'phoenix-secret',
      },
    });

    try {
      await exporter.publish({
        ...context,
        id: 'turn-end',
        type: 'chat_turn_completed',
        createdAt: '2026-05-02T00:00:01.000Z',
      });
      await exporter.flush?.();
      expect(exporter.getStatus?.()).toMatchObject({ state: 'error' });
      expect(JSON.stringify(errors.mock.calls)).toContain('phoenix export failed');
      expect(JSON.stringify(errors.mock.calls)).not.toContain('phoenix-secret');
    } finally {
      await exporter.close?.();
    }
  });

  it('suppresses payloads and masks every destination credential', async () => {
    const phoenixSpans: ReadableSpan[] = [];
    const otherSpans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((spans, callback) => {
      phoenixSpans.push(...spans);
      callback({ code: 0 });
    });
    vi.spyOn(OtlpJsonExporter.prototype, 'export').mockImplementation((spans, callback) => {
      otherSpans.push(...spans);
      callback({ code: 0 });
    });
    const exporter = createTelemetryExporter({
      includePayloads: false,
      langfuse: { enabled: true, publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' },
      otel: {
        enabled: true,
        endpoint: 'https://otel.example.com',
        headers: { Authorization: 'Bearer generic-secret' },
      },
      phoenix: {
        enabled: true,
        endpoint: 'https://phoenix.example.com/v1/traces/',
        apiKey: 'phoenix-secret',
      },
    });

    try {
      await publishPromptTrace(
        exporter,
        'hello phoenix-secret sk-lf-test generic-secret',
        'command failed: phoenix-secret sk-lf-test generic-secret',
      );
      await exporter.flush?.();
      expect(phoenixSpans).toHaveLength(4);
      expect(otherSpans).toHaveLength(8);
      for (const span of [...phoenixSpans, ...otherSpans]) {
        const serialized = JSON.stringify({ attributes: span.attributes, status: span.status });
        expect(serialized).not.toContain('phoenix-secret');
        expect(serialized).not.toContain('sk-lf-test');
        expect(serialized).not.toContain('generic-secret');
      }
      for (const span of phoenixSpans) {
        expect(span.attributes['input.value']).toBeUndefined();
        expect(span.attributes['output.value']).toBeUndefined();
        expect(span.attributes['input.mime_type']).toBeUndefined();
        expect(span.attributes['output.mime_type']).toBeUndefined();
      }
      expect(JSON.stringify([...phoenixSpans, ...otherSpans].map((span) => span.status))).toContain(
        '[redacted]',
      );
      const generation = phoenixSpans.find(
        (span) => span.attributes.llmGenerationId === 'generation-1',
      )!;
      expect(generation.attributes['llm.token_count.prompt']).toBe(150);
      expect(generation.attributes['llm.token_count.completion']).toBe(40);
      expect(generation.attributes['llm.token_count.total']).toBe(190);
    } finally {
      await exporter.close?.();
    }
  });
});
