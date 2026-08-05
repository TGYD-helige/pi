/** Built-in provider identifiers. */
export type BuiltInProviderId =
  | 'tavily'
  | 'brave'
  | 'firecrawl'
  | 'kimi'
  | 'mimo'
  | 'zai'
  | 'gemini'
  | 'perplexity'
  | 'deepseek'
  | 'openrouter'
  | 'xai'
  | 'openai'
  | 'anthropic';

// ─── Settings ────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface SummaryModelConfig {
  provider: string;
  model: string;
}

export interface SearchConfig {
  provider?: BuiltInProviderId;
}

export interface FetchConfig {
  mode?: 'provider_jina_or_local' | 'local_only';
  observation?: {
    runId: string;
    retention: 'source_summary_only_v1';
  };
  provider?: BuiltInProviderId;
  summary?: SummaryModelConfig;
}

export interface WebToolSettings {
  /** Request timeout in milliseconds (default varies by provider: 30s-60s). */
  timeoutMs?: number;
  /** Search tool config. */
  search?: SearchConfig;
  /** Fetch tool config. */
  fetch?: FetchConfig;
  /** Per-provider config. */
  providers?: Partial<Record<BuiltInProviderId, ProviderConfig>>;
}
