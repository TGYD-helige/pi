import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryConfig } from '../config.js';
import { loadConfigFromFile } from '../config.js';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfigFromFile: vi.fn(() => ({})),
}));

// The only mocked seam is the exporter factory: everything downstream — the
// extension's event mapping and the exporter's span logic — runs for real
// against an in-memory OTEL pipeline.
const { holder } = vi.hoisted(() => ({
  holder: {} as { inMemory?: InMemorySpanExporter },
}));

vi.mock('../otel.js', async () => {
  const { OtelRuntimeEventExporter } = await import('../langfuse/exporters.js');
  return {
    createTelemetryExporter: vi.fn((config: TelemetryConfig) => {
      const inMemory = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(inMemory)],
      });
      holder.inMemory = inMemory;
      return new OtelRuntimeEventExporter(
        {
          enabled: true,
          endpoint: '',
          includePayloads: true,
          mediaUploadEnabled: config.mediaUploadEnabled === true,
          flushAt: 10,
          flushIntervalMs: 60_000,
        },
        { provider },
      );
    }),
  };
});

type EventHandler = (...args: any[]) => Promise<void> | void;

const handlers = new Map<string, EventHandler>();

const mockPi = {
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  on: vi.fn((event: string, handler: EventHandler) => {
    handlers.set(event, handler);
  }),
};

const { default: telemetryExtension } = await import('../extension.js');

async function fireEvent(name: string, event?: unknown, ctx?: Record<string, unknown>) {
  const handler = handlers.get(name);
  if (handler) await handler(event, ctx ?? {});
}

