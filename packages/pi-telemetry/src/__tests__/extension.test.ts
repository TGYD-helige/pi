import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeTelemetryEvent } from '../index.js';

vi.mock('../config.js', () => ({
  loadConfigFromFile: vi.fn(() => ({})),
  resolveConfig: vi.fn((config: unknown) => config ?? {}),
}));

vi.mock('../otel.js', () => ({
  createTelemetryExporter: vi.fn(() => ({
    publish: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

import { loadConfigFromFile } from '../config.js';
import { NoopRuntimeEventExporter } from '../index.js';
import { createTelemetryExporter } from '../otel.js';

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

function getPublishedEvents(): RuntimeTelemetryEvent[] {
  const telemetryExporter = (createTelemetryExporter as ReturnType<typeof vi.fn>).mock.results[0]
    ?.value;
  if (!telemetryExporter) return [];
  return (telemetryExporter.publish as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => call[0] as RuntimeTelemetryEvent,
  );
}

describe('telemetryExtension', () => {
  beforeEach(() => {
    handlers.clear();
    mockPi.on.mockClear();
    mockPi.registerTool.mockClear();
    (loadConfigFromFile as ReturnType<typeof vi.fn>).mockClear();
    (createTelemetryExporter as ReturnType<typeof vi.fn>).mockClear();

    (createTelemetryExporter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    });
  });

  it('registers expected event handlers', () => {
    telemetryExtension(mockPi as any);

    const registered = mockPi.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registered).toContain('session_start');
    expect(registered).toContain('session_shutdown');
    expect(registered).toContain('turn_start');
    expect(registered).toContain('agent_end');
    expect(registered).toContain('tool_execution_start');
    expect(registered).toContain('tool_execution_end');
    expect(registered).toContain('before_provider_request');
    expect(registered).toContain('after_provider_response');
    expect(registered).toContain('message_update');
    expect(registered).toContain('message_end');
    expect(registered).toContain('model_select');
    expect(registered).toContain('session_compact');
  });

  it('initializes exporter from config on session_start', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      { cwd: '/project', isProjectTrusted: () => false },
    );

    expect(loadConfigFromFile).toHaveBeenCalledWith({
      cwd: '/project',
      projectTrusted: false,
    });
    expect(createTelemetryExporter).toHaveBeenCalledTimes(1);
  });

  it('does not retain an exporter after telemetry is disabled in a later session', async () => {
    const previousExporter = {
      publish: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    (createTelemetryExporter as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(previousExporter)
      .mockReturnValueOnce(new NoopRuntimeEventExporter());

    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('session_start', { type: 'session_start', reason: 'new' });
    await fireEvent('turn_start', {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: 1700000000000,
    });

    expect(previousExporter.publish).not.toHaveBeenCalled();
  });

  it('publishes chat_turn_started on turn_start', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: 1700000000000 });

    const events = getPublishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat_turn_started',
      createdAt: '2023-11-14T22:13:20.000Z',
    });
    expect(events[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]!.sessionId).toBeTruthy();
  });

  it('uses a preset root trace id once when provided by the caller', async () => {
    process.env.PI_TELEMETRY_TRACE_ID = 'ci-known-trace';
    try {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('input', { type: 'input', text: 'first' });
      await fireEvent('turn_start', {
        type: 'turn_start',
        turnIndex: 0,
        timestamp: 1700000000000,
      });
      expect(getPublishedEvents()[0]!.traceId).toBe('ci-known-trace');

      await fireEvent('input', { type: 'input', text: 'second' });
      await fireEvent('turn_start', {
        type: 'turn_start',
        turnIndex: 1,
        timestamp: 1700000001000,
      });
      expect(getPublishedEvents()[1]!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(getPublishedEvents()[1]!.traceId).not.toBe('ci-known-trace');
    } finally {
      delete process.env.PI_TELEMETRY_TRACE_ID;
      delete process.env.PI_TELEMETRY_SESSION_ID;
      delete process.env.PI_TELEMETRY_OWNER_PID;
    }
  });

  it('correlates runtime events with the telemetry task run', async () => {
    process.env.PI_TELEMETRY_TASK_RUN_ID = '003cc514-4f61-4f9c-b497-6ec99967d6d1';
    try {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', {
        type: 'turn_start',
        turnIndex: 0,
        timestamp: 1700000000000,
      });
      await fireEvent('tool_execution_start', {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read_file',
        args: { path: 'README.md' },
      });
      await fireEvent(
        'before_provider_request',
        { type: 'before_provider_request', payload: { messages: [] } },
        { model: { id: 'kimi-k2.5', provider: 'anthropic-compatible' } },
      );

      expect(getPublishedEvents()).toHaveLength(3);
      expect(getPublishedEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskRunId: '003cc514-4f61-4f9c-b497-6ec99967d6d1',
          }),
        ]),
      );
      expect(
        getPublishedEvents().every(
          (event) => event.taskRunId === '003cc514-4f61-4f9c-b497-6ec99967d6d1',
        ),
      ).toBe(true);
    } finally {
      delete process.env.PI_TELEMETRY_TASK_RUN_ID;
    }
  });

  it('publishes chat_turn_completed on agent_end with durationMs', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const startTs = Date.now();
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: startTs });
    await fireEvent('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(2);
    const completed = events[1]!;
    expect(completed).toMatchObject({ type: 'chat_turn_completed' });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.traceId).toBe(events[0]!.traceId);
  });

  it('uses new traceId for each user query', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('input', { type: 'input', text: 'first' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('input', { type: 'input', text: 'second' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const events = getPublishedEvents();
    const started = events.filter((e) => 'type' in e && e.type === 'chat_turn_started');
    expect(started).toHaveLength(2);
    expect(started[0]!.traceId).not.toBe(started[1]!.traceId);
  });

  it('reuses same traceId across turns within one query', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('input', { type: 'input', text: 'hello' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 1, message: {}, toolResults: [] });
    await fireEvent('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    });

    const events = getPublishedEvents();
    const traceIds = new Set(events.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);
    expect(
      events.filter((event) => 'type' in event && event.type === 'chat_turn_completed'),
    ).toHaveLength(1);
  });

  it('publishes tool started event', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { path: 'README.md' },
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'started',
      args: { path: 'README.md' },
    });
  });

  it('publishes tool completed event', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'file contents',
      isError: false,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
      details: { output: 'file contents' },
    });
  });

  it('publishes completed tool output from text content blocks', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'web_search',
      result: {
        content: [
          { type: 'text', text: 'first result' },
          { type: 'text', text: 'second result' },
        ],
      },
      isError: false,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'web_search',
      status: 'completed',
      details: { output: 'first result\nsecond result' },
    });
  });

  it('preserves tool output beyond the old 500-character preview', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    const output = 'x'.repeat(20_000);

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: { content: [{ type: 'text', text: output }] },
      isError: false,
    });

    const toolEvent = getPublishedEvents().find((event) => 'toolCallId' in event);
    expect(toolEvent).toMatchObject({ details: { output } });
  });

  it('preserves sanitized tool details and does not overwrite explicit output', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      result: {
        output: 'raw stdout',
        details: {
          exitCode: 0,
          output: 'normalized stdout',
          fullOutput: 'large stdout that should not be exported',
          fullOutputMimeType: 'text/plain',
        },
      },
      isError: false,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e) as any;
    expect(toolEvent.details).toEqual({
      exitCode: 0,
      output: 'normalized stdout',
    });
  });

  it('allows tool results to suppress output payloads', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_secret',
      result: {
        output: 'secret',
        details: { outputSuppressed: true, reason: 'sensitive' },
      },
      isError: false,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e) as any;
    expect(toolEvent.details).toEqual({
      outputSuppressed: true,
      reason: 'sensitive',
    });
  });

  it('publishes a sanitized tool failure without raw result details', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'Authorization: Bearer super-secret-token\ninternal stack trace',
      isError: true,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      status: 'failed',
      error: 'Tool execution failed',
    });
    expect(toolEvent).not.toHaveProperty('details');
    expect(JSON.stringify(toolEvent)).not.toContain('super-secret-token');
  });

  it('publishes LLM generation started from before_provider_request', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent(
      'before_provider_request',
      { type: 'before_provider_request', payload: { messages: [] } },
      { model: { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' } },
    );

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e);
    expect(llmEvent).toMatchObject({
      llmGenerationId: 'gen-1',
      status: 'started',
      model: { provider: 'anthropic', model: 'claude-3-opus-20240229' },
    });
  });

  it('after_provider_response with 2xx does not publish completed (message_end does)', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { model: 'claude-3-opus-20240229' },
    });
    await fireEvent('after_provider_response', {
      type: 'after_provider_response',
      status: 200,
      headers: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents).toHaveLength(1);
    expect(llmEvents[0]).toMatchObject({ status: 'started' });
  });

  it('publishes stream frames only when message_update events were received', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('before_provider_request', { type: 'before_provider_request', payload: {} });
    await fireEvent('message_update', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'hello',
        partial: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    });
    await fireEvent('message_end', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: {} },
    });

    const events = getPublishedEvents();
    const streamEvent = events.find((event) => 'streamEvents' in event);
    expect(streamEvent).toMatchObject({
      llmGenerationId: 'gen-1',
      streamEvents: [{ type: 'text_delta', contentIndex: 0, delta: 'hello' }],
    });
    expect(events.at(-1)).toMatchObject({ llmGenerationId: 'gen-1', status: 'completed' });

    await fireEvent('before_provider_request', { type: 'before_provider_request', payload: {} });
    await fireEvent('message_end', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: {} },
    });
    expect(getPublishedEvents().filter((event) => 'streamEvents' in event)).toHaveLength(1);
  });

  it('publishes LLM generation failed for 4xx/5xx responses', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('after_provider_response', {
      type: 'after_provider_response',
      status: 429,
      headers: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[1]).toMatchObject({
      status: 'failed',
      error: 'HTTP 429',
    });
  });

  it('extracts model from ctx.model when present', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent(
      'before_provider_request',
      { type: 'before_provider_request', payload: {} },
      { model: { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } },
    );

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e);
    expect(llmEvent).toMatchObject({
      model: { provider: 'openai', model: 'gpt-4o' },
    });
  });

  it('falls back to unknown model when ctx.model is undefined', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { messages: [] },
    });

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e);
    expect(llmEvent).toMatchObject({
      model: { provider: 'unknown', model: 'unknown' },
    });
  });

  it('increments llmGenerationId for multiple requests in same turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('message_end', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input: 10, output: 5 },
      },
    });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[0]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(llmEvents[2]).toMatchObject({ llmGenerationId: 'gen-2' });
  });

  it('continues llmGenerationId counter across turns within one query', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('input', { type: 'input', text: 'hello' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[0]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(llmEvents[1]).toMatchObject({ llmGenerationId: 'gen-2' });
  });

  it('resets llmGenerationId counter on new user query', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('input', { type: 'input', text: 'first' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('input', { type: 'input', text: 'second' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[0]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(llmEvents[1]).toMatchObject({ llmGenerationId: 'gen-1' });
  });

  it('closes exporter on session_shutdown', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const telemetryExporter = (createTelemetryExporter as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;

    await fireEvent('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

    // close() owns the final delivery (it flushes internally), so the
    // extension must not double-flush.
    expect(telemetryExporter.close).toHaveBeenCalledTimes(1);
    expect(telemetryExporter.flush).not.toHaveBeenCalled();
  });

  it('ignores tool events outside of a turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: {},
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(0);
  });

  it('ignores LLM events outside of a turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(0);
  });

  it('uses same sessionId across queries', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('input', { type: 'input', text: 'first' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('input', { type: 'input', text: 'second' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const events = getPublishedEvents();
    const started = events.filter((e) => 'type' in e && e.type === 'chat_turn_started');
    expect(started).toHaveLength(2);
    expect(started[0]!.sessionId).toBe(started[1]!.sessionId);
  });

  it('before_provider_request publishes input payload', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    const payload = {
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 4096,
    };
    await fireEvent(
      'before_provider_request',
      { type: 'before_provider_request', payload },
      { model: { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' } },
    );

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e) as any;
    expect(llmEvent.input).toEqual(payload);
  });

  it('message_end publishes completed with output, usage, responseId, stopReason', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent(
      'before_provider_request',
      { type: 'before_provider_request', payload: {} },
      { model: { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' } },
    );
    await fireEvent('message_end', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello! How can I help?' }],
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 170 },
        responseId: 'resp_abc123',
        stopReason: 'stop',
      },
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e) as any[];
    expect(llmEvents).toHaveLength(2);
    const completed = llmEvents[1];
    expect(completed).toMatchObject({
      llmGenerationId: 'gen-1',
      status: 'completed',
      output: {
        content: 'Hello! How can I help?',
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 170 },
      },
      responseId: 'resp_abc123',
      stopReason: 'stop',
    });
    expect(completed.usage).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 170,
    });
    expect(completed.model).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-opus-20240229',
    });
  });

  it('message_end keeps content array when it includes tool_use blocks', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent(
      'before_provider_request',
      { type: 'before_provider_request', payload: {} },
      { model: { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' } },
    );
    const content = [
      { type: 'text', text: 'Let me check that file.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } },
    ];
    await fireEvent('message_end', {
      type: 'message_end',
      message: { role: 'assistant', content, usage: { input: 50, output: 30 } },
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e) as any[];
    const completed = llmEvents[1];
    expect(completed.output).toEqual({ content: content, usage: { input: 50, output: 30 } });
  });

  it('message_end ignores non-assistant messages', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('message_end', {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents).toHaveLength(1);
    expect(llmEvents[0]).toMatchObject({ status: 'started' });
  });

  it('model_select publishes chat_turn_steered event', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('model_select', {
      type: 'model_select',
      model: { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' },
      previousModel: {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        provider: 'anthropic',
      },
      source: 'auto',
    });

    const events = getPublishedEvents();
    const steered = events.find((e) => 'type' in e && e.type === 'chat_turn_steered') as any;
    expect(steered).toBeDefined();
    expect(steered.details).toMatchObject({
      eventType: 'model_switch',
      from: { provider: 'anthropic', model: 'claude-3-sonnet-20240229' },
      to: { provider: 'anthropic', model: 'claude-3-opus-20240229' },
      source: 'auto',
    });
  });

  it('session_compact publishes chat_turn_steered event', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('session_compact', {
      type: 'session_compact',
      compactionEntry: {},
      fromExtension: true,
    });

    const events = getPublishedEvents();
    const steered = events.find((e) => 'type' in e && e.type === 'chat_turn_steered') as any;
    expect(steered).toBeDefined();
    expect(steered.details).toMatchObject({
      eventType: 'session_compact',
      fromExtension: true,
    });
  });

  it('model_select ignored outside of a turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('model_select', {
      type: 'model_select',
      model: { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' },
      previousModel: undefined,
      source: 'user',
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(0);
  });

  describe('subagent mode (inherited env vars)', () => {
    const PARENT_TRACE_ID = 'abc123def456';
    const PARENT_SESSION_ID = 'parent-session-id';

    beforeEach(() => {
      process.env.PI_TELEMETRY_TRACE_ID = PARENT_TRACE_ID;
      process.env.PI_TELEMETRY_SESSION_ID = PARENT_SESSION_ID;
      process.env.PI_TELEMETRY_OWNER_PID = '99999';
      process.env.PI_SUBAGENT_CHILD_AGENT = 'legal';
    });

    afterEach(() => {
      delete process.env.PI_TELEMETRY_TRACE_ID;
      delete process.env.PI_TELEMETRY_SESSION_ID;
      delete process.env.PI_TELEMETRY_OWNER_PID;
      delete process.env.PI_SUBAGENT_CHILD_AGENT;
    });

    it('uses inherited traceId from parent', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]!.traceId).toBe(PARENT_TRACE_ID);
    });

    it('publishes subagent_started instead of chat_turn_started', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]).toMatchObject({ type: 'subagent_started' });
      expect((events[0] as any).parentSessionId).toBe(PARENT_SESSION_ID);
      expect((events[0] as any).childSessionId).toBeTruthy();
      expect((events[0] as any).details).toMatchObject({ agent: 'legal' });
    });

    it('publishes subagent_completed instead of chat_turn_completed', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
      await fireEvent('agent_end', {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
      });

      const events = getPublishedEvents();
      const completed = events.find((e) => 'type' in e && e.type === 'subagent_completed');
      expect(completed).toBeDefined();
      expect((completed as any).parentSessionId).toBe(PARENT_SESSION_ID);
      expect((completed as any).childSessionId).toBeTruthy();
      expect((completed as any).details).toMatchObject({ agent: 'legal' });
    });

    it('uses parent sessionId for lifecycle events', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]!.sessionId).toBe(PARENT_SESSION_ID);
    });

    it('includes childSessionId on tool events', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      await fireEvent('tool_execution_start', {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read_file',
        args: { path: 'foo.ts' },
      });

      const events = getPublishedEvents();
      const toolEvent = events.find((e) => 'toolCallId' in e) as any;
      expect(toolEvent.parentSessionId).toBe(PARENT_SESSION_ID);
      expect(toolEvent.childSessionId).toBeTruthy();
      expect(toolEvent.traceId).toBe(PARENT_TRACE_ID);
    });

    it('includes childSessionId on LLM generation events', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      await fireEvent('before_provider_request', {
        type: 'before_provider_request',
        payload: { messages: [] },
      });

      const events = getPublishedEvents();
      const llmEvent = events.find((e) => 'llmGenerationId' in e) as any;
      expect(llmEvent.parentSessionId).toBe(PARENT_SESSION_ID);
      expect(llmEvent.childSessionId).toBeTruthy();
      expect(llmEvent.traceId).toBe(PARENT_TRACE_ID);
    });

    it('does not treat same-pid env vars as subagent', async () => {
      process.env.PI_TELEMETRY_OWNER_PID = String(process.pid);
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]).toMatchObject({ type: 'chat_turn_started' });
      expect(events[0]!.traceId).not.toBe(PARENT_TRACE_ID);
    });
  });
});
