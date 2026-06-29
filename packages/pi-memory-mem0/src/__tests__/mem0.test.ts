import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prefetch } from '../prefetch.js';
import type { KeyResolver, Mem0Provider, ProviderResolver } from '../provider.js';
import { mapApiToMem0Provider, SqliteSnapshotStore } from '../provider.js';
import { createMem0Tools } from '../tools.js';

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function mockProvider(overrides: Partial<Mem0Provider> = {}): Mem0Provider {
  return {
    add: vi.fn().mockResolvedValue({ results: [] }),
    search: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    flushSnapshot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

describe('Prefetch', () => {
  it('queue + consume returns formatted memories', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([
        { id: '1', memory: 'likes TypeScript' },
        { id: '2', memory: 'uses vim' },
      ]),
    });
    const pf = new Prefetch(provider, 'u', undefined, { topK: 5 });

    pf.queue('preferences');
    const result = await pf.consume();

    expect(result).toContain('## Recalled Memories (Mem0)');
    expect(result).toContain('- likes TypeScript');
    expect(result).toContain('- uses vim');
    expect(provider.search).toHaveBeenCalledWith('preferences', { userId: 'u', topK: 5 });
  });

  it('returns empty string when nothing queued', async () => {
    const provider = mockProvider();
    const pf = new Prefetch(provider, 'u', undefined, { topK: 5 });

    const result = await pf.consume();
    expect(result).toBe('');
  });

  it('returns empty on timeout', async () => {
    const provider = mockProvider({
      search: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    const pf = new Prefetch(provider, 'u', undefined, { topK: 5 });

    pf.queue('test');
    const result = await pf.consume(50);

    expect(result).toBe('');
  });

  it('returns empty when search returns no results', async () => {
    const provider = mockProvider({ search: vi.fn().mockResolvedValue([]) });
    const pf = new Prefetch(provider, 'u', undefined, { topK: 5 });

    pf.queue('nothing');
    const result = await pf.consume();

    expect(result).toBe('');
  });

  it('filters out empty memory strings', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([
        { id: '1', memory: 'valid' },
        { id: '2', memory: '' },
        { id: '3', memory: '  ' },
      ]),
    });
    const pf = new Prefetch(provider, 'u', undefined, { topK: 5 });

    pf.queue('q');
    const result = await pf.consume();

    expect(result).toContain('- valid');
    expect(result).not.toContain('- \n');
    expect(result.match(/^-/gm)?.length).toBe(1);
  });

  it('clears pending after consume', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([{ id: '1', memory: 'fact' }]),
    });
    const pf = new Prefetch(provider, 'u', undefined, { topK: 5 });

    pf.queue('q');
    await pf.consume();
    const second = await pf.consume();

    expect(second).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('createMem0Tools', () => {
  it('exposes 3 tools', () => {
    const tools = createMem0Tools(mockProvider(), 'u');
    expect(tools.map((t) => t.name)).toEqual(['mem0_search', 'mem0_profile', 'mem0_save']);
  });
});

describe('mem0_search tool', () => {
  async function run(provider: Mem0Provider, params: Record<string, unknown>) {
    const tool = createMem0Tools(provider, 'u').find((t) => t.name === 'mem0_search')!;
    const result = await tool.execute('c', params);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('returns search results', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([{ id: '1', memory: 'likes cats', score: 0.9 }]),
    });
    const result = await run(provider, { query: 'pets' });
    expect(result.results).toEqual([{ memory: 'likes cats', score: 0.9 }]);
  });

  it('rejects empty query', async () => {
    const result = await run(mockProvider(), { query: '' });
    expect(result.error).toContain('empty');
  });

  it('caps top_k at 50', async () => {
    const provider = mockProvider();
    await run(provider, { query: 'test', top_k: 100 });
    expect(provider.search).toHaveBeenCalledWith('test', { userId: 'u', topK: 50 });
  });

  it('handles provider error', async () => {
    const provider = mockProvider({
      search: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const result = await run(provider, { query: 'test' });
    expect(result.error).toContain('fail');
  });
});

