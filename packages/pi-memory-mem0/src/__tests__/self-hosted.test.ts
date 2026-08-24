import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

describe('self-hosted Mem0 provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps self-hosted user and agent memories in one exact dedup group', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { id: 'old', memory: 'same text' },
            { id: 'new', memory: 'same text' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });

    const groups = await provider.getDedupGroups!({
      userId: 'company/1',
      agentId: 'agent/1',
    });

    expect(groups).toEqual([
      [
        { id: 'old', memory: 'same text' },
        { id: 'new', memory: 'same text' },
      ],
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://mem0.example.com/memories?user_id=company%2F1&agent_id=agent%2F1&top_k=1000',
    );
  });

  it('fails closed when a self-hosted dedup scope reaches the server limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: Array.from({ length: 1000 }, (_, index) => ({
              id: String(index),
              memory: `memory ${index}`,
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });

    await expect(provider.getDedupGroups!({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 self-hosted dedup scope may exceed 999 memories.',
    );
  });

  it('uses exact user and agent filters for search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ id: '1', memory: 'likes cats', score: 0.9 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await createMem0Provider({
      config: {
        mode: 'self-hosted',
        baseUrl: 'https://mem0.example.com/',
        apiKey: 'secret-key',
      },
    });

    await expect(
      provider.search('pets', { userId: 'company-1', agentId: 'agent-1', topK: 7 }),
    ).resolves.toEqual([{ id: '1', memory: 'likes cats', score: 0.9 }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mem0.example.com/search',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'secret-key',
        },
        body: JSON.stringify({
          query: 'pets',
          filters: { user_id: 'company-1', agent_id: 'agent-1' },
          top_k: 7,
        }),
      }),
    );
  });

  it('passes caller cancellation to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });
    const controller = new AbortController();

    await provider.getAll({ userId: 'company-1', signal: controller.signal });

    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('creates, lists, and deletes memories through OSS endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ id: '1', memory: 'dark mode', event: 'ADD' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: '1', memory: 'dark mode' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Memory deleted successfully' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });

    await provider.add([{ role: 'user', content: 'dark mode' }], {
      userId: 'company/1',
      agentId: 'agent/1',
      infer: false,
    });
    await expect(provider.getAll({ userId: 'company/1', agentId: 'agent/1' })).resolves.toEqual([
      { id: '1', memory: 'dark mode' },
    ]);
    await provider.delete('memory/1');

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      messages: [{ role: 'user', content: 'dark mode' }],
      user_id: 'company/1',
      agent_id: 'agent/1',
      infer: false,
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://mem0.example.com/memories?user_id=company%2F1&agent_id=agent%2F1',
    );
    expect(fetchMock.mock.calls[2]![0]).toBe('https://mem0.example.com/memories/memory%2F1');
  });

  it('does not expose an upstream response body in errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret upstream detail', { status: 500 })),
    );
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });

    await expect(provider.getAll({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 request failed (500)',
    );
    await expect(provider.getAll({ userId: 'company-1' })).rejects.not.toThrow(
      'secret upstream detail',
    );
  });

  it('sanitizes transport and invalid JSON errors', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED secret.internal:8000'))
      .mockResolvedValueOnce(
        new Response('secret-upstream-body', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });

    await expect(provider.getAll({ userId: 'company-1' })).rejects.toThrow('Mem0 request failed.');
    await expect(provider.getAll({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 returned an invalid response.',
    );
  });

  it('preserves caller cancellation without exposing transport details', async () => {
    const controller = new AbortController();
    const callerReason = new Error('caller cancelled');
    controller.abort(callerReason);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('transport included secret.internal:8000')),
    );
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });

    await expect(provider.getAll({ userId: 'company-1', signal: controller.signal })).rejects.toBe(
      callerReason,
    );
  });

  it('preserves caller cancellation while reading the response body', async () => {
    let bodyStarted!: () => void;
    const bodyStartedPromise = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              bodyStarted();
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        } as Response),
      ),
    );
    const provider = await createMem0Provider({
      config: { mode: 'self-hosted', baseUrl: 'https://mem0.example.com' },
    });
    const controller = new AbortController();
    const callerReason = new Error('caller cancelled');
    const pending = provider.getAll({ userId: 'company-1', signal: controller.signal });

    await bodyStartedPromise;
    controller.abort(callerReason);

    await expect(pending).rejects.toBe(callerReason);
  });

  it('uses requestTimeoutMs for remote requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const provider = await createMem0Provider({
      config: {
        mode: 'self-hosted',
        baseUrl: 'https://mem0.example.com',
        requestTimeoutMs: 5,
      },
    });

    await expect(provider.getAll({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 request timed out.',
    );
  });

  it('rejects non-positive requestTimeoutMs', async () => {
    await expect(
      createMem0Provider({
        config: {
          mode: 'self-hosted',
          baseUrl: 'https://mem0.example.com',
          requestTimeoutMs: 0,
        },
      }),
    ).rejects.toThrow('Self-hosted requestTimeoutMs must be a positive number.');
  });
});
