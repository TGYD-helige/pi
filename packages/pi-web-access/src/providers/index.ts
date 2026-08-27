import type { BuiltInProviderId } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import type { WebProvider } from './base.js';
import { BraveProvider } from './brave.js';
import { DashscopeProvider } from './dashscope.js';
import { FirecrawlProvider } from './firecrawl.js';
import { GeminiProvider } from './gemini.js';
import { KimiProvider } from './kimi.js';
import { MimoProvider } from './mimo.js';
import { OpenAIProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import { ParallelProvider } from './parallel.js';
import { PerplexityProvider } from './perplexity.js';
import { TavilyProvider } from './tavily.js';
import { UnsplashProvider } from './unsplash.js';
import { XaiProvider } from './xai.js';
import { ZaiProvider } from './zai.js';

export type {
  FetchResponse,
  ImageSearchParams,
  ResolvedProvider,
  SearchParams,
  SearchResponse,
  SearchResult,
  WebProvider,
} from './base.js';
export { BaseProvider, getEnvironmentContext, SEARCH_SYSTEM_PROMPT } from './base.js';

// ─── Registry ────────────────────────────────────────────────────────────────

const providers: WebProvider[] = [
  new ParallelProvider(),
  new TavilyProvider(),
  new BraveProvider(),
  new FirecrawlProvider(),
  new KimiProvider(),
  new MimoProvider(),
  new ZaiProvider(),
  new GeminiProvider(),
  new PerplexityProvider(),
  new OpenRouterProvider(),
  new XaiProvider(),
  new OpenAIProvider(),
  new OpenAIProvider('deepseek'),
  new AnthropicProvider(),
  new DashscopeProvider(),
  new UnsplashProvider(),
];

const registry = new Map<string, WebProvider>(providers.map((p) => [p.id, p]));

export function getProvider(id: BuiltInProviderId): WebProvider | undefined {
  return registry.get(id);
}
