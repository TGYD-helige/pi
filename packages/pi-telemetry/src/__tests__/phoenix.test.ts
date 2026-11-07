import { once } from 'node:events';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
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
  it('projects readable messages, tools, parameters and context without changing other destinations', async () => {
    const spans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((batch, callback) => {
      spans.push(...batch);
      callback({ code: 0 });
    });
    const exporter = createTelemetryExporter({
      includePayloads: true,
      serviceName: 'pi-tests',
      environment: 'test',
      release: 'release-1',
      phoenix: { enabled: true, endpoint: 'http://localhost:6006' },
    });
    try {
      await exporter.publish({
        ...context,
        id: 'start',
        llmGenerationId: 'gen-1',
        status: 'started',
        model,
        createdAt: '2026-05-02T00:00:00.100Z',
        modelParameters: { provider: 'deepseek', temperature: 0.2 },
        displayInput: [
          {
            role: 'system',
            content: 'System',
            tools: [
              { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
            ],
          },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"echo hi"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'hi' },
        ],
      });
      await exporter.publish({
        ...context,
        id: 'end',
        requestHeaders: { Authorization: 'hidden-token', 'x-session-id': 'session-1' },
        responseHeaders: { 'set-cookie': 'hidden-cookie', 'x-request-id': 'request-1' },
        llmGenerationId: 'gen-1',
        status: 'completed',
        model,
        createdAt: '2026-05-02T00:00:00.500Z',
        modelParameters: { provider: 'deepseek', temperature: 0.2 },
        displayOutput: {
          role: 'assistant',
          content: 'Done',
          thinking: [{ type: 'thinking', content: 'Reason' }],
        },
        completionStartTime: '2026-05-02T00:00:00.300Z',
        usage: { input: 1, output: 2, costSource: 'unknown' },
      });
      await exporter.flush?.();
      expect(spans[0]!.attributes).toMatchObject({
        'llm.input_messages.0.message.role': 'system',
        'llm.input_messages.0.message.content': 'System',
        'llm.input_messages.1.message.tool_calls.0.tool_call.function.name': 'bash',
        'llm.input_messages.2.message.tool_call_id': 'call-1',
        'llm.output_messages.0.message.role': 'assistant',
        'llm.output_messages.0.message.content': 'Done',
        'llm.invocation_parameters': JSON.stringify({ provider: 'deepseek', temperature: 0.2 }),
        'llm.time_to_first_token_ms': 200,
        'tag.tags': ['pi-tests'],
      });
      expect(
        JSON.parse(String(spans[0]!.attributes['llm.tools.0.tool.json_schema'])),
      ).toMatchObject({ name: 'bash' });
      expect(JSON.parse(String(spans[0]!.attributes['input.value']))[0].tools[0]).toMatchObject({
        name: 'bash',
      });
      expect(JSON.parse(String(spans[0]!.attributes.metadata))).toMatchObject({
        environment: 'test',
        release: 'release-1',
        costSource: 'unknown',
        requestHeaders: { Authorization: '[redacted]', 'x-session-id': 'session-1' },
        responseHeaders: { 'set-cookie': '[redacted]', 'x-request-id': 'request-1' },
      });
      expect(spans[0]!.attributes['llm.cost.total']).toBeUndefined();
    } finally {
      await exporter.close?.();
    }
  });

  it('preserves separate tool results, thinking, images and protocol-specific tools', async () => {
    const spans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((batch, callback) => {
      spans.push(...batch);
      callback({ code: 0 });
    });
    const exporter = createTelemetryExporter({
      includePayloads: true,
      mediaUploadEnabled: false,
      phoenix: { enabled: true, endpoint: 'http://localhost:6006' },
    });
    try {
      await exporter.publish({
        ...context,
        id: 'protocol-start',
        llmGenerationId: 'g',
        status: 'started',
        model,
        createdAt: new Date().toISOString(),
        displayInput: [
          {
            role: 'system',
            content: { parts: [{ text: 'Gemini system' }] },
            tools: [
              { functionDeclarations: [{ name: 'first' }, { name: 'second' }] },
              { type: 'function', function: { name: 'third' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'one', content: 'ONE' },
              { type: 'tool_result', tool_use_id: 'two', content: 'TWO' },
            ],
          },
          {
            type: 'function_call',
            id: 'fc-three',
            call_id: 'three',
            name: 'bash',
            arguments: '{}',
          },
          { type: 'function_call_output', call_id: 'three', output: 'THREE' },
        ],
      });
      await exporter.publish({
        ...context,
        id: 'protocol-end',
        llmGenerationId: 'g',
        status: 'completed',
        model,
        createdAt: new Date().toISOString(),
        displayOutput: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'why' },
            { type: 'text', text: 'answer' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
            },
          ],
        },
      });
      await exporter.flush?.();
      const attrs = spans[0]!.attributes;
      expect(attrs).toMatchObject({
        'llm.input_messages.0.message.content': 'Gemini system',
        'llm.input_messages.1.message.tool_call_id': 'one',
        'llm.input_messages.1.message.content': 'ONE',
        'llm.input_messages.2.message.tool_call_id': 'two',
        'llm.input_messages.2.message.content': 'TWO',
        'llm.input_messages.3.message.tool_calls.0.tool_call.id': 'three',
        'llm.input_messages.4.message.tool_call_id': 'three',
        'llm.output_messages.0.message.contents.0.message_content.text': 'why',
      });
      expect(JSON.stringify(attrs)).not.toContain('data:image/png');
      expect(Object.values(attrs)).toContain('answer');
      expect(JSON.parse(String(attrs['llm.tools.1.tool.json_schema'])).name).toBe('second');
      expect(JSON.parse(String(attrs['llm.tools.2.tool.json_schema'])).name).toBe('third');
    } finally {
      await exporter.close?.();
    }
  });

  it('marks projection limits when a single message expands into too many tool results', async () => {
    const spans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((batch, callback) => {
      spans.push(...batch);
      callback({ code: 0 });
    });
    const exporter = createTelemetryExporter({
      includePayloads: true,
      traceName: 'custom-task',
      phoenix: { enabled: true, endpoint: 'http://localhost:6006' },
    });
    try {
      await exporter.publish({
        ...context,
        id: 'root',
        type: 'chat_turn_completed',
        createdAt: new Date().toISOString(),
      });
      await exporter.publish({
        ...context,
        id: 'expanded-start',
        llmGenerationId: 'g',
        status: 'started',
        model,
        createdAt: new Date().toISOString(),
        displayInput: [
          {
            role: 'user',
            content: Array.from({ length: 101 }, (_, index) => ({
              type: 'tool_result',
              tool_use_id: `call-${index}`,
              content: String(index),
            })),
          },
        ],
      });
      await exporter.publish({
        ...context,
        id: 'expanded-end',
        llmGenerationId: 'g',
        status: 'completed',
        model,
        createdAt: new Date().toISOString(),
      });
      await exporter.flush?.();
      expect(spans[0]!.name).toBe('custom-task');
      expect(spans[1]!.attributes['pi.telemetry.projection.truncated']).toBe(true);
      expect(Object.values(spans[1]!.attributes)).toContain('call-100');
    } finally {
      await exporter.close?.();
    }
  });

  it('retains tools and a preview of the newest oversized message with explicit output truncation', async () => {
    const spans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((batch, callback) => {
      spans.push(...batch);
      callback({ code: 0 });
    });
    const exporter = createTelemetryExporter({
      includePayloads: true,
      phoenix: { enabled: true, endpoint: 'http://localhost:6006' },
    });
    try {
      await exporter.publish({
        ...context,
        id: 'large-start',
        llmGenerationId: 'g',
        status: 'started',
        model,
        createdAt: new Date().toISOString(),
        displayInput: [
          {
            role: 'system',
            content: 'system',
            tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
          },
          ...Array.from({ length: 100 }, () => ({ role: 'user', content: 'old' })),
          { role: 'user', content: `LATEST${'中'.repeat(200_000)}` },
        ],
      });
      await exporter.publish({
        ...context,
        id: 'large-end',
        llmGenerationId: 'g',
        status: 'completed',
        model,
        createdAt: new Date().toISOString(),
        displayOutput: Array.from({ length: 101 }, () => ({
          role: 'assistant',
          content: 'answer',
        })),
      });
      await exporter.flush?.();
      const attrs = spans[0]!.attributes;
      expect(String(attrs['input.value'])).toContain('LATEST');
      expect(Buffer.byteLength(String(attrs['input.value']))).toBeLessThanOrEqual(500_000);
      expect(JSON.parse(String(attrs['llm.tools.0.tool.json_schema'])).name).toBe('bash');
      expect(attrs['pi.telemetry.projection.truncated']).toBe(true);
    } finally {
      await exporter.close?.();
    }
  });

  it('bounds semantic attributes and retains the newest input, including with payloads disabled', async () => {
    const spans: ReadableSpan[] = [];
    vi.spyOn(OtlpProtoExporter.prototype, 'export').mockImplementation((batch, callback) => {
      spans.push(...batch);
      callback({ code: 0 });
    });
    for (const includePayloads of [true, false]) {
      const exporter = createTelemetryExporter({
        includePayloads,
        phoenix: { enabled: true, endpoint: 'http://localhost:6006' },
      });
      try {
        await exporter.publish({
          ...context,
          id: 'budget-start',
          llmGenerationId: 'g',
          status: 'started',
          model,
          createdAt: new Date().toISOString(),
          displayInput: [
            ...Array.from({ length: 150 }, () => ({ role: 'user', content: '中'.repeat(2000) })),
            { role: 'user', content: 'LATEST' },
          ],
        });
        await exporter.publish({
          ...context,
          id: 'budget-end',
          llmGenerationId: 'g',
          status: 'completed',
          model,
          createdAt: new Date().toISOString(),
        });
        await exporter.flush?.();
      } finally {
        await exporter.close?.();
      }
    }
    const semantic = Object.entries(spans[0]!.attributes).filter(([key]) =>
      key.startsWith('llm.input_messages.'),
    );
    expect(semantic.some(([, value]) => value === 'LATEST')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(semantic))).toBeLessThan(260_000);
    expect(spans[0]!.attributes['pi.telemetry.projection.truncated']).toBe(true);
    expect(
      Object.keys(spans[1]!.attributes).some((key) => key.startsWith('llm.input_messages.')),
    ).toBe(false);
  });

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
      encoding: string;
      decodedBytes: number;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        url: request.url ?? '',
        contentType: String(request.headers['content-type']),
        authorization: String(request.headers.authorization),
        bytes: Buffer.concat(chunks).length,
        encoding: String(request.headers['content-encoding']),
        decodedBytes:
          request.headers['content-encoding'] === 'gzip'
            ? gunzipSync(Buffer.concat(chunks)).length
            : Buffer.concat(chunks).length,
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
      expect(new Set(phoenixSpans.map((span) => span.resource)).size).toBe(1);
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
      expect(JSON.parse(String(generation.attributes.metadata)).reportedCost.total).toBe(5.5);
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
            encoding: 'gzip',
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
      const phoenixRequest = requests.find((request) => request.url === '/phoenix/v1/traces')!;
      expect(phoenixRequest.bytes).toBeLessThan(phoenixRequest.decodedBytes);
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

  it.each([
    'langfuse',
    'otel',
    'phoenix',
  ])('marks %s partial acceptance as an error without retrying', async (destination) => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url ?? '');
      request.resume();
      await once(request, 'end');
      const protobuf = destination === 'phoenix';
      response.writeHead(200, {
        'content-type': protobuf ? 'application/x-protobuf' : 'application/json',
      });
      response.end(
        protobuf
          ? Buffer.from([0x0a, 0x02, 0x08, 0x01])
          : JSON.stringify({ partialSuccess: { rejectedSpans: 1 } }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server port');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const exporter = createTelemetryExporter({
      ...(destination === 'langfuse'
        ? {
            langfuse: {
              enabled: true,
              publicKey: 'pk-test',
              secretKey: 'sk-test',
              baseUrl: endpoint,
            },
          }
        : destination === 'otel'
          ? { otel: { enabled: true, endpoint } }
          : { phoenix: { enabled: true, endpoint } }),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await exporter.publish({
        ...context,
        id: 'partial-rejection',
        type: 'chat_turn_completed',
        createdAt: '2026-05-02T00:00:01.000Z',
      });
      await exporter.flush?.();
      expect(exporter.getStatus?.()).toMatchObject({ state: 'error' });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(errors.mock.calls)).toContain(`${destination} rejected 1 span(s)`);
    } finally {
      await exporter.close?.();
      server.close();
      await once(server, 'close');
    }
  });

  it('accepts decimal string rejectedSpans in OTLP JSON', async () => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url ?? '');
      request.resume();
      await once(request, 'end');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ partialSuccess: { rejectedSpans: '1' } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server port');
    const exporter = createTelemetryExporter({
      otel: { enabled: true, endpoint: `http://127.0.0.1:${address.port}` },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await exporter.publish({
        ...context,
        id: 'partial-rejection-string',
        type: 'chat_turn_completed',
        createdAt: '2026-05-02T00:00:01.000Z',
      });
      await exporter.flush?.();
      expect(exporter.getStatus?.()).toMatchObject({ state: 'error' });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(errors.mock.calls)).toContain('otel rejected 1 span(s)');
    } finally {
      await exporter.close?.();
      server.close();
      await once(server, 'close');
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
