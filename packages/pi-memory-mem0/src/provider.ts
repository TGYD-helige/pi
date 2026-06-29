/**
 * Mem0 provider abstraction — supports both Platform (cloud) and OSS (local SQLite) modes.
 *
 * Uses the `mem0ai` npm SDK which handles:
 * - Platform mode: REST API calls to api.mem0.ai
 * - OSS mode: in-memory vector store + LLM extraction via configured provider
 *
 * In OSS mode, a SQLite snapshot layer persists memories to disk so they survive
 * process restarts. On init, memories are restored from SQLite into the in-memory
 * vector store. After each add(), a full snapshot is asynchronously written back.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resolveHome } from '@amaster.ai/pi-shared/settings';
import type { AddResult, Mem0ExtensionConfig, MemoryItem } from './types.js';

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

export interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    opts: { userId: string; agentId?: string; infer?: boolean },
  ): Promise<AddResult | null>;

  search(query: string, opts: { userId: string; agentId?: string; topK?: number }): Promise<MemoryItem[]>;

  getAll(opts: { userId: string; agentId?: string }): Promise<MemoryItem[]>;

  delete(memoryId: string): Promise<void>;

  /** Flush any pending snapshot writes. No-op for platform mode. */
  flushSnapshot(userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeMemoryItem(raw: Record<string, unknown>): MemoryItem {
  return {
    id: String(raw.id ?? raw.memory_id ?? ''),
    memory: String(raw.memory ?? raw.text ?? raw.content ?? ''),
    score: typeof raw.score === 'number' ? raw.score : undefined,
    user_id: raw.user_id as string | undefined,
    created_at: (raw.created_at ?? raw.createdAt) as string | undefined,
    updated_at: (raw.updated_at ?? raw.updatedAt) as string | undefined,
  };
}

function normalizeResults(raw: unknown): MemoryItem[] {
  if (Array.isArray(raw))
    return raw.map((item) => normalizeMemoryItem(item as Record<string, unknown>));
  if (
    raw &&
    typeof raw === 'object' &&
    'results' in raw &&
    Array.isArray((raw as { results: unknown }).results)
  ) {
    return (raw as { results: unknown[] }).results.map((item) =>
      normalizeMemoryItem(item as Record<string, unknown>),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Platform Provider
// ---------------------------------------------------------------------------

class PlatformProvider implements Mem0Provider {
  private client: unknown;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl?: string,
  ) {}

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { MemoryClient } = await import('mem0ai');
    const opts: Record<string, unknown> = { apiKey: this.apiKey };
    if (this.baseUrl) opts.host = this.baseUrl;
    this.client = new MemoryClient(opts as never);
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: { userId: string; agentId?: string; infer?: boolean },
  ): Promise<AddResult | null> {
    await this.ensureClient();
    const addOpts: Record<string, unknown> = { userId: opts.userId };
    if (opts.agentId) {
      addOpts.filters = { user_id: opts.userId, agent_id: opts.agentId };
    }
    if (opts.infer === false) addOpts.infer = false;
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const result = await (this.client as any).add(messages, addOpts);
    return result as AddResult;
  }

  async search(query: string, opts: { userId: string; agentId?: string; topK?: number }): Promise<MemoryItem[]> {
    await this.ensureClient();
    const searchOpts: Record<string, unknown> = {
      filters: { user_id: opts.userId },
    };
    if (opts.agentId) {
      searchOpts.filters.agent_id = opts.agentId;
    }
    if (opts.topK) searchOpts.topK = opts.topK;
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const results = await (this.client as any).search(query, searchOpts);
    return normalizeResults(results);
  }

  async getAll(opts: { userId: string; agentId?: string }): Promise<MemoryItem[]> {
    await this.ensureClient();
    const filters: Record<string, unknown> = { user_id: opts.userId };
    if (opts.agentId) {
      filters.agent_id = opts.agentId;
    }
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const results = await (this.client as any).getAll({
      filters,
    });
    return normalizeResults(results);
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureClient();
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    await (this.client as any).delete(memoryId);
  }

  async flushSnapshot(): Promise<void> {
    // Platform mode persists server-side, no local snapshot to flush.
  }
}
// SQLite Snapshot Store — persists mem0 memories to disk for restart recovery
// ---------------------------------------------------------------------------

interface SqliteDatabase {
  pragma(sql: string): void;
  exec(sql: string): void;
  prepare(sql: string): {
    // biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 untyped return
    all(...args: unknown[]): any[];
    run(...args: unknown[]): void;
  };
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export class SqliteSnapshotStore {
  private db: SqliteDatabase;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const req = createRequire(import.meta.url);
    const mem0OssPath = req.resolve('mem0ai/oss');
    const reqFromMem0 = createRequire(mem0OssPath);
    const BS3 = reqFromMem0('better-sqlite3');
    this.db = new BS3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        memory TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      )
    `);
  }

  loadAll(
    userId: string,
  ): Array<{ id: string; memory: string; created_at?: string; updated_at?: string }> {
    return this.db
      .prepare('SELECT id, memory, created_at, updated_at FROM memories WHERE user_id = ?')
      .all(userId);
  }

  loadAllUsers(): Array<{ userId: string; items: Array<{ id: string; memory: string }> }> {
    const rows: Array<{ user_id: string; id: string; memory: string }> = this.db
      .prepare('SELECT user_id, id, memory FROM memories')
      .all();
    const grouped = new Map<string, Array<{ id: string; memory: string }>>();
    for (const row of rows) {
      let list = grouped.get(row.user_id);
      if (!list) {
        list = [];
        grouped.set(row.user_id, list);
      }
      list.push({ id: row.id, memory: row.memory });
    }
    return Array.from(grouped.entries()).map(([userId, items]) => ({ userId, items }));
  }

  replaceAll(userId: string, items: MemoryItem[]): void {
    const del = this.db.prepare('DELETE FROM memories WHERE user_id = ?');
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO memories (id, user_id, memory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      del.run(userId);
      for (const item of items) {
        ins.run(item.id, userId, item.memory, item.created_at ?? null, item.updated_at ?? null);
      }
    });
    tx();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  static tryCreate(dbPath: string): SqliteSnapshotStore | null {
    try {
      return new SqliteSnapshotStore(dbPath);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Open-Source Provider (in-memory vector store + SQLite snapshot persistence)
// ---------------------------------------------------------------------------

/** Optional key resolver — pulls API keys from pi's model registry. */
export type KeyResolver = (provider: string) => Promise<string | undefined>;

/** Resolved provider info from the model registry. */
export interface ResolvedProviderInfo {
  apiKey?: string;
  baseUrl?: string;
  /** API type from model registry, e.g. "openai-completions", "anthropic-messages" */
  api?: string;
}

/** Full provider resolver — returns key, baseUrl, and api type from the model registry. */
export type ProviderResolver = (provider: string) => Promise<ResolvedProviderInfo | undefined>;

/**
 * Maps a pi model registry `api` field to a mem0-compatible provider name.
 * mem0ai supports: openai, ollama, lmstudio, google/gemini, azure_openai, langchain (embedder)
 *                  openai, anthropic, groq, ollama, lmstudio, google/gemini, azure_openai, mistral, deepseek, langchain (llm)
 */
export function mapApiToMem0Provider(api: string | undefined, fallback: string): string {
  if (!api) return fallback;
  if (api.startsWith('openai')) return 'openai';
  if (api.startsWith('anthropic')) return 'anthropic';
  if (api.startsWith('azure')) return 'azure_openai';
  if (api.startsWith('google') || api.startsWith('gemini')) return 'gemini';
  return fallback;
}

class OSSProvider implements Mem0Provider {
  private memory: unknown;
  private initPromise: Promise<void> | null = null;
  private snapshot: SqliteSnapshotStore | null = null;
  private syncingSnapshot = false;

  constructor(
    private readonly ossConfig: Mem0ExtensionConfig['oss'] | undefined,
    private readonly resolveKey?: KeyResolver,
    private readonly resolveProvider?: ProviderResolver,
    private readonly snapshotDbPath?: string,
  ) {}

  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _buildConfig(): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = {};

    const defaultEmbedder = { provider: 'openai', config: { model: 'text-embedding-3-small' } };
    const defaultLlm = { provider: 'openai', config: { model: 'gpt-4.1-nano' } };

    let embedderProvider = this.ossConfig?.embedder?.provider || defaultEmbedder.provider;
    const embedderCfg: Record<string, unknown> = {
      ...defaultEmbedder.config,
      ...(this.ossConfig?.embedder?.config ?? {}),
    };

    let llmProvider = this.ossConfig?.llm?.provider || defaultLlm.provider;
    const llmCfg: Record<string, unknown> = {
      ...defaultLlm.config,
      ...(this.ossConfig?.llm?.config ?? {}),
    };

    // Resolve provider info (apiKey + baseUrl + api) from pi model registry
    if (this.resolveProvider) {
      if (!embedderCfg.apiKey && !embedderCfg.api_key) {
        const info = await this.resolveProvider(embedderProvider);
        if (info) {
          if (info.apiKey) embedderCfg.apiKey = info.apiKey;
          if (info.baseUrl) embedderCfg.baseURL = info.baseUrl;
          embedderProvider = mapApiToMem0Provider(info.api, embedderProvider);
        }
      }
      if (!llmCfg.apiKey && !llmCfg.api_key) {
        const info = await this.resolveProvider(llmProvider);
        if (info) {
          if (info.apiKey) llmCfg.apiKey = info.apiKey;
          if (info.baseUrl) llmCfg.baseURL = info.baseUrl;
          llmProvider = mapApiToMem0Provider(info.api, llmProvider);
        }
      }
    } else if (this.resolveKey) {
      // Legacy fallback: only resolve API keys
      if (!embedderCfg.apiKey && !embedderCfg.api_key) {
        const key = await this.resolveKey(embedderProvider);
        if (key) embedderCfg.apiKey = key;
      }
      if (!llmCfg.apiKey && !llmCfg.api_key) {
        const key = await this.resolveKey(llmProvider);
        if (key) llmCfg.apiKey = key;
      }
    }

    config.embedder = { provider: embedderProvider, config: embedderCfg };
    config.llm = { provider: llmProvider, config: llmCfg };

    if (this.ossConfig?.vectorStore) {
      config.vectorStore = this.ossConfig.vectorStore;
    } else {
      config.vectorStore = {
        provider: 'memory',
        config: { collectionName: 'pi_mem0' },
      };
    }

    if (this.ossConfig?.disableHistory) {
      config.disableHistory = true;
    }

    return config;
  }

  private async _init(): Promise<void> {
    const mod = await import('mem0ai/oss');
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const Memory = (mod as any).Memory ?? (mod as any).default;

    // Detect broken better-sqlite3 (Node version mismatch) — disable history if so
    let sqliteOk = true;
    if (!this.ossConfig?.disableHistory) {
      try {
        const req = createRequire(import.meta.url);
        const mem0OssPath = req.resolve('mem0ai/oss');
        const reqFromMem0 = createRequire(mem0OssPath);
        const BS3 = reqFromMem0('better-sqlite3');
        const testDb = new BS3(':memory:');
        testDb.close();
      } catch {
        sqliteOk = false;
      }
    }

    const builtConfig = await this._buildConfig();
    if (!sqliteOk) builtConfig.disableHistory = true;

    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    let mem: any;
    try {
      mem = new Memory(builtConfig);
    } catch (err) {
      if (sqliteOk && !this.ossConfig?.disableHistory) {
        builtConfig.disableHistory = true;
        mem = new Memory(builtConfig);
      } else {
        throw err;
      }
    }

    this.memory = mem;

    // Initialize SQLite snapshot store for persistence
    if (this.snapshotDbPath && sqliteOk) {
      this.snapshot = SqliteSnapshotStore.tryCreate(this.snapshotDbPath);
    }

    // Restore memories from snapshot into the in-memory vector store
    if (this.snapshot) {
      const allUsers = this.snapshot.loadAllUsers();
      let totalRestored = 0;
      for (const { userId: uid, items } of allUsers) {
        for (const item of items) {
          try {
            await mem.add([{ role: 'user', content: item.memory }], { userId: uid, infer: false });
            totalRestored++;
          } catch {
            /* skip failed restores */
          }
        }
      }
      if (totalRestored > 0) {
        console.error(`[pi-memory-mem0] restored ${totalRestored} memories from snapshot`);
      }
    }

    await mem.getAll({ filters: { user_id: '__warmup__' } });
  }

  private asyncSnapshotSync(userId: string): void {
    if (!this.snapshot || this.syncingSnapshot) return;
    this.syncingSnapshot = true;
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    (this.memory as any)
      .getAll({ filters: { user_id: userId } })
      .then((results: unknown) => {
        const items = normalizeResults(results);
        this.snapshot!.replaceAll(userId, items);
      })
      .catch(() => {})
      .finally(() => {
        this.syncingSnapshot = false;
      });
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: { userId: string; agentId?: string; infer?: boolean },
  ): Promise<AddResult | null> {
    await this.ensureMemory();
    const addOpts: Record<string, unknown> = { userId: opts.userId };
    if (opts.agentId) {
      addOpts.filters = { user_id: opts.userId, agent_id: opts.agentId };
    }
    if (opts.infer === false) addOpts.infer = false;
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const result = await (this.memory as any).add(messages, addOpts);
    this.asyncSnapshotSync(opts.userId);
    return result as AddResult;
  }

  async search(query: string, opts: { userId: string; agentId?: string; topK?: number }): Promise<MemoryItem[]> {
    await this.ensureMemory();
    const searchOpts: Record<string, unknown> = {
      filters: { user_id: opts.userId },
    };
    if (opts.agentId) {
      searchOpts.filters.agent_id = opts.agentId;
    }
    if (opts.topK) searchOpts.topK = opts.topK;
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const results = await (this.memory as any).search(query, searchOpts);
    return normalizeResults(results);
  }

  async getAll(opts: { userId: string; agentId?: string }): Promise<MemoryItem[]> {
    await this.ensureMemory();
    const filters: Record<string, unknown> = { user_id: opts.userId };
    if (opts.agentId) {
      filters.agent_id = opts.agentId;
    }
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const results = await (this.memory as any).getAll({
      filters,
    });
    return normalizeResults(results);
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureMemory();
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    await (this.memory as any).delete(memoryId);
  }

  async flushSnapshot(userId: string): Promise<void> {
    if (!this.snapshot) return;
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    const results = await (this.memory as any).getAll({
      filters: { user_id: userId },
    });
    const items = normalizeResults(results);
    this.snapshot.replaceAll(userId, items);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateProviderOptions {
  config: Mem0ExtensionConfig;
  /** Resolve API key from pi model registry by provider name. @deprecated Use resolveProvider instead. */
  resolveKey?: KeyResolver;
  /** Full provider resolver — returns key, baseUrl, and api type from the model registry. */
  resolveProvider?: ProviderResolver;
}

export async function createMem0Provider(opts: CreateProviderOptions): Promise<Mem0Provider> {
  const { config, resolveKey, resolveProvider } = opts;
  const mode = config.mode ?? 'platform';

  if (mode === 'open-source') {
    const useRegistry = config.useRegistryKeys !== false;
    const snapshotDbPath =
      config.oss?.snapshotDbPath ?? join(resolveHome(), 'memories', 'mem0-snapshot.db');
    const provider = new OSSProvider(
      config.oss,
      useRegistry ? resolveKey : undefined,
      useRegistry ? resolveProvider : undefined,
      snapshotDbPath,
    );
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    await (provider as any).ensureMemory();
    return provider;
  }

  if (!config.apiKey?.trim()) {
    throw new Error('Platform mode requires apiKey.');
  }
  return new PlatformProvider(config.apiKey.trim(), config.baseUrl?.trim());
}
