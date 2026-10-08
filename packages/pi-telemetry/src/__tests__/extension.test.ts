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

  it('keeps retry generations in the prompt trace until the agent settles', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent(
      'session_start',
      {},
      { sessionManager: { getSessionId: () => 'persisted-session' } },
    );
    await fireEvent('input', { text: 'retry this' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('agent_end', { messages: [{ role: 'assistant', content: 'first' }] });
    expect(
      getPublishedEvents().filter((e) => 'type' in e && e.type === 'chat_turn_completed'),
    ).toHaveLength(0);
    await fireEvent('before_provider_request', { payload: {} });
    await fireEvent('agent_end', { messages: [{ role: 'assistant', content: 'final' }] });
    await fireEvent('agent_settled', {});
    const completed = getPublishedEvents().filter(
      (e) => 'type' in e && e.type === 'chat_turn_completed',
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      sessionId: 'persisted-session',
      details: { output: 'final' },
    });
  });

  it('marks aborted generations and roots as failed while keeping the response', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', {});
    await fireEvent('input', { text: 'cancel' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('before_provider_request', { payload: {} });
    const message = {
      role: 'assistant',
      content: 'partial',
      stopReason: 'aborted',
      errorMessage: 'Cancelled',
    };
    await fireEvent('message_end', { message });
    await fireEvent('agent_end', { messages: [message] });
    await fireEvent('agent_settled', {});
    expect(getPublishedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          llmGenerationId: 'gen-1',
          status: 'failed',
          stopReason: 'aborted',
          error: 'Cancelled',
        }),
        expect.objectContaining({
          type: 'chat_turn_failed',
          error: 'Cancelled',
          details: { output: 'partial', outcome: 'aborted' },
        }),
      ]),
    );
  });

  it('measures first content latency rather than the stream start and records actual model attribution', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', {});
      await fireEvent('turn_start', { timestamp: Date.now() });
      await fireEvent(
        'before_provider_request',
        { payload: { temperature: 0.3, max_tokens: 4096 } },
        { model: { provider: 'openai', id: 'requested' }, thinkingLevel: 'high' },
      );
      await fireEvent('message_update', { assistantMessageEvent: { type: 'start' } });
      vi.advanceTimersByTime(250);
      await fireEvent('message_update', {
        assistantMessageEvent: { type: 'thinking_delta', delta: 'reason' },
      });
      vi.advanceTimersByTime(100);
      await fireEvent('message_end', {
        message: {
          role: 'assistant',
          content: 'answer',
          responseModel: 'served',
          api: 'openai-responses',
        },
      });
      expect(getPublishedEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'started',
            modelParameters: { temperature: 0.3, max_tokens: 4096, thinkingLevel: 'high' },
          }),
          expect.objectContaining({
            status: 'completed',
            completionStartTime: '2026-10-08T00:00:00.250Z',
            requestedModel: 'requested',
            model: { provider: 'openai', model: 'served', thinkingLevel: 'high' },
            api: 'openai-responses',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('records compaction and branch summary usage even outside an active prompt', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', {}, { sessionManager: { getSessionId: () => 's' } });
    const ctx = { model: { provider: 'openai', id: 'summary' } };
    const usage = { input: 100, output: 20, reasoning: 5, cost: { total: 0.1 } };
    await fireEvent('session_before_compact', {});
    await fireEvent(
      'session_compact',
      { compactionEntry: { summary: 'compact', usage }, reason: 'manual' },
      ctx,
    );
    await fireEvent('session_tree', { summaryEntry: { summary: 'branch', usage } }, ctx);
    const generations = getPublishedEvents().filter((e) => 'llmGenerationId' in e);
    expect(generations).toHaveLength(4);
    expect(generations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          source: 'compaction',
          usage: { input: 100, output: 20, reasoning: 5, cost: { total: 0.1 } },
        }),
        expect.objectContaining({ status: 'completed', source: 'branch_summary' }),
      ]),
    );
    expect(generations[0]!.traceId).toBe(generations[1]!.traceId);
    expect(generations[2]!.traceId).not.toBe(generations[0]!.traceId);
  });

  it('keeps raw requests intact while exposing readable history, thinking and tool calls', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', {});
    await fireEvent('input', { text: 'hello' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('agent_start', {}, { getSystemPrompt: () => 'final instructions' });
    await fireEvent('context', { messages: [{ role: 'user', content: 'hello' }] });
    const payload = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 };
    await fireEvent('before_provider_request', { payload });
    await fireEvent('message_end', {
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'check' },
          { type: 'text', text: 'answer' },
          { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a' } },
        ],
      },
    });
    const generations = getPublishedEvents().filter((e) => 'llmGenerationId' in e) as any[];
    expect(generations[0].input).toEqual(payload);
    expect(payload).toEqual({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 });
    expect(generations[0].displayInput).toEqual([
      { role: 'system', content: 'final instructions' },
      { role: 'user', content: 'hello' },
    ]);
    expect(generations[1].displayOutput).toMatchObject({
      role: 'assistant',
      content: 'answer',
      thinking: [{ type: 'thinking', content: 'check' }],
      tool_calls: [
        { id: 'call', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
      ],
    });
  });

  it('offers safe status and flush commands without claiming backend delivery', async () => {
    mockPi.registerCommand.mockClear();
    const exporter = {
      publish: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      getStatus: () => ({ enabled: true, state: 'error', error: 'Telemetry export failed' }),
    };
    vi.mocked(createTelemetryExporter).mockReturnValueOnce(exporter);
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', {});
    const command = mockPi.registerCommand.mock.calls.find(([name]) => name === 'telemetry')?.[1];
    expect(command).toBeDefined();
    const notify = vi.fn();
    await command.handler('status', { hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('error'), 'info');
    await command.handler('flush', { hasUI: true, ui: { notify } });
    expect(exporter.flush).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith('Telemetry export failed', 'error');
    expect(JSON.stringify(notify.mock.calls)).not.toContain('trace sent');
  });

  it('restores prompt numbering and separates newly selected sessions', async () => {
    telemetryExtension(mockPi as any);
    const manager = {
      getSessionId: () => 'restored',
      getEntries: () => [
        { type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant' } },
        { type: 'message', message: { role: 'user' } },
      ],
    };
    await fireEvent('session_start', {}, { sessionManager: manager });
    await fireEvent('input', { text: 'third' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    expect(getPublishedEvents()[0]).toMatchObject({ sessionId: 'restored', promptNumber: 3 });
    await fireEvent('agent_end', { messages: [] });
    await fireEvent('agent_settled', {});
    await fireEvent(
      'session_start',
      {},
      { sessionManager: { getSessionId: () => 'new', getEntries: () => [] } },
    );
    await fireEvent('input', { text: 'first' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    const nextExporter = vi.mocked(createTelemetryExporter).mock.results[1]!.value;
    expect(nextExporter.publish.mock.calls.at(-1)[0]).toMatchObject({
      sessionId: 'new',
      promptNumber: 1,
    });
  });

  it('keeps steering and queued follow-ups in the running trace until settlement', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', {});
    await fireEvent('input', { text: 'original' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent('before_provider_request', { payload: {} });
    const traceId = getPublishedEvents()[0]!.traceId;
    await fireEvent('input', { text: 'follow-up', streamingBehavior: 'followUp' });
    await fireEvent('message_end', { message: { role: 'assistant', content: 'first' } });
    await fireEvent('before_provider_request', { payload: {} });
    await fireEvent('message_end', { message: { role: 'assistant', content: 'final' } });
    await fireEvent('agent_end', { messages: [{ role: 'assistant', content: 'final' }] });
    await fireEvent('agent_settled', {});
    const events = getPublishedEvents();
    expect(events.every((event) => event.traceId === traceId)).toBe(true);
    expect(
      events.filter((event) => 'type' in event && event.type === 'chat_turn_completed'),
    ).toHaveLength(1);
    expect(events.some((event) => 'error' in event && event.error)).toBe(false);
    expect(events.at(-1)).toMatchObject({ promptNumber: 1 });
  });

  it.each([
    [
      { thinkingBudget: 512, includeThoughts: true },
      { thinkingBudget: 512, includeThoughts: true },
    ],
    [{ thinkingLevel: 'HIGH' }, { thinkingLevel: 'HIGH' }],
  ])('records Google Vertex generation config without collecting request content: %j', async (thinkingConfig, expectedThinking) => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', {});
    await fireEvent('input', { text: 'private question' });
    await fireEvent('turn_start', { timestamp: Date.now() });
    await fireEvent(
      'before_provider_request',
      {
        payload: {
          model: 'gemini',
          contents: [{ role: 'user', parts: [{ text: 'private question' }] }],
          config: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig },
        },
      },
      { model: { id: 'gemini', provider: 'google-vertex' } },
    );
    const generation = getPublishedEvents().find((event) => 'llmGenerationId' in event) as any;
    expect(generation.modelParameters).toEqual({
      temperature: 0.7,
      maxOutputTokens: 2048,
      ...expectedThinking,
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
      const starts = getPublishedEvents().filter(
        (event) => 'type' in event && event.type === 'chat_turn_started',
      );
      expect(starts[1]!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(starts[1]!.traceId).not.toBe('ci-known-trace');
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

  it('publishes chat_turn_completed after settlement with durationMs', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const startTs = Date.now();
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: startTs });
    await fireEvent('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    });
    await fireEvent('agent_settled', {});

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
    await fireEvent('agent_settled', {});

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

  it('publishes the original tool failure for exporter-level payload handling', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: {
        content: [{ type: 'text', text: 'ENOENT: /missing/file' }],
        details: { exitCode: 1 },
      },
      isError: true,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      status: 'failed',
      error: 'ENOENT: /missing/file',
    });
    expect(toolEvent).not.toHaveProperty('details');
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
    const llmEvents = events.filter(
      (e) => 'llmGenerationId' in e && 'status' in e && e.status === 'started',
    );
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
      await fireEvent('agent_settled', {});

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
