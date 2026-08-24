import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

const mocks = vi.hoisted(() => ({
  platformAdd: vi.fn().mockResolvedValue({ results: [] }),
  platformSearch: vi.fn().mockResolvedValue({ results: [] }),
  platformGetAll: vi.fn().mockResolvedValue({ results: [] }),
  embeddedAdd: vi.fn().mockResolvedValue({ results: [] }),
  embeddedSearch: vi.fn().mockResolvedValue({ results: [] }),
  embeddedGetAll: vi.fn().mockResolvedValue({ results: [] }),
}));

vi.mock('mem0ai', () => ({
  MemoryClient: class {
    _fetchWithErrorHandling = vi.fn();
    add = mocks.platformAdd;
    search = mocks.platformSearch;
    getAll = mocks.platformGetAll;
  },
}));

vi.mock('mem0ai/oss', () => ({
  Memory: class {
    add = mocks.embeddedAdd;
    search = mocks.embeddedSearch;
    getAll = mocks.embeddedGetAll;
  },
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('Mem0 provider entity scope', () => {
  it('uses top-level agentId for Platform writes and OR filters for reads', async () => {
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });

    await provider.add([{ role: 'user', content: 'dark mode' }], {
      userId: 'company-1',
      agentId: 'agent-1',
    });
    await provider.search('preferences', { userId: 'company-1', agentId: 'agent-1', topK: 7 });
    await provider.getAll({ userId: 'company-1', agentId: 'agent-1' });

    expect(mocks.platformAdd).toHaveBeenCalledWith([{ role: 'user', content: 'dark mode' }], {
      userId: 'company-1',
      agentId: 'agent-1',
    });
    const filters = { OR: [{ user_id: 'company-1' }, { agent_id: 'agent-1' }] };
    expect(mocks.platformSearch).toHaveBeenCalledWith('preferences', { filters, topK: 7 });
    expect(mocks.platformGetAll).toHaveBeenCalledWith({ filters });
  });

  it('paginates Platform user and agent memories as separate dedup groups', async () => {
    mocks.platformGetAll.mockImplementation(async (options: Record<string, unknown>) => {
      const filters = options.filters as Record<string, string>;
      if (filters.user_id && options.page === 1) {
        return {
          count: 2,
          results: [{ id: 'user-1', memory: 'same text' }],
          next: 'page-2',
        };
      }
      if (filters.user_id) {
        return {
          count: 2,
          results: [{ id: 'user-2', memory: 'same text' }],
          next: null,
        };
      }
      return {
        count: 1,
        results: [{ id: 'agent-1', memory: 'same text' }],
        next: null,
      };
    });
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });

    const groups = await provider.getDedupGroups!({
      userId: 'company-1',
      agentId: 'agent-1',
    });

    expect(groups).toEqual([
      [
        { id: 'user-1', memory: 'same text' },
        { id: 'user-2', memory: 'same text' },
      ],
      [{ id: 'agent-1', memory: 'same text' }],
    ]);
    expect(mocks.platformGetAll).toHaveBeenCalledWith({
      filters: { user_id: 'company-1' },
      page: 1,
      pageSize: 200,
    });
    expect(mocks.platformGetAll).toHaveBeenCalledWith({
      filters: { user_id: 'company-1' },
      page: 2,
      pageSize: 200,
    });
    expect(mocks.platformGetAll).toHaveBeenCalledWith({
      filters: { agent_id: 'agent-1' },
      page: 1,
      pageSize: 200,
    });
  });

  it('fails closed when Platform pagination returns no progress', async () => {
    mocks.platformGetAll.mockResolvedValue({ count: 1, results: [], next: 'same-page' });
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });

    await expect(provider.getDedupGroups!({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 dedup pagination returned an empty page with a next link.',
    );
    expect(mocks.platformGetAll).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Platform count exceeds the returned memories', async () => {
    mocks.platformGetAll.mockResolvedValue({
      count: 2,
      results: [{ id: 'only-result', memory: 'incomplete page' }],
      next: null,
    });
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });

    await expect(provider.getDedupGroups!({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 dedup pagination count does not match the returned memories.',
    );
  });

  it('fails closed when Platform pagination omits a valid count', async () => {
    mocks.platformGetAll.mockResolvedValue({ results: [], next: null });
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });

    await expect(provider.getDedupGroups!({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 dedup pagination returned an invalid count.',
    );
  });

  it('bounds Platform dedup pagination requests', async () => {
    mocks.platformGetAll.mockResolvedValue({
      count: 10_000,
      results: [{ id: 'one', memory: 'one result per page' }],
      next: 'more',
    });
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });

    await expect(provider.getDedupGroups!({ userId: 'company-1' })).rejects.toThrow(
      'Mem0 dedup pagination exceeds 50 pages.',
    );
    expect(mocks.platformGetAll).toHaveBeenCalledTimes(50);
  });

  it('uses top-level agentId for Embedded writes and exact filters for reads', async () => {
    const provider = await createMem0Provider({
      config: { mode: 'embedded', oss: { disableHistory: true } },
    });
    mocks.embeddedGetAll.mockClear();

    await provider.add([{ role: 'user', content: 'dark mode' }], {
      userId: 'company-1',
      agentId: 'agent-1',
    });
    await provider.search('preferences', { userId: 'company-1', agentId: 'agent-1', topK: 7 });
    await provider.getAll({ userId: 'company-1', agentId: 'agent-1' });

    expect(mocks.embeddedAdd).toHaveBeenCalledWith([{ role: 'user', content: 'dark mode' }], {
      userId: 'company-1',
      agentId: 'agent-1',
    });
    const filters = { user_id: 'company-1', agent_id: 'agent-1' };
    expect(mocks.embeddedSearch).toHaveBeenCalledWith('preferences', { filters, topK: 7 });
    expect(mocks.embeddedGetAll).toHaveBeenCalledWith({ filters });
  });

  it('keeps Embedded user and agent memories in one exact dedup group', async () => {
    mocks.embeddedGetAll.mockResolvedValue({
      results: [
        { id: 'old', memory: 'same text' },
        { id: 'new', memory: 'same text' },
      ],
    });
    const provider = await createMem0Provider({
      config: { mode: 'embedded', oss: { disableHistory: true } },
    });
    mocks.embeddedGetAll.mockClear();

    const groups = await provider.getDedupGroups!({
      userId: 'company-1',
      agentId: 'agent-1',
    });

    expect(groups).toEqual([
      [
        { id: 'old', memory: 'same text' },
        { id: 'new', memory: 'same text' },
      ],
    ]);
    expect(mocks.embeddedGetAll).toHaveBeenCalledWith({
      filters: { user_id: 'company-1', agent_id: 'agent-1' },
      topK: 10_001,
    });
  });
});
