import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import type { RuntimeTelemetryEvent } from '../index.js';

vi.mock('../config.js', () => ({
  loadConfigFromFile: vi.fn(() => ({})),
  resolveConfig: vi.fn((config: unknown) => config ?? {}),
}));

vi.mock('../langfuse.js', () => ({
  createLangfuseExporter: vi.fn(() => ({
    publish: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../otel.js', () => ({
  createOtelExporter: vi.fn(() => ({
    publish: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

import { loadConfigFromFile } from '../config.js';
import { NoopRuntimeEventExporter } from '../index.js';
import { createLangfuseExporter } from '../langfuse.js';
import { createOtelExporter } from '../otel.js';

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
  const langfuseExporter = (createLangfuseExporter as ReturnType<typeof vi.fn>).mock.results[0]
    ?.value;
  if (!langfuseExporter) return [];
  return (langfuseExporter.publish as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => call[0] as RuntimeTelemetryEvent,
  );
}

describe('telemetryExtension', () => {
  beforeEach(() => {
    handlers.clear();
    mockPi.on.mockClear();
    mockPi.registerTool.mockClear();
    (loadConfigFromFile as ReturnType<typeof vi.fn>).mockClear();
    (createLangfuseExporter as ReturnType<typeof vi.fn>).mockClear();
    (createOtelExporter as ReturnType<typeof vi.fn>).mockClear();

    (createLangfuseExporter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    });
    (createOtelExporter as ReturnType<typeof vi.fn>).mockReturnValue(
      new NoopRuntimeEventExporter(),
    );
  });

  test('registers expected event handlers', () => {
    telemetryExtension(mockPi as any);

    const registered = mockPi.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registered).toContain('session_start');
    expect(registered).toContain('session_shutdown');
    expect(registered).toContain('turn_start');
    expect(registered).toContain('turn_end');
    expect(registered).toContain('tool_execution_start');
    expect(registered).toContain('tool_execution_end');
    expect(registered).toContain('before_provider_request');
    expect(registered).toContain('after_provider_response');
    expect(registered).toContain('message_end');
    expect(registered).toContain('model_select');
    expect(registered).toContain('session_compact');
  });

  test('initializes exporter from config on session_start', async () => {
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
    expect(createLangfuseExporter).toHaveBeenCalledTimes(1);
    expect(createOtelExporter).toHaveBeenCalledTimes(1);
  });

  test('does not retain an exporter after telemetry is disabled in a later session', async () => {
    const previousExporter = {
      publish: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    (createLangfuseExporter as ReturnType<typeof vi.fn>)
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

  test('publishes chat_turn_started on turn_start', async () => {
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

  test('publishes chat_turn_completed on turn_end with durationMs', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const startTs = Date.now();
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: startTs });
    await fireEvent('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: {},
      toolResults: [],
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(2);
    const completed = events[1]!;
    expect(completed).toMatchObject({ type: 'chat_turn_completed' });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.traceId).toBe(events[0]!.traceId);
  });

  test('uses new traceId for each user query', async () => {
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

  test('reuses same traceId across turns within one query', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('input', { type: 'input', text: 'hello' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 1, message: {}, toolResults: [] });

    const events = getPublishedEvents();
    const traceIds = new Set(events.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);
  });

  test('publishes tool started event', async () => {
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

  test('publishes tool completed event', async () => {
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

  test('publishes completed tool output from text content blocks', async () => {
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

  test('preserves sanitized tool details and does not overwrite explicit output', async () => {
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

  test('allows tool results to suppress output payloads', async () => {
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

  test('publishes tool failed event with error', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'ENOENT: file not found',
      isError: true,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      status: 'failed',
      error: 'ENOENT: file not found',
    });
  });

  test('publishes LLM generation started from before_provider_request', async () => {
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

  test('after_provider_response with 2xx does not publish completed (message_end does)', async () => {
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

  test('publishes LLM generation failed for 4xx/5xx responses', async () => {
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

  test('extracts model from ctx.model when present', async () => {
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

  test('falls back to unknown model when ctx.model is undefined', async () => {
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

  test('increments llmGenerationId for multiple requests in same turn', async () => {
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

  test('continues llmGenerationId counter across turns within one query', async () => {
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

  test('resets llmGenerationId counter on new user query', async () => {
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

  test('flushes and closes exporter on session_shutdown', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const langfuseExporter = (createLangfuseExporter as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;

    await fireEvent('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

    expect(langfuseExporter.flush).toHaveBeenCalledTimes(1);
    expect(langfuseExporter.close).toHaveBeenCalledTimes(1);
  });

  test('ignores tool events outside of a turn', async () => {
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

  test('ignores LLM events outside of a turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(0);
  });

  test('uses same sessionId across queries', async () => {
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

  test('before_provider_request publishes input payload', async () => {
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

  test('message_end publishes completed with output, usage, responseId, stopReason', async () => {
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

  it('closes a generation at turn_end when message_end did not durably arrive', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent(
      'before_provider_request',
      { type: 'before_provider_request', payload: { messages: ['hello'] } },
      { model: { id: 'deepseek-v4-flash', provider: 'amaster' } },
    );

    await fireEvent('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'durable result' }],
        usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170 },
        responseId: 'resp-fallback',
        stopReason: 'stop',
      },
      toolResults: [],
    });

    const events = getPublishedEvents();
    const generationEvents = events.filter((event) => 'llmGenerationId' in event);
    expect(generationEvents).toHaveLength(2);
    expect(generationEvents[1]).toMatchObject({
      llmGenerationId: 'gen-1',
      status: 'completed',
      output: {
        content: 'durable result',
        usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170 },
      },
      responseId: 'resp-fallback',
      stopReason: 'stop',
    });
    expect(events.at(-1)).toMatchObject({ type: 'chat_turn_completed' });
  });

  it('does not duplicate at turn_end a generation already closed by message_end', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { messages: ['hello'] },
    });
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'one terminal' }],
      usage: { input: 10, output: 2 },
    };
    await fireEvent('message_end', { type: 'message_end', message });
    await fireEvent('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message,
      toolResults: [],
    });

    const terminalEvents = getPublishedEvents().filter(
      (event) => 'llmGenerationId' in event && event.status === 'completed',
    );
    expect(terminalEvents).toHaveLength(1);
  });

  it('releases a failed message_end reservation so turn_end can retry the terminal', async () => {
    const exporter = {
      publish: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('terminal publish failed'))
        .mockResolvedValue(undefined),
      flush: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    (createLangfuseExporter as ReturnType<typeof vi.fn>).mockReturnValue(exporter);
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { messages: ['hello'] },
    });
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'retry terminal' }],
      usage: { input: 10, output: 2 },
    };

    await expect(fireEvent('message_end', { type: 'message_end', message })).rejects.toThrow(
      'terminal publish failed',
    );
    await fireEvent('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message,
      toolResults: [],
    });

    const terminalAttempts = exporter.publish.mock.calls
      .map(([event]) => event as RuntimeTelemetryEvent)
      .filter((event) => 'llmGenerationId' in event && event.status === 'completed');
    expect(terminalAttempts).toHaveLength(2);
    expect(terminalAttempts[0]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(terminalAttempts[1]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(exporter.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'chat_turn_completed',
    });
  });

  test('message_end keeps content array when it includes tool_use blocks', async () => {
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

  test('message_end ignores non-assistant messages', async () => {
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

  test('model_select publishes chat_turn_steered event', async () => {
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

  test('session_compact publishes chat_turn_steered event', async () => {
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

  test('model_select ignored outside of a turn', async () => {
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

    test('uses inherited traceId from parent', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]!.traceId).toBe(PARENT_TRACE_ID);
    });

    test('publishes subagent_started instead of chat_turn_started', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]).toMatchObject({ type: 'subagent_started' });
      expect((events[0] as any).parentSessionId).toBe(PARENT_SESSION_ID);
      expect((events[0] as any).childSessionId).toBeTruthy();
      expect((events[0] as any).details).toMatchObject({ agent: 'legal' });
    });

    test('publishes subagent_completed instead of chat_turn_completed', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
      await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });

      const events = getPublishedEvents();
      const completed = events.find((e) => 'type' in e && e.type === 'subagent_completed');
      expect(completed).toBeDefined();
      expect((completed as any).parentSessionId).toBe(PARENT_SESSION_ID);
      expect((completed as any).childSessionId).toBeTruthy();
      expect((completed as any).details).toMatchObject({ agent: 'legal' });
    });

    test('uses parent sessionId for lifecycle events', async () => {
      telemetryExtension(mockPi as any);
      await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
      await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

      const events = getPublishedEvents();
      expect(events[0]!.sessionId).toBe(PARENT_SESSION_ID);
    });

    test('includes childSessionId on tool events', async () => {
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

    test('includes childSessionId on LLM generation events', async () => {
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

    test('does not treat same-pid env vars as subagent', async () => {
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
