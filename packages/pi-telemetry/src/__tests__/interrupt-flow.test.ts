import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfigFromFile: vi.fn(() => ({})),
  resolveConfig: vi.fn((config: unknown) => config ?? {}),
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
    createTelemetryExporter: vi.fn(() => {
      const inMemory = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(inMemory)],
      });
      holder.inMemory = inMemory;
      return new OtelRuntimeEventExporter(
        { enabled: true, endpoint: '', flushAt: 10, flushIntervalMs: 60_000 },
        { provider },
      );
    }),
  };
});

type EventHandler = (...args: any[]) => Promise<void> | void;

const handlers = new Map<string, EventHandler>();

const mockPi = {
  registerTool: vi.fn(),
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