function assistantMessage(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('interrupt flow', () => {
  // InMemorySpanExporter.shutdown() clears its buffer on close, so record
  // every export call instead of reading finished spans after the fact.
  let exported: ReadableSpan[];

  beforeEach(() => {
    handlers.clear();
    exported = [];
    vi.mocked(loadConfigFromFile).mockReturnValue({});
    telemetryExtension(mockPi as any);
  });

  afterEach(() => {
    delete process.env.PI_TELEMETRY_TRACEPARENT;
  });

  function recordExports(): void {
    const inMemory = holder.inMemory;
    if (!inMemory) throw new Error('exporter not created — fire session_start first');
    const originalExport = inMemory.export.bind(inMemory);
    vi.spyOn(inMemory, 'export').mockImplementation((spans, callback) => {
      exported.push(...spans);
      return originalExport(spans, callback);
    });
  }

  it('does not export an extra completed generation after an HTTP failure', async () => {
    await fireEvent('session_start', {});
    recordExports();
    await fireEvent('input', { text: 'fail' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('before_provider_request', { payload: {} });
    await fireEvent('after_provider_response', { status: 429 });
    const message = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'rate limited',
    };
    await fireEvent('message_end', { message });
    await fireEvent('agent_end', { messages: [message] });
    await fireEvent('agent_settled', {});
    const generations = exported.filter(
      (span) => span.attributes['langfuse.observation.type'] === 'generation',
    );
    expect(generations).toHaveLength(1);
    expect(generations[0]!.status.code).toBe(2);
  });

  it('formats prompt and tool images into media only after explicit opt-in', async () => {
    const gif = {
      type: 'image',
      mimeType: 'image/gif',
      data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    };
    vi.mocked(loadConfigFromFile).mockReturnValue({
      includePayloads: true,
      mediaUploadEnabled: true,
    });
    await fireEvent('session_start', {});
    recordExports();
    await fireEvent('input', {
      text: 'inspect',
      images: [{ type: 'image', mimeType: 'image/png', data: '!'.repeat(600_004) }, gif],
    });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('tool_execution_start', { toolCallId: 'image', toolName: 'read', args: {} });
    await fireEvent('tool_execution_end', {
      toolCallId: 'image',
      toolName: 'read',
      isError: false,
      result: { content: [gif], details: {} },
    });
    await fireEvent('input', {
      text: 'another image',
      streamingBehavior: 'followUp',
      images: [gif],
    });
    await fireEvent('agent_end', { messages: [assistantMessage('done')] });
    await fireEvent('agent_settled', {});
    const input = exported.find((span) => span.name === 'chat-input')!;
    const tool = exported.find((span) => span.name === 'read')!;
    expect(String(input.attributes['langfuse.observation.input'])).toContain(
      `data:image/gif;base64,${gif.data}`,
    );
    expect(String(tool.attributes['langfuse.observation.output'])).toContain(
      `data:image/gif;base64,${gif.data}`,
    );
    const queued = exported.find((span) => span.name.startsWith('chat-followup'))!;
    expect(String(queued.attributes['langfuse.observation.input'])).toContain(
      `data:image/gif;base64,${gif.data}`,
    );
    expect(String(tool.attributes.details)).toContain('[image binary omitted]');
  });

  it('nests tool-internal LLM usage beneath the tool span without inventing a model', async () => {
    await fireEvent('session_start', {});
    recordExports();
    await fireEvent('input', { text: 'search' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('tool_execution_start', { toolCallId: 'search', toolName: 'web', args: {} });
    await fireEvent('tool_result', {
      toolCallId: 'search',
      usage: { input: 10, output: 5, cost: { total: 0.1 } },
    });
    await fireEvent('tool_execution_end', {
      toolCallId: 'search',
      toolName: 'web',
      isError: false,
      result: { content: [] },
    });
    const usage = exported.find((span) => span.name === 'Tool LLM Usage')!;
    const tool = exported.find((span) => span.name === 'web')!;
    expect(usage.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(usage.attributes['langfuse.observation.model.name']).toBe('unknown');
    expect(JSON.parse(String(usage.attributes['langfuse.observation.cost_details']))).toEqual({
      total: 0.1,
    });
  });

  it('cancel mid-turn (agent_end still fires) completes the root with the query intact', async () => {
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    recordExports();
    await fireEvent('input', { type: 'input', text: 'cancel this run' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: 1700000000000 });

    // The query is exported immediately, before the turn finishes.
    const chatInput = exported.find((span) => span.name === 'chat-input');
    expect(chatInput?.attributes['langfuse.trace.input']).toBe('cancel this run');
    expect(exported.some((span) => span.name === 'chat-turn')).toBe(false);

    // pi's agent loop emits agent_end even when aborted, so an Esc cancel
    // completes the root span normally rather than orphaning it.
    await fireEvent('agent_end', {
      type: 'agent_end',
      messages: [assistantMessage('partial answer')],
    });
    await fireEvent('agent_settled', {});

    const root = exported.find((span) => span.name === 'chat-turn');
    expect(root?.attributes['langfuse.observation.input']).toBe(JSON.stringify('cancel this run'));
    expect(root?.attributes['langfuse.observation.output']).toBe(JSON.stringify('partial answer'));
    expect(root?.attributes['langfuse.observation.level']).toBe('DEFAULT');
    expect(root?.attributes['langfuse.observation.metadata.terminatedBy']).toBeUndefined();
  });

  it('interrupt (session exit mid-turn, no agent_end) still exports the query and sweeps the root', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    recordExports();
    await fireEvent('input', { type: 'input', text: 'kill this run' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: 1700000000000 });
    await fireEvent('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'sleep 999' },
    });

    const beforeShutdown = exported.length;
    expect(exported.some((span) => span.name === 'chat-input')).toBe(true);
    expect(exported.some((span) => span.name === 'chat-turn')).toBe(false);

    await fireEvent('session_shutdown', { type: 'session_shutdown' });

    const swept = exported.slice(beforeShutdown);
    const root = swept.find((span) => span.name === 'chat-turn');
    const tool = swept.find((span) => span.name.startsWith('bash'));
    for (const span of [root, tool]) {
      expect(span?.attributes['langfuse.observation.level']).toBe('WARNING');
      expect(span?.attributes['langfuse.observation.metadata.terminatedBy']).toBe(
        'session_shutdown',
      );
    }
    expect(root?.attributes['langfuse.observation.input']).toBe(JSON.stringify('kill this run'));
    expect(new Set(exported.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(
      errorSpy.mock.calls.filter((args) => String(args[0]).includes('open span(s)')),
    ).toHaveLength(1);
    errorSpy.mockRestore();
  });
});
