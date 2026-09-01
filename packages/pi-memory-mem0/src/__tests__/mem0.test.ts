import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyResolver, ProviderResolver } from '../provider.js';
import {
  formatObservedAt,
  mapApiToMem0Provider,
  normalizeMemoryMode,
  rewriteObservationDate,
} from '../provider.js';

vi.mock('@amaster.ai/pi-shared/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveHome: () => join(tmpdir(), 'pi-memory-mem0-unit-home'),
  };
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
        mode: 'embedded',
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

  it('keeps the historical open-source mode as an embedded runtime alias', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: { mode: 'open-source' as never },
    });

    expect(__capturedMem0Config).toBeDefined();
  });

  it('falls back to resolveKey when resolveProvider is not provided', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
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
        mode: 'embedded',
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
// createMem0Provider — additional scenarios
// ---------------------------------------------------------------------------

describe('createMem0Provider additional scenarios', () => {
  beforeEach(() => {
    __capturedMem0Config = undefined;
  });

  it('uses default embedder and llm when oss config is empty', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: { mode: 'embedded' },
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

  it('passes custom extraction instructions to mem0 OSS', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
        oss: { customInstructions: 'Always record memories in Simplified Chinese.' },
      },
    });

    expect(__capturedMem0Config?.customInstructions).toBe(
      'Always record memories in Simplified Chinese.',
    );
  });

  it('defaults vectorStore to memory provider', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: { mode: 'embedded' },
    });

    expect(__capturedMem0Config).toBeDefined();
    const vs = __capturedMem0Config!.vectorStore as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(vs.provider).toBe('memory');
    expect(String(vs.config.dbPath).replace(/\\/g, '/')).toContain('/memories/mem0-vectors.db');
  });

  it('fills Pi defaults for a custom memory vector store config', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
        oss: {
          vectorStore: { provider: 'memory', config: { collectionName: 'custom' } },
        },
      },
    });

    const vs = __capturedMem0Config!.vectorStore as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(vs.config.collectionName).toBe('custom');
    expect(String(vs.config.dbPath).replace(/\\/g, '/')).toContain('/memories/mem0-vectors.db');
  });

  it('preserves an explicit in-memory SQLite dbPath', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
        oss: {
          vectorStore: { provider: 'memory', config: { dbPath: ':memory:' } },
        },
      },
    });

    const vs = __capturedMem0Config!.vectorStore as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(vs.config.dbPath).toBe(':memory:');
  });

  it('respects custom vectorStore config', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
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

  it('defaults historyStore to the Pi memories directory', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: { mode: 'embedded' },
    });

    expect(__capturedMem0Config).toBeDefined();
    const historyStore = __capturedMem0Config!.historyStore as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(historyStore.provider).toBe('sqlite');
    expect(String(historyStore.config.historyDbPath).replace(/\\/g, '/')).toContain(
      '/memories/mem0-history.db',
    );
  });

  it('respects custom historyStore config', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
        oss: {
          historyStore: {
            provider: 'sqlite',
            config: { historyDbPath: '/tmp/custom-mem0-history.db' },
          },
        },
      },
    });

    expect(__capturedMem0Config).toBeDefined();
    const historyStore = __capturedMem0Config!.historyStore as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(historyStore.provider).toBe('sqlite');
    expect(historyStore.config.historyDbPath).toBe('/tmp/custom-mem0-history.db');
  });

  it('does not inject baseURL when resolveProvider returns no baseUrl', async () => {
    const { createMem0Provider: create } = await import('../provider.js');

    await create({
      config: {
        mode: 'embedded',
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
        mode: 'embedded',
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
        mode: 'embedded',
        oss: { disableHistory: true },
      },
    });

    expect(__capturedMem0Config).toBeDefined();
    expect(__capturedMem0Config!.disableHistory).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// observedAt helpers
// ---------------------------------------------------------------------------

describe('formatObservedAt', () => {
  it('formats a Date to YYYY-MM-DD', () => {
    expect(formatObservedAt(new Date(Date.UTC(2023, 4, 8)))).toBe('2023-05-08');
  });

  it('formats an ISO string to YYYY-MM-DD', () => {
    expect(formatObservedAt('2023-05-08T13:56:00Z')).toBe('2023-05-08');
  });

  it('returns the raw string for an unparseable value', () => {
    expect(formatObservedAt('not a date')).toBe('not a date');
  });
});

describe('rewriteObservationDate', () => {
  const prompt = [
    '## New Messages',
    'Caroline: I went to a group yesterday.',
    '',
    '## Observation Date',
    '2026-07-03',
    '',
    '## Current Date',
    '2026-07-03',
    '',
    '# Output:',
  ].join('\n');

  it('rewrites both Observation Date and Current Date to the given date', () => {
    const out = rewriteObservationDate(prompt, '2023-05-08');
    expect(out).toContain('## Observation Date\n2023-05-08');
    expect(out).toContain('## Current Date\n2023-05-08');
    expect(out).not.toContain('2026-07-03');
  });

  it('leaves the message body untouched', () => {
    const out = rewriteObservationDate(prompt, '2023-05-08');
    expect(out).toContain('Caroline: I went to a group yesterday.');
  });

  it('is a no-op when the sections are absent', () => {
    const plain = 'no date sections here';
    expect(rewriteObservationDate(plain, '2023-05-08')).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// normalizeMemoryMode
// ---------------------------------------------------------------------------

describe('normalizeMemoryMode', () => {
  it('defaults to hybrid when unset', () => {
    expect(normalizeMemoryMode(undefined)).toBe('hybrid');
    expect(normalizeMemoryMode(null)).toBe('hybrid');
  });

  it('accepts the three supported memory modes', () => {
    expect(normalizeMemoryMode('hybrid')).toBe('hybrid');
    expect(normalizeMemoryMode('active')).toBe('active');
    expect(normalizeMemoryMode('passive')).toBe('passive');
  });

  it('rejects an unsupported memory mode', () => {
    expect(() => normalizeMemoryMode('auto')).toThrow('Unsupported memory mode: auto');
  });
});
