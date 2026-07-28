import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadWebToolSettings } from './config.js';
import { webFetch } from './fetch.js';
import type { SearchParams } from './providers/index.js';
import { getProvider } from './providers/index.js';
import type { XaiProvider } from './providers/xai.js';
import {
  resolveFetchProviderForSession,
  resolveProviderForSession,
  resolveSearchProviderForSession,
} from './runtime-auth.js';
import { search } from './search.js';
import { summarizeContent } from './summary.js';
import type { WebToolSettings } from './types.js';

export {
  loadWebToolSettings,
  resolveFetchProvider,
  resolveProvider,
  resolveSearchProvider,
} from './config.js';
export { type WebFetchParams, type WebFetchResponse, webFetch } from './fetch.js';
export {
  type FetchResponse,
  getProvider,
  type ResolvedProvider,
  type SearchParams,
  type SearchResponse,
  type SearchResult,
  type WebProvider,
} from './providers/index.js';
export { search } from './search.js';
export type {
  ProviderConfig,
  WebToolSettings,
} from './types.js';

export default function piWebToolExtension(pi: ExtensionAPI): void {
  let settings: WebToolSettings = {};

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    settings = loadWebToolSettings(ctx.cwd, isProjectTrusted(ctx));

    const searchResolved = await resolveSearchProviderForSession(settings, ctx.modelRegistry);
    const hasSearch = !('error' in searchResolved) && Boolean(searchResolved.apiKey);
    const fetchResolved = await resolveFetchProviderForSession(settings, ctx.modelRegistry);
    const fetchRuntimeProvider = settings.fetch?.provider
      ? settings.providers?.[settings.fetch.provider]?.runtimeAuthProvider
      : undefined;
    const hasFetch = fetchRuntimeProvider
      ? fetchResolved !== null && !('error' in fetchResolved) && Boolean(fetchResolved.apiKey)
      : Boolean(settings.fetch?.provider) || Boolean(settings.fetch?.summary);

    if (hasSearch) {
      pi.registerTool({
        name: 'web_search',
        label: 'WebSearch',
        description: [
          '- Searches the web and returns results to inform responses',
          '- Provides up-to-date information for current events and recent data',
          '- Returns search results with titles, URLs, and content snippets, or a synthesized answer',
          '- Use this tool for accessing information beyond your knowledge cutoff',
          '',
          'After answering, include a "Sources:" section listing relevant URLs as markdown hyperlinks.',
        ].join('\n'),
        parameters: Type.Object({
          query: Type.String({ description: 'The search query to execute.' }),
          maxResults: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: 20,
              description: 'Max results to return (default 5).',
            }),
          ),
          topic: Type.Optional(
            Type.Unsafe<'general' | 'news'>({
              type: 'string',
              enum: ['general', 'news'],
              description: 'Topic category. Must be one of: "general", "news".',
            }),
          ),
          timeRange: Type.Optional(
            Type.Unsafe<'day' | 'week' | 'month' | 'year'>({
              type: 'string',
              enum: ['day', 'week', 'month', 'year'],
              description:
                'Filter results by recency. Must be one of: "day", "week", "month", "year".',
            }),
          ),
          includeDomains: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Only include results from these domains.',
            }),
          ),
          excludeDomains: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Exclude results from these domains.',
            }),
          ),
        }),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          const searchParams = params as unknown as SearchParams;
          const response = await search(searchParams, settings, searchResolved);

          const lines: string[] = [];
          lines.push(`## Web Search Results (${response.provider})`);
          lines.push(`**Query:** ${response.query}`);
          lines.push('');

          if (response.answer) {
            lines.push('### Answer');
            lines.push(response.answer);
            lines.push('');
          }

          if (response.results.length > 0) {
            lines.push('### Sources');
            for (const r of response.results) {
              lines.push(`- [${r.title}](${r.url})`);
              if (r.score !== undefined) lines.push(`  *Relevance: ${r.score.toFixed(2)}*`);
              if (r.content) lines.push(`  ${r.content}`);
            }
            lines.push('');
          }

          const text = lines.join('\n');
          return { content: [{ type: 'text' as const, text }], details: undefined };
        },
      });
    }

    if (hasFetch) {
      pi.registerTool({
        name: 'web_fetch',
        label: 'WebFetch',
        description: [
          '- Fetches content from a specified URL and processes it using a prompt',
          '- Takes a URL and a prompt as input',
          '- Fetches the URL content, converts HTML to markdown',
          '- Processes the content with the prompt using a small, fast model',
          "- Returns the model's response about the content",
          '- Use this tool when you need to retrieve and analyze web content',
          '',
          'Usage notes:',
          '  - The URL must be a fully-formed valid URL',
          '  - The prompt should describe what information you want to extract from the page',
          '  - Results may be summarized if the content is very large',
        ].join('\n'),
        parameters: Type.Object({
          url: Type.String({ description: 'The URL to fetch content from.' }),
          prompt: Type.String({
            description:
              'The prompt describing what information to extract or summarize from the page.',
          }),
        }),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          fetchCtx: ExtensionContext,
        ) {
          const fetchParams = params as unknown as { url: string; prompt: string };
          const result = await webFetch(
            { url: fetchParams.url },
            settings,
            fetchResolved && !('error' in fetchResolved) ? fetchResolved : null,
          );

          let content = result.content;
          if (settings.fetch?.summary) {
            content = await summarizeContent(
              content,
              fetchParams.prompt,
              settings.fetch.summary,
              fetchCtx,
            );
          }

          const lines: string[] = [];
          lines.push(`## ${result.title}`);
          lines.push(`**Source:** ${result.url}`);
          lines.push('');
          lines.push(content);

          const text = lines.join('\n');
          return { content: [{ type: 'text' as const, text }], details: undefined };
        },
      });
    }

    // x_search: only register when xai provider has an API key
    const xaiResolved = await resolveProviderForSession('xai', settings, ctx.modelRegistry);
    const hasXai = !('error' in xaiResolved) && Boolean(xaiResolved.apiKey);
    if (hasXai) {
      pi.registerTool({
        name: 'x_search',
        label: 'XSearch',
        description: [
          '- Searches X (Twitter) for posts, threads, and social media content',
          '- Returns real-time social media insights with citations',
          '- Supports filtering by X handles and date ranges',
          '- Use this tool when you need information from X/Twitter specifically',
        ].join('\n'),
        parameters: Type.Object({
          query: Type.String({ description: 'The search query to execute on X.' }),
          allowedHandles: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Only include posts from these X handles (max 20).',
            }),
          ),
          excludedHandles: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Exclude posts from these X handles (max 20).',
            }),
          ),
          fromDate: Type.Optional(Type.String({ description: 'Start date in YYYY-MM-DD format.' })),
          toDate: Type.Optional(Type.String({ description: 'End date in YYYY-MM-DD format.' })),
        }),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          const xaiProvider = getProvider('xai') as XaiProvider;
          const xParams = params as unknown as {
            query: string;
            allowedHandles?: string[];
            excludedHandles?: string[];
            fromDate?: string;
            toDate?: string;
          };
          const response = await xaiProvider.xsearch(xParams, xaiResolved);

          const lines: string[] = [];
          lines.push(`## X Search Results`);
          lines.push(`**Query:** ${response.query}`);
          lines.push('');

          if (response.answer) {
            lines.push('### Answer');
            lines.push(response.answer);
            lines.push('');
          }

          if (response.results.length > 0) {
            lines.push('### Sources');
            for (const r of response.results) {
              lines.push(`- [${r.title}](${r.url})`);
              if (r.content) lines.push(`  ${r.content}`);
            }
            lines.push('');
          }

          const text = lines.join('\n');
          return { content: [{ type: 'text' as const, text }], details: undefined };
        },
      });
    }
  });
}
