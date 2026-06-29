/**
 * Configuration types for pi-memory-mem0.
 */

export type Mem0Mode = 'platform' | 'open-source';

export interface Mem0ExtensionConfig {
  /** "platform" (Mem0 Cloud) or "open-source" (local SQLite). Default: "platform". */
  mode?: Mem0Mode;

  // ── Platform mode ───────────────────────────────────────────────────────
  /** Mem0 Platform API key. Supports ${MEM0_API_KEY}. */
  apiKey?: string;
  /** Custom API base URL. Default: https://api.mem0.ai */
  baseUrl?: string;

  // ── Open-source mode ────────────────────────────────────────────────────
  oss?: {
    embedder?: { provider: string; config?: Record<string, unknown> };
    llm?: { provider: string; config?: Record<string, unknown> };
    vectorStore?: { provider: string; config?: Record<string, unknown> };
    /** Path to SQLite file for memory snapshot persistence. Default: <home>/memories/mem0-snapshot.db */
    snapshotDbPath?: string;
    disableHistory?: boolean;
  };

  // ── Shared ──────────────────────────────────────────────────────────────
  /** User identifier for memory scoping. Supports ${USER}. */
  userId?: string;
  /** Agent identifier for memory isolation. When set, memories are scoped to this agent. */
  agentId?: string;
  /** Max recalled memories per turn. Default: 5 */
  topK?: number;

  /**
   * When true (default), OSS mode will attempt to resolve API keys from
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
