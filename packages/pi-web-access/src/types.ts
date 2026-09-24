/** Built-in provider identifiers. */
export type BuiltInProviderId =
  | 'parallel'
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
  | 'anthropic'
  | 'dashscope'
  | 'unsplash'
  | 'you';

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
  provider?: BuiltInProviderId;
  summary?: SummaryModelConfig;
  /** Read the destination itself instead of the default Jina Reader fallback. */
  mode?: 'direct';
  /** Use public DNS answers when the system resolver returns proxy fake IPs. */
  dnsOverHttps?: 'google';
}

export interface ImageSearchConfig {
  provider?: BuiltInProviderId;
}

export interface WebToolSettings {
  /** Request timeout in milliseconds (default varies by provider: 30s-5min). */
  timeoutMs?: number;
  /** Search tool config. */
  search?: SearchConfig;
  /** Fetch tool config. */
  fetch?: FetchConfig;
  /** Image search tool config. */
  imageSearch?: ImageSearchConfig;
  /** Per-provider config. */
  providers?: Partial<Record<BuiltInProviderId, ProviderConfig>>;
}
