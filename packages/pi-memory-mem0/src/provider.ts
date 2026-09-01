/**
 * Mem0 provider abstraction for Platform, embedded, and self-hosted REST modes.
 *
 * Uses the `mem0ai` npm SDK which handles:
 * - Platform mode: REST API calls to api.mem0.ai
 * - Embedded mode: vector storage + LLM extraction via configured providers
 * - Self-hosted mode: direct HTTP calls to a separately deployed Mem0 server
 *
 * The embedded mem0 `memory` vector store is itself SQLite-backed. This extension
 * configures it with a file under Pi home by default and lets mem0 own persistence
 * directly.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolveHome } from '@amaster.ai/pi-shared/settings';
import type {
  AddResult,
  Mem0ExtensionConfig,
  Mem0MemoryMode,
  Mem0Mode,
  MemoryItem,
} from './types.js';

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

type Mem0ScopeOptions = { userId: string; agentId?: string; signal?: AbortSignal };
type Mem0AddOptions = Mem0ScopeOptions & { infer?: boolean; observedAt?: Date | string };
type Mem0SearchOptions = Mem0ScopeOptions & { topK?: number };
const DEDUP_PAGE_SIZE = 200;
const MAX_DEDUP_ITEMS_PER_SCOPE = 10_000;
const MAX_DEDUP_PAGES = MAX_DEDUP_ITEMS_PER_SCOPE / DEDUP_PAGE_SIZE;
const SELF_HOSTED_DEDUP_LIMIT = 1000;

export interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    opts: Mem0AddOptions,
  ): Promise<AddResult | null>;

  search(query: string, opts: Mem0SearchOptions): Promise<MemoryItem[]>;

  getAll(opts: Mem0ScopeOptions): Promise<MemoryItem[]>;

  /** Enumerate maintenance groups that may be deduplicated independently. */
  getDedupGroups?(opts: Mem0ScopeOptions): Promise<MemoryItem[][]>;

  delete(memoryId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

export function normalizeMem0Mode(mode: unknown): Mem0Mode {
  if (mode === undefined || mode === null) return 'platform';
  if (mode === 'open-source') return 'embedded';
  if (mode === 'platform' || mode === 'embedded' || mode === 'self-hosted') return mode;
  throw new Error(`Unsupported Mem0 mode: ${String(mode)}`);
}

export function normalizeMemoryMode(memoryMode: unknown): Mem0MemoryMode {
  if (memoryMode === undefined || memoryMode === null) return 'hybrid';
  if (memoryMode === 'hybrid' || memoryMode === 'active' || memoryMode === 'passive') {
    return memoryMode;
  }
  throw new Error(`Unsupported memory mode: ${String(memoryMode)}`);
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Format an observedAt value as YYYY-MM-DD for mem0's Observation Date field.
 * mem0's extraction prompt grounds relative times ("yesterday", "last week")
 * to this date. When not supplied mem0 falls back to system now — wrong for
 * ingesting historical conversations.
 */
export function formatObservedAt(v: Date | string): string {
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

/**
 * Rewrite the "## Observation Date" and "## Current Date" sections of mem0's
 * extraction user-prompt to a fixed date. mem0 has no public parameter for
 * this — its own prompt documents an Observation Date it never lets callers
 * set — so OSSProvider.add intercepts the LLM call and runs the prompt through
 * this before forwarding. Exported for unit testing.
 */
export function rewriteObservationDate(content: string, dateStr: string): string {
  let c = content.replace(/## Observation Date\n[^\n]*/, `## Observation Date\n${dateStr}`);
  c = c.replace(/## Current Date\n[^\n]*/, `## Current Date\n${dateStr}`);
  return c;
}

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

function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Mem0 request cancelled.');
}

/**
 * Stop awaiting SDK promises promptly when Pi cancels the tool call. Platform
 * and direct REST requests also propagate the signal to fetch; the embedded
 * SDK has no AbortSignal hook, so only the caller's wait can be cancelled.
 */
function waitWithCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellationReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Platform Provider
// ---------------------------------------------------------------------------

interface PlatformClient {
  _fetchWithErrorHandling(url: string, init: RequestInit): Promise<unknown>;
  add(
    messages: Array<{ role: string; content: string }>,
    opts: Record<string, unknown>,
  ): Promise<unknown>;
  search(query: string, opts: Record<string, unknown>): Promise<unknown>;
  getAll(opts: Record<string, unknown>): Promise<unknown>;
  delete(memoryId: string): Promise<unknown>;
}

class PlatformProvider implements Mem0Provider {
  private client: PlatformClient | undefined;
  private initPromise: Promise<void> | null = null;
  private readonly requestSignal = new AsyncLocalStorage<AbortSignal>();

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
    // mem0ai does not expose RequestInit on its public methods, but its fetch
    // helper is intentionally an instance method. Add the per-call signal at
    // that boundary; AsyncLocalStorage keeps concurrent requests isolated.
    const client = new MemoryClient(opts as never) as unknown as PlatformClient;
    const originalFetch = client._fetchWithErrorHandling.bind(client);
    client._fetchWithErrorHandling = (url: string, init: RequestInit = {}) => {
      const signal = this.requestSignal.getStore();
      return originalFetch(url, signal ? { ...init, signal } : init);
    };
    this.client = client;
  }

  private runWithSignal<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return signal ? this.requestSignal.run(signal, operation) : operation();
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: Mem0AddOptions,
  ): Promise<AddResult | null> {
    await waitWithCancellation(this.ensureClient(), opts.signal);
    const addOpts: Record<string, unknown> = {
      userId: opts.userId,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    };
    if (opts.infer === false) addOpts.infer = false;
    // Platform mem0 exposes a `timestamp` field on add(); pass observedAt
    // through as an ISO string. (OSS mode honors observedAt via prompt
    // rewriting instead — see OSSProvider.add.)
    if (opts.observedAt) {
      const d = new Date(opts.observedAt);
      if (!Number.isNaN(d.getTime())) addOpts.timestamp = d.toISOString();
    }
    const result = await waitWithCancellation(
      this.runWithSignal(opts.signal, () => this.client!.add(messages, addOpts)),
      opts.signal,
    );
    return result as AddResult;
  }

  async search(query: string, opts: Mem0SearchOptions): Promise<MemoryItem[]> {
    await waitWithCancellation(this.ensureClient(), opts.signal);
    const filters = opts.agentId
      ? { OR: [{ user_id: opts.userId }, { agent_id: opts.agentId }] }
      : { user_id: opts.userId };
    const searchOpts: Record<string, unknown> = { filters };
    if (opts.topK) searchOpts.topK = opts.topK;
    const results = await waitWithCancellation(
      this.runWithSignal(opts.signal, () => this.client!.search(query, searchOpts)),
      opts.signal,
    );
    return normalizeResults(results);
  }

  async getAll(opts: Mem0ScopeOptions): Promise<MemoryItem[]> {
    await waitWithCancellation(this.ensureClient(), opts.signal);
    const filters = opts.agentId
      ? { OR: [{ user_id: opts.userId }, { agent_id: opts.agentId }] }
      : { user_id: opts.userId };
    const results = await waitWithCancellation(
      this.runWithSignal(opts.signal, () =>
        this.client!.getAll({
          filters,
        }),
      ),
      opts.signal,
    );
    return normalizeResults(results);
  }

  async getDedupGroups(opts: Mem0ScopeOptions): Promise<MemoryItem[][]> {
    const groups = [await this.getAllPages({ user_id: opts.userId }, opts.signal)];
    if (opts.agentId) {
      groups.push(await this.getAllPages({ agent_id: opts.agentId }, opts.signal));
    }
    return groups;
  }

  private async getAllPages(
    filters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<MemoryItem[]> {
    await waitWithCancellation(this.ensureClient(), signal);
    const memories: MemoryItem[] = [];
    let expectedCount: number | undefined;
    for (let page = 1; ; page++) {
      const result = await waitWithCancellation(
        this.runWithSignal(signal, () =>
          this.client!.getAll({ filters, page, pageSize: DEDUP_PAGE_SIZE }),
        ),
        signal,
      );
      const count = result && typeof result === 'object' && 'count' in result ? result.count : null;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        throw new Error('Mem0 dedup pagination returned an invalid count.');
      }
      if (count > MAX_DEDUP_ITEMS_PER_SCOPE) {
        throw new Error(`Mem0 dedup scope exceeds ${MAX_DEDUP_ITEMS_PER_SCOPE} memories.`);
      }
      if (expectedCount !== undefined && count !== expectedCount) {
        throw new Error('Mem0 dedup pagination count changed between pages.');
      }
      expectedCount = count;
      const pageMemories = normalizeResults(result);
      memories.push(...pageMemories);
      if (memories.length > MAX_DEDUP_ITEMS_PER_SCOPE) {
        throw new Error(`Mem0 dedup scope exceeds ${MAX_DEDUP_ITEMS_PER_SCOPE} memories.`);
      }
      const hasNext = Boolean(
        result && typeof result === 'object' && 'next' in result && result.next,
      );
      if (!hasNext) {
        if (expectedCount !== undefined && memories.length !== expectedCount) {
          throw new Error('Mem0 dedup pagination count does not match the returned memories.');
        }
        break;
      }
      if (pageMemories.length === 0) {
        throw new Error('Mem0 dedup pagination returned an empty page with a next link.');
      }
      if (page >= MAX_DEDUP_PAGES) {
        throw new Error(`Mem0 dedup pagination exceeds ${MAX_DEDUP_PAGES} pages.`);
      }
    }
    return memories;
  }

  async delete(memoryId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await waitWithCancellation(this.ensureClient(), opts?.signal);
    await waitWithCancellation(
      this.runWithSignal(opts?.signal, () => this.client!.delete(memoryId)),
      opts?.signal,
    );
  }
}

// Self-Hosted Provider
// ---------------------------------------------------------------------------

class SelfHostedProvider implements Mem0Provider {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
    private readonly requestTimeoutMs = 30_000,
  ) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('Self-hosted requestTimeoutMs must be a positive number.');
    }
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Self-hosted mode requires an HTTP(S) baseUrl.');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  private async request(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal });
    } catch {
      if (callerSignal?.aborted) {
        throw callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new Error('Mem0 request cancelled.');
      }
      if (timeoutSignal.aborted) throw new Error('Mem0 request timed out.');
      throw new Error('Mem0 request failed.');
    }
    if (!response.ok) throw new Error(`Mem0 request failed (${response.status}).`);
    try {
      return await response.json();
    } catch {
      if (callerSignal?.aborted) throw cancellationReason(callerSignal);
      if (timeoutSignal.aborted) throw new Error('Mem0 request timed out.');
      throw new Error('Mem0 returned an invalid response.');
    }
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: Mem0AddOptions,
  ): Promise<AddResult | null> {
    return (await this.request(
      '/memories',
      {
        method: 'POST',
        body: JSON.stringify({
          messages,
          user_id: opts.userId,
          ...(opts.agentId ? { agent_id: opts.agentId } : {}),
          ...(opts.infer === undefined ? {} : { infer: opts.infer }),
        }),
      },
      opts.signal,
    )) as AddResult;
  }

  async search(query: string, opts: Mem0SearchOptions): Promise<MemoryItem[]> {
    const result = await this.request(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          query,
          filters: {
            user_id: opts.userId,
            ...(opts.agentId ? { agent_id: opts.agentId } : {}),
          },
          ...(opts.topK === undefined ? {} : { top_k: opts.topK }),
        }),
      },
      opts.signal,
    );
    return normalizeResults(result);
  }

  async getAll(opts: Mem0ScopeOptions): Promise<MemoryItem[]> {
    const params = new URLSearchParams({ user_id: opts.userId });
    if (opts.agentId) params.set('agent_id', opts.agentId);
    const result = await this.request(`/memories?${params}`, { method: 'GET' }, opts.signal);
    return normalizeResults(result);
  }

  async getDedupGroups(opts: Mem0ScopeOptions): Promise<MemoryItem[][]> {
    const params = new URLSearchParams({ user_id: opts.userId });
    if (opts.agentId) params.set('agent_id', opts.agentId);
    params.set('top_k', String(SELF_HOSTED_DEDUP_LIMIT));
    const result = await this.request(`/memories?${params}`, { method: 'GET' }, opts.signal);
    const memories = normalizeResults(result);
    if (memories.length >= SELF_HOSTED_DEDUP_LIMIT) {
      throw new Error(
        `Mem0 self-hosted dedup scope may exceed ${SELF_HOSTED_DEDUP_LIMIT - 1} memories.`,
      );
    }
    return [memories];
  }

  async delete(memoryId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.request(
      `/memories/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' },
      opts?.signal,
    );
  }
}

// Embedded Provider
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
  /**
   * mem0's Memory instance shares one LLM object across all add() calls. To
   * honor observedAt we temporarily wrap `llm.generateResponse` (see add), and
   * that wrapper is global state on the instance — so concurrent add()s would
   * stomp each other's date. This mutex serializes the wrap/call/restore
   * window.
   *
   * ponytail: global mutex around the ~3-10s window that includes mem0's LLM
   * call. Callers expecting true concurrency across users will see add()s
   * serialize when observedAt is passed. Acceptable — the alternative is one
   * Memory instance per userId (heavy init).
   */
  private addMutex: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ossConfig: Mem0ExtensionConfig['oss'] | undefined,
    private readonly resolveKey?: KeyResolver,
    private readonly resolveProvider?: ProviderResolver,
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

    if (this.ossConfig?.customInstructions) {
      config.customInstructions = this.ossConfig.customInstructions;
    }

    const defaultVectorConfig = {
      collectionName: 'pi_mem0',
      dbPath: join(resolveHome(), 'memories', 'mem0-vectors.db'),
    };
    if (this.ossConfig?.vectorStore?.provider.toLowerCase() === 'memory') {
      config.vectorStore = {
        provider: this.ossConfig.vectorStore.provider,
        config: {
          ...defaultVectorConfig,
          ...(this.ossConfig.vectorStore.config ?? {}),
        },
      };
    } else if (this.ossConfig?.vectorStore) {
      config.vectorStore = this.ossConfig.vectorStore;
    } else {
      config.vectorStore = {
        provider: 'memory',
        config: defaultVectorConfig,
      };
    }

    if (this.ossConfig?.historyStore) {
      config.historyStore = this.ossConfig.historyStore;
    } else {
      config.historyStore = {
        provider: 'sqlite',
        config: {
          historyDbPath:
            this.ossConfig?.historyDbPath ?? join(resolveHome(), 'memories', 'mem0-history.db'),
        },
      };
    }

    if (this.ossConfig?.historyDbPath) {
      config.historyDbPath = this.ossConfig.historyDbPath;
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

    await mem.getAll({ filters: { user_id: '__warmup__' } });
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: Mem0AddOptions,
  ): Promise<AddResult | null> {
    await waitWithCancellation(this.ensureMemory(), opts.signal);
    const addOpts: Record<string, unknown> = {
      userId: opts.userId,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    };
    if (opts.infer === false) addOpts.infer = false;

    // Serialize add() when observedAt is used. mem0 never exposes the
    // observationDate parameter its own prompt documents — so we intercept
    // `this.llm.generateResponse` and rewrite the "## Observation Date" line
    // in the user prompt from today to the caller-supplied date. Parallel
    // adds would stomp the wrapper, so we mutex.
    const gate = this.addMutex;
    let release: (v: unknown) => void = () => {};
    this.addMutex = new Promise((res) => {
      release = res;
    });
    let operation: Promise<AddResult> | undefined;
    let restoreLlm: (() => void) | undefined;
    try {
      await waitWithCancellation(gate, opts.signal);
      // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
      const mem = this.memory as any;
      if (opts.observedAt) {
        const dateStr = formatObservedAt(opts.observedAt);
        const llm = mem.llm;
        const originalGenerate = llm.generateResponse.bind(llm);
        llm.generateResponse = async (
          msgs: Array<{ role: string; content: string }>,
          ...rest: unknown[]
        ) => {
          const patched = msgs.map((m) =>
            m.role === 'user' && typeof m.content === 'string'
              ? { ...m, content: rewriteObservationDate(m.content, dateStr) }
              : m,
          );
          return originalGenerate(patched, ...rest);
        };
        restoreLlm = () => {
          llm.generateResponse = originalGenerate;
        };
      }
      operation = Promise.resolve(mem.add(messages, addOpts)).finally(() => restoreLlm?.());
      void operation.then(
        () => release(undefined),
        () => release(undefined),
      );
      return await waitWithCancellation(operation, opts.signal);
    } finally {
      if (!operation) {
        restoreLlm?.();
        void gate.then(
          () => release(undefined),
          () => release(undefined),
        );
      }
    }
  }

  async search(query: string, opts: Mem0SearchOptions): Promise<MemoryItem[]> {
    await waitWithCancellation(this.ensureMemory(), opts.signal);
    const searchOpts: Record<string, unknown> = {
      filters: {
        user_id: opts.userId,
        ...(opts.agentId ? { agent_id: opts.agentId } : {}),
      },
    };
    if (opts.topK) searchOpts.topK = opts.topK;
    const results = await waitWithCancellation(
      // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
      (this.memory as any).search(query, searchOpts),
      opts.signal,
    );
    return normalizeResults(results);
  }

  async getAll(opts: Mem0ScopeOptions): Promise<MemoryItem[]> {
    await waitWithCancellation(this.ensureMemory(), opts.signal);
    const results = await waitWithCancellation(
      // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
      (this.memory as any).getAll({
        filters: {
          user_id: opts.userId,
          ...(opts.agentId ? { agent_id: opts.agentId } : {}),
        },
      }),
      opts.signal,
    );
    return normalizeResults(results);
  }

  async getDedupGroups(opts: Mem0ScopeOptions): Promise<MemoryItem[][]> {
    await waitWithCancellation(this.ensureMemory(), opts.signal);
    const results = await waitWithCancellation(
      // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
      (this.memory as any).getAll({
        filters: {
          user_id: opts.userId,
          ...(opts.agentId ? { agent_id: opts.agentId } : {}),
        },
        topK: MAX_DEDUP_ITEMS_PER_SCOPE + 1,
      }),
      opts.signal,
    );
    const memories = normalizeResults(results);
    if (memories.length > MAX_DEDUP_ITEMS_PER_SCOPE) {
      throw new Error(`Mem0 dedup scope exceeds ${MAX_DEDUP_ITEMS_PER_SCOPE} memories.`);
    }
    return [memories];
  }

  async delete(memoryId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await waitWithCancellation(this.ensureMemory(), opts?.signal);
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    await waitWithCancellation((this.memory as any).delete(memoryId), opts?.signal);
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
  const mode = normalizeMem0Mode(config.mode);

  if (mode === 'embedded') {
    const useRegistry = config.useRegistryKeys !== false;
    const provider = new OSSProvider(
      config.oss,
      useRegistry ? resolveKey : undefined,
      useRegistry ? resolveProvider : undefined,
    );
    // biome-ignore lint/suspicious/noExplicitAny: mem0ai/oss lacks type definitions
    await (provider as any).ensureMemory();
    return provider;
  }

  if (mode === 'self-hosted') {
    if (!config.baseUrl?.trim()) throw new Error('Self-hosted mode requires baseUrl.');
    return new SelfHostedProvider(
      config.baseUrl.trim(),
      config.apiKey?.trim() || undefined,
      config.requestTimeoutMs,
    );
  }

  if (!config.apiKey?.trim()) {
    throw new Error('Platform mode requires apiKey.');
  }
  return new PlatformProvider(config.apiKey.trim(), config.baseUrl?.trim());
}
