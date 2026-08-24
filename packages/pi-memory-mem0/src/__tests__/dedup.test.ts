import { describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../types.js';

// Mock provider creation so both modes exercise the same public abstraction.
vi.mock('../provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.js')>();
  return {
    ...actual,
    createMem0Provider: vi.fn(),
  };
});

import { dedupMemories } from '../dedup.js';
import { createMem0Provider } from '../provider.js';

const mockCreateProvider = vi.mocked(createMem0Provider);

function makeItem(id: string, memory: string, updated_at?: string): MemoryItem {
  return { id, memory, updated_at };
}

function mockProviderWith(items: MemoryItem[]) {
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  mockCreateProvider.mockResolvedValue({
    add: vi.fn(),
    search: vi.fn(),
    getAll: vi.fn().mockResolvedValue(items),
    getDedupGroups: vi.fn().mockResolvedValue([items]),
    delete: deleteMock,
  });
  return { deleteMock };
}

describe('dedupMemories', () => {
  it('refuses providers that cannot separate entity scopes safely', async () => {
    mockCreateProvider.mockResolvedValue({
      add: vi.fn(),
      search: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    });

    await expect(
      dedupMemories({
        userId: 'company-1',
        agentId: 'agent-1',
        config: { mode: 'platform', apiKey: 'test' },
        dryRun: true,
      }),
    ).rejects.toThrow('does not support safe deduplication');
  });

  it('previews duplicates in the current agent scope without deleting', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const getDedupGroups = vi
      .fn()
      .mockResolvedValue([
        [
          makeItem('old', 'User prefers tabs', '2026-06-01T10:00:00Z'),
          makeItem('new', 'user prefers tabs', '2026-06-10T10:00:00Z'),
        ],
      ]);
    mockCreateProvider.mockResolvedValue({
      add: vi.fn(),
      search: vi.fn(),
      getAll: vi.fn(),
      delete: deleteMock,
      getDedupGroups,
    });

    const result = await dedupMemories({
      userId: 'company-1',
      agentId: 'agent-1',
      config: { mode: 'platform', apiKey: 'test' },
      dryRun: true,
    });

    expect(getDedupGroups).toHaveBeenCalledWith({
      userId: 'company-1',
      agentId: 'agent-1',
    });
    expect(result).toEqual({
      total: 2,
      duplicatesFound: 1,
      duplicatesRemoved: 0,
      deleteFailures: 0,
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('returns zero duplicates for empty store', async () => {
    mockProviderWith([]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({
      total: 0,
      duplicatesFound: 0,
      duplicatesRemoved: 0,
      deleteFailures: 0,
    });
  });

  it('returns zero duplicates when all entries are unique', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('1', 'User prefers tabs'),
      makeItem('2', 'Project uses TypeScript'),
      makeItem('3', 'Timezone is UTC+8'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({
      total: 3,
      duplicatesFound: 0,
      duplicatesRemoved: 0,
      deleteFailures: 0,
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('deletes exact duplicates (case-insensitive), keeps newest', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('1', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('2', 'user prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('3', 'Project uses TypeScript'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({
      total: 3,
      duplicatesFound: 1,
      duplicatesRemoved: 1,
      deleteFailures: 0,
    });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith('1');
  });

  it('normalizes Unicode and collapsed whitespace before comparison', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('old', 'Café\tprefers   tabs', '2026-01-01T00:00:00Z'),
      makeItem('new', 'CAFE\u0301 prefers tabs', '2026-02-01T00:00:00Z'),
    ]);

    await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(deleteMock).toHaveBeenCalledWith('old');
  });

  it('does not deduplicate identical text across independent entity groups', async () => {
    const deleteMock = vi.fn();
    mockCreateProvider.mockResolvedValue({
      add: vi.fn(),
      search: vi.fn(),
      getAll: vi.fn(),
      getDedupGroups: vi
        .fn()
        .mockResolvedValue([
          [makeItem('user-memory', 'same text', '2026-01-01T00:00:00Z')],
          [makeItem('agent-memory', 'same text', '2026-02-01T00:00:00Z')],
        ]),
      delete: deleteMock,
    });

    const result = await dedupMemories({
      userId: 'company-1',
      agentId: 'agent-1',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result.duplicatesFound).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('keeps the most recently updated entry among multiple duplicates', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('old', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('new', 'User prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('oldest', 'user prefers tabs', '2025-01-01T00:00:00Z'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({
      total: 3,
      duplicatesFound: 2,
      duplicatesRemoved: 2,
      deleteFailures: 0,
    });
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledWith('old');
    expect(deleteMock).toHaveBeenCalledWith('oldest');
  });

  it('falls back to creation time when duplicate memories were never updated', async () => {
    const { deleteMock } = mockProviderWith([
      { id: 'old', memory: 'same text', created_at: '2026-01-01T00:00:00Z' },
      { id: 'new', memory: 'same text', created_at: '2026-02-01T00:00:00Z' },
    ]);

    await dedupMemories({
      userId: 'test-user',
      config: { mode: 'embedded' },
    });

    expect(deleteMock).toHaveBeenCalledWith('old');
    expect(deleteMock).not.toHaveBeenCalledWith('new');
  });

  it('fails closed when duplicate memories have the same effective timestamp', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('first', 'same text', '2026-01-01T00:00:00Z'),
      makeItem('second', 'same text', '2026-01-01T00:00:00Z'),
    ]);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'embedded' },
      }),
    ).rejects.toThrow('Mem0 dedup cannot determine the newest duplicate.');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('fails closed when older duplicate memories have tied timestamps', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('newest', 'same text', '2026-06-01T00:00:00Z'),
      makeItem('older-a', 'same text', '2026-01-01T00:00:00Z'),
      makeItem('older-b', 'same text', '2026-01-01T00:00:00Z'),
    ]);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'embedded' },
      }),
    ).rejects.toThrow('Mem0 dedup cannot determine the newest duplicate.');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('fails closed when duplicate recency cannot be determined', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('first', 'same text'),
      makeItem('second', 'same text'),
    ]);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'embedded' },
      }),
    ).rejects.toThrow('Mem0 dedup cannot determine the newest duplicate.');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', [{ id: '', memory: 'unique', created_at: '2026-01-01T00:00:00Z' }]],
    [
      'internal whitespace',
      [{ id: 'bad id', memory: 'unique', created_at: '2026-01-01T00:00:00Z' }],
    ],
    [
      'duplicate',
      [
        { id: 'same-id', memory: 'same text', created_at: '2026-01-01T00:00:00Z' },
        { id: 'same-id', memory: 'same text', created_at: '2026-01-01T00:00:00Z' },
      ],
    ],
  ])('fails closed for %s memory ids', async (_kind, items) => {
    const { deleteMock } = mockProviderWith(items);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'embedded' },
      }),
    ).rejects.toThrow('Mem0 dedup received an invalid or duplicate memory ID.');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t\n '],
  ])('fails closed for %s memory content', async (_kind, memory) => {
    const { deleteMock } = mockProviderWith([
      makeItem('first', memory, '2026-01-01T00:00:00Z'),
      makeItem('second', memory, '2026-06-01T00:00:00Z'),
    ]);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'embedded' },
      }),
    ).rejects.toThrow('Mem0 dedup received empty memory content.');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('continues on individual delete failures and counts only successes', async () => {
    const deleteMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined);
    mockCreateProvider.mockResolvedValue({
      add: vi.fn(),
      search: vi.fn(),
      getAll: vi
        .fn()
        .mockResolvedValue([
          makeItem('1', 'hello', '2026-01-01T00:00:00Z'),
          makeItem('2', 'hello', '2026-06-01T00:00:00Z'),
          makeItem('3', 'hello', '2026-06-10T00:00:00Z'),
        ]),
      getDedupGroups: vi
        .fn()
        .mockResolvedValue([
          [
            makeItem('1', 'hello', '2026-01-01T00:00:00Z'),
            makeItem('2', 'hello', '2026-06-01T00:00:00Z'),
            makeItem('3', 'hello', '2026-06-10T00:00:00Z'),
          ],
        ]),
      delete: deleteMock,
    });

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({
      total: 3,
      duplicatesFound: 2,
      duplicatesRemoved: 1,
      deleteFailures: 1,
    });
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    const { deleteMock } = mockProviderWith([
      makeItem('1', 'a', '2026-06-01T10:00:00Z'),
      makeItem('2', 'a', '2026-06-10T10:00:00Z'),
    ]);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'platform', apiKey: 'test' },
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation between duplicate deletions', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during deletion');
    const items = [
      makeItem('1', 'same', '2026-01-01T00:00:00Z'),
      makeItem('2', 'same', '2026-02-01T00:00:00Z'),
      makeItem('3', 'same', '2026-03-01T00:00:00Z'),
    ];
    const deleteMock = vi.fn().mockImplementation(async () => {
      controller.abort(reason);
    });
    mockCreateProvider.mockResolvedValue({
      add: vi.fn(),
      search: vi.fn(),
      getAll: vi.fn(),
      getDedupGroups: vi.fn().mockResolvedValue([items]),
      delete: deleteMock,
    });

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'platform', apiKey: 'test' },
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation while waiting for approval', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during approval');
    const { deleteMock } = mockProviderWith([
      makeItem('old', 'same', '2026-01-01T00:00:00Z'),
      makeItem('new', 'same', '2026-02-01T00:00:00Z'),
    ]);

    await expect(
      dedupMemories({
        userId: 'test-user',
        config: { mode: 'platform', apiKey: 'test' },
        signal: controller.signal,
        approve: async () => {
          controller.abort(reason);
          return false;
        },
      }),
    ).rejects.toBe(reason);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('uses stable vector-store IDs in OSS mode', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('1', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('2', 'user prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('3', 'Project uses TypeScript'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'embedded' },
    });

    expect(result).toEqual({
      total: 3,
      duplicatesFound: 1,
      duplicatesRemoved: 1,
      deleteFailures: 0,
    });
    expect(deleteMock).toHaveBeenCalledWith('1');
    expect(mockCreateProvider).toHaveBeenCalledWith({ config: { mode: 'embedded' } });
  });
});
