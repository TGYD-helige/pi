import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CapturedTurn, CaptureQueue } from '../capture.js';
import { createMem0Provider } from '../provider.js';

const state = vi.hoisted(() => ({ timestamps: [] as string[], prompts: [] as string[] }));
vi.mock('mem0ai', () => ({
  MemoryClient: class {
    _fetchWithErrorHandling() {
      return Promise.resolve({});
    }
    async add(_messages: unknown, options: { timestamp: string }) {
      state.timestamps.push(options.timestamp);
      return { results: [] };
    }
  },
}));
vi.mock('mem0ai/oss', () => ({
  Memory: class {
    async getAll() {
      return [];
    }
    llm = {
      generateResponse: async (messages: Array<{ role?: string; content: string }>) => {
        state.prompts.push(messages[0]!.content);
        return '{}';
      },
    };
    async add() {
      await this.llm.generateResponse([
        { role: 'user', content: '## Observation Date\n2026-10-31\n## Current Date\n2026-10-31' },
      ]);
      return { results: [] };
    }
  },
}));
const turn: CapturedTurn = {
  observedAt: '2026-10-01T10:00:00.000Z',
  messages: [
    { role: 'user', content: 'Yesterday I moved.' },
    { role: 'assistant', content: 'Noted.' },
  ],
};

describe('CaptureQueue observation dates', () => {
  beforeEach(() => {
    state.timestamps.length = 0;
    state.prompts.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([
    'platform',
    'embedded',
  ] as const)('keeps the original observation date when replaying through %s', async (mode) => {
    const provider = await createMem0Provider({
      config: { mode, apiKey: 'test-only', oss: { disableHistory: true } },
    });
    const save = vi.fn();
    const queue = new CaptureQueue(provider, { userId: 'test-user' }, {}, save, [turn]);
    queue.start();
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith([]));
    if (mode === 'platform') expect(state.timestamps).toEqual(['2026-10-01T10:00:00.000Z']);
    else
      expect(state.prompts).toEqual([
        '## Observation Date\n2026-10-01\n## Current Date\n2026-10-01',
      ]);
    queue.close();
  });

  it('keeps self-hosted live capture available while retaining unsupported historical replay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetch);
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.test' },
    });
    const save = vi.fn();
    const notify = vi.fn();
    const queue = new CaptureQueue(provider, { userId: 'test-user' }, {}, save, [turn], notify);
    queue.start();
    const live = {
      ...turn,
      observedAt: new Date().toISOString(),
      messages: [
        { role: 'user', content: 'I prefer tea now.' },
        { role: 'assistant', content: 'Noted.' },
      ],
    };
    expect(queue.enqueue(live)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      messages: live.messages,
      user_id: 'test-user',
    });
    expect(save).toHaveBeenLastCalledWith([turn]);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/historical/i));
    queue.close();
  });

  it('archives a full unsupported historical backlog without taking live queue capacity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetch);
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.test' },
    });
    const archive = vi.fn();
    const save = vi.fn();
    const history = Array.from({ length: 16 }, () => turn);
    const queue = new CaptureQueue(
      provider,
      { userId: 'test-user' },
      {},
      save,
      history,
      vi.fn(),
      120_000,
      archive,
    );
    queue.start();
    expect(archive).toHaveBeenCalledWith(history);
    expect(queue.enqueue({ ...turn, observedAt: new Date().toISOString() })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith([]);
    queue.close();
  });

  it('rejects unsupported self-hosted dates before sending and retains the outbox', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.test' },
    });
    await expect(
      provider.add(turn.messages, { userId: 'test-user', observedAt: turn.observedAt }),
    ).rejects.toThrow(/unsupported/i);
    const notify = vi.fn();
    const save = vi.fn();
    const queue = new CaptureQueue(provider, { userId: 'test-user' }, {}, save, [turn], notify);
    queue.start();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/unsupported/i)),
    );
    expect(save).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    queue.close();
  });
});