describe('mem0_save tool', () => {
  async function run(provider: Mem0Provider, params: Record<string, unknown>) {
    const tool = createMem0Tools(provider, 'u').find((t) => t.name === 'mem0_save')!;
    const result = await tool.execute('c', params);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('stores a fact with infer=false', async () => {
    const provider = mockProvider({
      add: vi.fn().mockResolvedValue({ results: [{ id: '1', memory: 'fact', event: 'ADD' }] }),
    });
    const result = await run(provider, { fact: 'user prefers dark mode' });
    expect(result.result).toBe('Fact stored.');
    expect(provider.add).toHaveBeenCalledWith(
      [{ role: 'user', content: 'user prefers dark mode' }],
      { userId: 'u', infer: false },
    );
  });

  it('rejects empty fact', async () => {
    const result = await run(mockProvider(), { fact: '  ' });
    expect(result.error).toContain('empty');
  });

  it('handles provider error', async () => {
    const provider = mockProvider({
      add: vi.fn().mockRejectedValue(new Error('network')),
    });
    const result = await run(provider, { fact: 'something' });
    expect(result.error).toContain('network');
  });
});

describe('mem0_profile tool', () => {
  async function run(provider: Mem0Provider) {
    const tool = createMem0Tools(provider, 'u').find((t) => t.name === 'mem0_profile')!;
    const result = await tool.execute('c', {});
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('returns all memories', async () => {
    const provider = mockProvider({
      getAll: vi.fn().mockResolvedValue([
        { id: '1', memory: 'fact A' },
        { id: '2', memory: 'fact B' },
      ]),
    });
    const result = await run(provider);
    expect(result.count).toBe(2);
    expect(result.result).toContain('fact A');
    expect(result.result).toContain('fact B');
  });

  it('returns message when empty', async () => {
    const result = await run(mockProvider());
    expect(result.result).toBe('No memories stored yet.');
  });
});

// ---------------------------------------------------------------------------
// Key resolver integration
// ---------------------------------------------------------------------------

describe('KeyResolver', () => {
  it('type accepts async provider name resolver', () => {
    const resolver: KeyResolver = async (provider: string) => {
      if (provider === 'openai') return 'sk-test-key';
      return undefined;
    };
    expect(resolver).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mapApiToMem0Provider
// ---------------------------------------------------------------------------

describe('mapApiToMem0Provider', () => {
  it('maps openai-completions to openai', () => {
    expect(mapApiToMem0Provider('openai-completions', 'fallback')).toBe('openai');
  });

  it('maps openai-responses to openai', () => {
    expect(mapApiToMem0Provider('openai-responses', 'fallback')).toBe('openai');
  });

  it('maps anthropic-messages to anthropic', () => {
    expect(mapApiToMem0Provider('anthropic-messages', 'fallback')).toBe('anthropic');
  });

  it('maps azure-openai to azure_openai', () => {
    expect(mapApiToMem0Provider('azure-openai', 'fallback')).toBe('azure_openai');
  });

  it('maps google to gemini', () => {
    expect(mapApiToMem0Provider('google-ai', 'fallback')).toBe('gemini');
  });

  it('maps gemini to gemini', () => {
    expect(mapApiToMem0Provider('gemini-something', 'fallback')).toBe('gemini');
  });

  it('returns fallback for undefined api', () => {
    expect(mapApiToMem0Provider(undefined, 'ollama')).toBe('ollama');
  });

  it('returns fallback for unknown api', () => {
    expect(mapApiToMem0Provider('some-unknown-api', 'myProvider')).toBe('myProvider');
  });
});

// ---------------------------------------------------------------------------
// ProviderResolver integration
// ---------------------------------------------------------------------------

describe('ProviderResolver', () => {
  it('type accepts async full provider resolver', () => {
    const resolver: ProviderResolver = async (provider: string) => {
      if (provider === 'amaster') {
        return {
          apiKey: 'sk-test',
          baseUrl: 'https://credits.amaster.ai/v1',
          api: 'openai-completions',
        };
      }
      return undefined;
    };
    expect(resolver).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// OSSProvider._buildConfig via createMem0Provider (integration)
// ---------------------------------------------------------------------------

let __capturedMem0Config: Record<string, unknown> | undefined;

vi.mock('mem0ai/oss', () => ({
  Memory: class MockMemory {
    constructor(config: Record<string, unknown>) {
      __capturedMem0Config = config;
    }
    async getAll() {
      return [];
    }
  },
}));

describe('createMem0Provider with resolveProvider', () => {
  beforeEach(() => {
    __capturedMem0Config = undefined;
  });

  it('maps custom provider to openai and injects baseURL', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: {
          embedder: { provider: 'amaster', config: { model: 'text-embedding-v4' } },
          llm: { provider: 'amaster', config: { model: 'deepseek-v4-pro' } },
        },
      },
      resolveProvider: async (providerName) => {
        if (providerName === 'amaster') {
          return {
            apiKey: 'sk-amaster-key',
            baseUrl: 'https://credits.amaster.ai/v1',
            api: 'openai-completions',
          };
        }
        return undefined;
      },
    });

    expect(__capturedMem0Config).toBeDefined();

    const embedder = __capturedMem0Config!.embedder as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(embedder.provider).toBe('openai');
    expect(embedder.config.apiKey).toBe('sk-amaster-key');
    expect(embedder.config.baseURL).toBe('https://credits.amaster.ai/v1');
    expect(embedder.config.model).toBe('text-embedding-v4');

    const llm = __capturedMem0Config!.llm as { provider: string; config: Record<string, unknown> };
    expect(llm.provider).toBe('openai');
    expect(llm.config.apiKey).toBe('sk-amaster-key');
    expect(llm.config.baseURL).toBe('https://credits.amaster.ai/v1');
    expect(llm.config.model).toBe('deepseek-v4-pro');
  });

  it('falls back to resolveKey when resolveProvider is not provided', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: {
          embedder: { provider: 'openai', config: { model: 'text-embedding-3-small' } },
        },
      },
      resolveKey: async (providerName) => {
        if (providerName === 'openai') return 'sk-legacy-key';
        return undefined;
      },
    });

    expect(__capturedMem0Config).toBeDefined();
    const embedder = __capturedMem0Config!.embedder as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(embedder.provider).toBe('openai');
    expect(embedder.config.apiKey).toBe('sk-legacy-key');
    expect(embedder.config.baseURL).toBeUndefined();
  });

  it('keeps original provider name when resolveProvider returns undefined', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: {
          embedder: { provider: 'ollama', config: { model: 'nomic-embed' } },
        },
      },
      resolveProvider: async () => undefined,
    });

    expect(__capturedMem0Config).toBeDefined();
    const embedder = __capturedMem0Config!.embedder as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(embedder.provider).toBe('ollama');
  });
});

