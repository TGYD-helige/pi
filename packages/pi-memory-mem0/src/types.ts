/**
 * Configuration types for pi-memory-mem0.
 */

export type Mem0Mode = 'platform' | 'embedded' | 'self-hosted';
export type Mem0MemoryMode = 'hybrid' | 'active' | 'passive';
export type Mem0RecallMode = 'every-turn' | 'session';
export type MemoryUserIdScope = 'project' | 'exact';

export interface Mem0ExtensionConfig {
  /** Mem0 Cloud, in-process OSS, or a remote OSS server. Default: "platform". */
  mode?: Mem0Mode;

  /**
   * Memory behavior: "passive" = automatic capture + recall injection only,
   * "active" = LLM-callable mem0_memory tool only, "hybrid" = both.
   * Default: "hybrid".
   */
  memoryMode?: Mem0MemoryMode;

  // ── Remote modes ─────────────────────────────────────────────────────────
  /** Mem0 API key. Supports ${MEM0_API_KEY}. */
  apiKey?: string;
  /** Platform override or required self-hosted OSS server URL. */
  baseUrl?: string;
  /** Remote request timeout in milliseconds. Default: 30000. */
  requestTimeoutMs?: number;

  // ── Embedded mode ───────────────────────────────────────────────────────
  oss?: {
    embedder?: { provider: string; config?: Record<string, unknown> };
    llm?: { provider: string; config?: Record<string, unknown> };
    vectorStore?: { provider: string; config?: Record<string, unknown> };
    /** Mem0 OSS history store config. Default: sqlite at <home>/memories/mem0-history.db */
    historyStore?: { provider: string; config?: Record<string, unknown> };
    /** Shortcut for sqlite history DB path. Default: <home>/memories/mem0-history.db */
    historyDbPath?: string;
    disableHistory?: boolean;
  };

  // ── Shared ──────────────────────────────────────────────────────────────
  /** User identifier for memory scoping. Supports ${USER}. */
  userId?: string;
  /** Append a cwd hash (default) or use userId verbatim. */
  userIdScope?: MemoryUserIdScope;
  /** Max recalled memories per turn. Default: 5 */
  topK?: number;

  /**
   * How often to inject recalled memories into context.
   * - "every-turn" (default): recall on every agent turn, as now.
   * - "session": recall only once per session — the first turn after
   *   session start. Subsequent turns skip prefetch entirely.
   */
  recallMode?: Mem0RecallMode;

  /**
   * When true (default), embedded mode will attempt to resolve API keys from
   * pi's model registry instead of requiring separate env vars.
   * Falls back to OPENAI_API_KEY / DEEPSEEK_API_KEY env vars if registry lookup fails.
   */
  useRegistryKeys?: boolean;
}

export interface MemoryItem {
  id: string;
  memory: string;
  score?: number | undefined;
  user_id?: string | undefined;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface AddResult {
  results?: Array<{ id: string; memory: string; event: string }>;
}
