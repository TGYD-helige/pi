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
});