// ---------------------------------------------------------------------------
// SqliteSnapshotStore
// ---------------------------------------------------------------------------

// These tests require better-sqlite3 native binding compiled for the current Node version.
// Skip if the binding is unavailable (e.g. compiled for a different Node/Electron version).
const canUseSqlite = (() => {
  try {
    const { createRequire } = require('node:module');
    const req = createRequire(import.meta.url);
    const BS3 = req('better-sqlite3');
    const db = new BS3(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!canUseSqlite)('SqliteSnapshotStore', () => {
  let dbPath: string;
  let store: SqliteSnapshotStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mem0-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SqliteSnapshotStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  it('creates db file and table', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('loadAll returns empty for new user', () => {
    const items = store.loadAll('user-1');
    expect(items).toEqual([]);
  });

  it('replaceAll stores and loadAll retrieves memories', () => {
    store.replaceAll('user-1', [
      {
        id: 'a',
        memory: 'likes cats',
        score: undefined,
        created_at: '2026-01-01',
        updated_at: '2026-01-02',
      },
      {
        id: 'b',
        memory: 'uses vim',
        score: undefined,
        created_at: '2026-01-01',
        updated_at: undefined,
      },
    ]);

    const items = store.loadAll('user-1');
    expect(items).toHaveLength(2);
    expect(items[0]!.memory).toBe('likes cats');
    expect(items[1]!.memory).toBe('uses vim');
  });

  it('replaceAll overwrites previous data', () => {
    store.replaceAll('user-1', [{ id: 'a', memory: 'old fact', score: undefined }]);
    store.replaceAll('user-1', [{ id: 'b', memory: 'new fact', score: undefined }]);

    const items = store.loadAll('user-1');
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('b');
    expect(items[0]!.memory).toBe('new fact');
  });

  it('isolates data by userId', () => {
    store.replaceAll('user-1', [{ id: 'a', memory: 'fact A', score: undefined }]);
    store.replaceAll('user-2', [{ id: 'b', memory: 'fact B', score: undefined }]);

    expect(store.loadAll('user-1')).toHaveLength(1);
    expect(store.loadAll('user-2')).toHaveLength(1);
    expect(store.loadAll('user-1')[0]!.memory).toBe('fact A');
    expect(store.loadAll('user-2')[0]!.memory).toBe('fact B');
  });

  it('tryCreate returns null on invalid path', () => {
    const result = SqliteSnapshotStore.tryCreate('/dev/null/impossible/path.db');
    expect(result).toBeNull();
  });

  it('tryCreate returns instance on valid path', () => {
    const validPath = join(tmpdir(), `mem0-try-${Date.now()}.db`);
    const instance = SqliteSnapshotStore.tryCreate(validPath);
    expect(instance).toBeInstanceOf(SqliteSnapshotStore);
    instance?.close();
    if (existsSync(validPath)) rmSync(validPath);
  });

  it('loadAllUsers groups by userId', () => {
    store.replaceAll('alice', [
      { id: '1', memory: 'alice fact 1', score: undefined },
      { id: '2', memory: 'alice fact 2', score: undefined },
    ]);
    store.replaceAll('bob', [{ id: '3', memory: 'bob fact', score: undefined }]);

    const result = store.loadAllUsers();
    expect(result).toHaveLength(2);

    const alice = result.find((r) => r.userId === 'alice');
    const bob = result.find((r) => r.userId === 'bob');
    expect(alice?.items).toHaveLength(2);
    expect(bob?.items).toHaveLength(1);
    expect(bob!.items[0]!.memory).toBe('bob fact');
  });

  it('loadAllUsers returns empty when no data', () => {
    const result = store.loadAllUsers();
    expect(result).toEqual([]);
  });

  it('replaceAll handles empty items array (clears user data)', () => {
    store.replaceAll('user-1', [{ id: 'a', memory: 'fact', score: undefined }]);
    store.replaceAll('user-1', []);

    expect(store.loadAll('user-1')).toEqual([]);
  });

  it('handles concurrent replaceAll for different users', () => {
    store.replaceAll('user-1', [{ id: 'a', memory: 'A', score: undefined }]);
    store.replaceAll('user-2', [{ id: 'b', memory: 'B', score: undefined }]);
    store.replaceAll('user-1', [{ id: 'c', memory: 'C', score: undefined }]);

    expect(store.loadAll('user-1')).toHaveLength(1);
    expect(store.loadAll('user-1')[0]!.memory).toBe('C');
    expect(store.loadAll('user-2')).toHaveLength(1);
    expect(store.loadAll('user-2')[0]!.memory).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// createMem0Provider — additional scenarios
// ---------------------------------------------------------------------------

describe('createMem0Provider additional scenarios', () => {
  beforeEach(() => {
    __capturedMem0Config = undefined;
  });

  it('uses default embedder and llm when oss config is empty', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: { mode: 'open-source' },
    });

    expect(__capturedMem0Config).toBeDefined();
    const embedder = __capturedMem0Config!.embedder as {
      provider: string;
      config: Record<string, unknown>;
    };
    const llm = __capturedMem0Config!.llm as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(embedder.provider).toBe('openai');
    expect(embedder.config.model).toBe('text-embedding-3-small');
    expect(llm.provider).toBe('openai');
    expect(llm.config.model).toBe('gpt-4.1-nano');
  });

  it('defaults vectorStore to memory provider', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: { mode: 'open-source' },
    });

    expect(__capturedMem0Config).toBeDefined();
    const vs = __capturedMem0Config!.vectorStore as { provider: string };
    expect(vs.provider).toBe('memory');
  });

  it('respects custom vectorStore config', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: {
          vectorStore: { provider: 'qdrant', config: { url: 'http://localhost:6333' } },
        },
      },
    });

    expect(__capturedMem0Config).toBeDefined();
    const vs = __capturedMem0Config!.vectorStore as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(vs.provider).toBe('qdrant');
    expect(vs.config.url).toBe('http://localhost:6333');
  });

  it('does not inject baseURL when resolveProvider returns no baseUrl', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: {
          embedder: { provider: 'custom' },
        },
      },
      resolveProvider: async () => ({ apiKey: 'key123', api: 'openai-completions' }),
    });

    expect(__capturedMem0Config).toBeDefined();
    const embedder = __capturedMem0Config!.embedder as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(embedder.provider).toBe('openai');
    expect(embedder.config.apiKey).toBe('key123');
    expect(embedder.config.baseURL).toBeUndefined();
  });

  it('does not override explicitly set apiKey in config', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: {
          embedder: { provider: 'openai', config: { apiKey: 'explicit-key' } },
        },
      },
      resolveProvider: async () => ({ apiKey: 'registry-key', api: 'openai-completions' }),
    });

    expect(__capturedMem0Config).toBeDefined();
    const embedder = __capturedMem0Config!.embedder as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(embedder.config.apiKey).toBe('explicit-key');
  });

  it('throws for platform mode without apiKey', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await expect(create({ config: { mode: 'platform' } })).rejects.toThrow(
      'Platform mode requires apiKey',
    );
  });

  it('sets disableHistory when configured', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'open-source',
        oss: { disableHistory: true },
      },
    });

    expect(__capturedMem0Config).toBeDefined();
    expect(__capturedMem0Config!.disableHistory).toBe(true);
  });
});
