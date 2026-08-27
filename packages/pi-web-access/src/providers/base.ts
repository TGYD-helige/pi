import type { BuiltInProviderId } from '../types.js';

// ─── Shared constants for LLM-based providers ────────────────────────────────

export const SEARCH_SYSTEM_PROMPT = 'You are an assistant for performing a web search tool use';

export function getEnvironmentContext(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toISOString().split('T')[0];
  return `[Current date: ${date}, Timezone: ${tz}]`;
}

// ─── Provider contract types ─────────────────────────────────────────────────

export interface ResolvedProvider {
  id: BuiltInProviderId;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SearchParams {
  query: string;
  maxResults?: number;
  topic?: 'general' | 'news';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchResponse {
  provider: string;
  query: string;
  answer?: string | undefined;
  results: SearchResult[];
}

export interface FetchResponse {
  url: string;
  title: string;
  content: string;
}

export interface ImageSearchParams {
  query: string;
}

// ─── Provider interface & base class ─────────────────────────────────────────

export interface WebProvider {
  readonly id: BuiltInProviderId;
  search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse>;
  fetch(url: string, provider: ResolvedProvider): Promise<FetchResponse>;
  imageSearch(params: ImageSearchParams, provider: ResolvedProvider): Promise<SearchResponse>;
}

export abstract class BaseProvider implements WebProvider {
  abstract readonly id: BuiltInProviderId;

  async search(_params: SearchParams, _provider: ResolvedProvider): Promise<SearchResponse> {
    throw new Error(`${this.id} does not support web_search.`);
  }

  async fetch(_url: string, _provider: ResolvedProvider): Promise<FetchResponse> {
    throw new Error(`${this.id} does not support web_fetch.`);
  }

  async imageSearch(
    _params: ImageSearchParams,
    _provider: ResolvedProvider,
  ): Promise<SearchResponse> {
    throw new Error(`${this.id} does not support image_search.`);
  }
}
