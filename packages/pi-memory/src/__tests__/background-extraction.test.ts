import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countMemoryActions,
  createExtractionRunner,
  extractTextFromMessage,
  mainAgentWroteMemory,
  serializeMessages,
  type TurnEndEvent,
} from '../background-extraction.js';
import { MemoryStore } from '../store.js';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-agent-core')>()),
  Agent: class {
    state = { messages: [] };
    prompt = prompt;
    subscribe() {}
  },
}));

const TEST_ROOT = path.join(tmpdir(), 'pi-memory-extraction-test');

function freshDir(): string {
  const dir = path.join(TEST_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStore(dir: string) {
  return new MemoryStore({ dir });
}

function makeTurnEndEvent(
  turnIndex: number,
  role: string,
  text: string,
  toolResults: Array<{ toolName: string; isError: boolean }> = [],
): TurnEndEvent {
  return {
    turnIndex,
    message: { role, content: text, timestamp: Date.now() },
    toolResults: toolResults.map((tr) => ({ ...tr, content: undefined })),
  };
}

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  prompt.mockClear();
});
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// mainAgentWroteMemory
// ---------------------------------------------------------------------------

describe('mainAgentWroteMemory', () => {
  it('returns true when memory_add succeeded', () => {
    const results = [{ toolName: 'memory_add', isError: false }];
    expect(mainAgentWroteMemory(results)).toBe(true);
  });

  it('returns true when memory_replace succeeded', () => {
    const results = [{ toolName: 'memory_replace', isError: false }];
    expect(mainAgentWroteMemory(results)).toBe(true);
  });

  it('returns false when memory_add errored', () => {
    const results = [{ toolName: 'memory_add', isError: true }];
    expect(mainAgentWroteMemory(results)).toBe(false);
  });

  it('returns false for memory_read (not a write)', () => {
    const results = [{ toolName: 'memory_read', isError: false }];
    expect(mainAgentWroteMemory(results)).toBe(false);
  });

  it('returns false for memory_remove (not in MEMORY_WRITE_TOOLS)', () => {
    const results = [{ toolName: 'memory_remove', isError: false }];
    expect(mainAgentWroteMemory(results)).toBe(false);
  });

  it('returns false for empty results', () => {
    expect(mainAgentWroteMemory([])).toBe(false);
  });

  it('returns true if any write tool succeeded in a batch', () => {
    const results = [
      { toolName: 'bash', isError: false },
      { toolName: 'memory_add', isError: false },
    ];
    expect(mainAgentWroteMemory(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractTextFromMessage
// ---------------------------------------------------------------------------

describe('extractTextFromMessage', () => {
  it('handles string content', () => {
    expect(extractTextFromMessage({ role: 'user', content: 'hello' })).toBe('hello');
  });

  it('handles content block array', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'part 1' },
        { type: 'image', data: 'base64...' },
        { type: 'text', text: 'part 2' },
      ],
    };
    expect(extractTextFromMessage(msg)).toBe('part 1\npart 2');
  });

  it('returns empty string for undefined content', () => {
    expect(extractTextFromMessage({ role: 'user' })).toBe('');
  });

  it('returns empty string for non-string non-array content', () => {
    expect(extractTextFromMessage({ role: 'user', content: 42 })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// serializeMessages
// ---------------------------------------------------------------------------

describe('serializeMessages', () => {
  it('formats messages with role prefix', () => {
    const msgs = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ];
    const result = serializeMessages(msgs);
    expect(result).toBe('[user] hello\n\n[assistant] hi there');
  });

  it('truncates from the front when exceeding MAX_CONTEXT_CHARS', () => {
    const longText = 'x'.repeat(3000);
    const msgs = [
      { role: 'user', text: longText },
      { role: 'user', text: 'recent message' },
    ];
    const result = serializeMessages(msgs);
    // Should keep the most recent message and as much of the older one as fits
    expect(result).toContain('recent message');
  });

  it('bounds even a single oversized message including its role and separators', () => {
    const result = serializeMessages([{ role: 'assistant', text: 'x'.repeat(100_000) }]);
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result).toContain('[assistant]');
  });

  it('returns empty string for empty input', () => {
    expect(serializeMessages([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// countMemoryActions
// ---------------------------------------------------------------------------

describe('countMemoryActions', () => {
  it('counts successful add/replace/remove tool results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'analyze' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will add' }] },
      {
        role: 'toolResult',
        toolName: 'memory_read',
        isError: false,
        content: [{ type: 'text', text: '{"success": true}' }],
      },
      {
        role: 'toolResult',
        toolName: 'memory_add',
        isError: false,
        content: [{ type: 'text', text: '{\n  "success": true\n}' }],
      },
      {
        role: 'toolResult',
        toolName: 'memory_replace',
        isError: false,
        content: [{ type: 'text', text: '{"success": true}' }],
      },
    ];
    // memory_read doesn't count, memory_add + memory_replace = 2
    expect(countMemoryActions(messages)).toBe(2);
  });

  it('ignores failed tool results', () => {
    const messages = [
      {
        role: 'toolResult',
        toolName: 'memory_add',
        isError: true,
        content: [{ type: 'text', text: '{"success": false}' }],
      },
    ];
    expect(countMemoryActions(messages)).toBe(0);
  });

  it('ignores tool results without success:true in content', () => {
    const messages = [
      {
        role: 'toolResult',
        toolName: 'memory_add',
        isError: false,
        content: [{ type: 'text', text: '{"success": false, "error": "limit reached"}' }],
      },
    ];
    expect(countMemoryActions(messages)).toBe(0);
  });

  it('returns 0 for empty messages', () => {
    expect(countMemoryActions([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createExtractionRunner — gating logic
// ---------------------------------------------------------------------------

describe('createExtractionRunner gating', () => {
  it('drains old batches and reviews later prompts when turn indices restart', async () => {
    const store = makeStore(freshDir());
    await store.loadFromDisk();
    const runner = createExtractionRunner({
      store,
      interval: 1,
      modelConfig: { provider: 'test', model: 'test' },
      modelRegistry: {
        find: () => ({ id: 'test' }),
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
    });
    runner.onTurnEnd(makeTurnEndEvent(0, 'assistant', 'first batch'));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    runner.onTurnEnd(makeTurnEndEvent(0, 'assistant', 'second batch'));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]![0]).toContain('second batch');
    expect(prompt.mock.calls[1]![0]).not.toContain('first batch');
    runner.shutdown();
  });

  it('does not trigger before interval is reached', async () => {
    const store = makeStore(freshDir());
    await store.loadFromDisk();

    const onNotify = vi.fn();
    const runner = createExtractionRunner({
      store,
      modelConfig: { provider: 'test', model: 'test' },
      interval: 3,
      modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
      onNotify,
    });

    // Fire 2 turns — should not trigger (interval is 3)
    runner.onTurnEnd(makeTurnEndEvent(0, 'user', 'hello'));
    runner.onTurnEnd(makeTurnEndEvent(1, 'assistant', 'hi'));

    await new Promise((r) => setTimeout(r, 50));
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('skips when main agent wrote memory this turn', async () => {
    const store = makeStore(freshDir());
    await store.loadFromDisk();

    const findFn = vi.fn().mockReturnValue(null);
    const runner = createExtractionRunner({
      store,
      modelConfig: { provider: 'test', model: 'test' },
      interval: 1,
      modelRegistry: { find: findFn, getApiKeyAndHeaders: async () => ({ ok: false }) },
    });

    // Turn with a successful memory_add — should skip and not even call find()
    runner.onTurnEnd(
      makeTurnEndEvent(0, 'assistant', 'done', [{ toolName: 'memory_add', isError: false }]),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(findFn).not.toHaveBeenCalled();
  });

  it('skips when model is not found and warns once', async () => {
    const store = makeStore(freshDir());
    await store.loadFromDisk();

    const onNotify = vi.fn();
    const runner = createExtractionRunner({
      store,
      modelConfig: { provider: 'fake', model: 'fake-model' },
      interval: 1,
      modelRegistry: {
        find: () => null,
        getApiKeyAndHeaders: async () => ({ ok: false }),
      },
      onNotify,
    });

    runner.onTurnEnd(makeTurnEndEvent(0, 'user', 'hello'));
    await new Promise((r) => setTimeout(r, 50));

    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('not found'), 'warning');

    // Second trigger — should not warn again
    onNotify.mockClear();
    runner.onTurnEnd(makeTurnEndEvent(1, 'user', 'world'));
    await new Promise((r) => setTimeout(r, 50));
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('skips when auth fails', async () => {
    const store = makeStore(freshDir());
    await store.loadFromDisk();

    const onNotify = vi.fn();
    const runner = createExtractionRunner({
      store,
      modelConfig: { provider: 'p', model: 'm' },
      interval: 1,
      modelRegistry: {
        find: () => ({ id: 'mock' }),
        getApiKeyAndHeaders: async () => ({ ok: false, error: 'no key' }),
      },
      onNotify,
    });

    runner.onTurnEnd(makeTurnEndEvent(0, 'user', 'hello'));
    await new Promise((r) => setTimeout(r, 50));

    // No notification on auth failure — silent skip
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('respects shutdown flag', async () => {
    const store = makeStore(freshDir());
    await store.loadFromDisk();

    const findFn = vi.fn().mockReturnValue(null);
    const runner = createExtractionRunner({
      store,
      modelConfig: { provider: 'test', model: 'test' },
      interval: 1,
      modelRegistry: { find: findFn, getApiKeyAndHeaders: async () => ({ ok: false }) },
    });

    runner.shutdown();
    runner.onTurnEnd(makeTurnEndEvent(0, 'user', 'hello'));

    await new Promise((r) => setTimeout(r, 50));
    expect(findFn).not.toHaveBeenCalled();
  });
});
