import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { type TSchema, Type } from 'typebox';
import {
  loadWebToolSettings,
  resolveImageSearchProvider,
  resolveProvider,
  resolveSearchProvider,
} from './config.js';
import { webFetch } from './fetch.js';
import type { ImageSearchParams, SearchParams, SearchResponse } from './providers/index.js';
import { getProvider } from './providers/index.js';
import type { XaiProvider } from './providers/xai.js';
import { search } from './search.js';
import { summarizeContent } from './summary.js';
import {
  boundText,
  fetchOutput,
  fetchOutputSchema,
  searchOutput,
  searchOutputSchema,
} from './tool-output.js';
import type { WebToolSettings } from './types.js';

export {
  loadWebToolSettings,
  resolveFetchProvider,
  resolveImageSearchProvider,
  resolveProvider,
  resolveSearchProvider,
} from './config.js';
export { type WebFetchParams, type WebFetchResponse, webFetch } from './fetch.js';
export {
  type FetchResponse,
  getProvider,
  type ImageSearchParams,
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

function formatImageSearch(response: SearchResponse): string {
  const lines: string[] = [];
  lines.push(`## Image Search Results (${response.provider})`);
  lines.push(`**Query:** ${response.query}`);
  lines.push('');

  if (response.answer) {
    lines.push('### Answer');
    lines.push(response.answer);
    lines.push('');
  }

  if (response.results.length > 0) {
    lines.push('### Images');
    for (const r of response.results) {
      lines.push(`- [${r.title}](${r.url})`);
      if (r.content) lines.push(`  ${r.content}`);
    }
    lines.push('');
  }

  if (!response.answer && response.results.length === 0) {
    lines.push('No images returned by the provider. Consider rephrasing the query.');
    lines.push('');
  }

  return lines.join('\n');
}

export default function piWebToolExtension(pi: ExtensionAPI): void {
  let settings: WebToolSettings = {};
  const registerTool = <P extends TSchema>(tool: ToolDefinition<P>) =>
    pi.registerTool({
      ...tool,
      async execute(...args) {
        try {
          return await tool.execute(...args);
        } catch (error) {
          if (args[2]?.aborted) throw error;
          const status = (error instanceof Error ? error.message : '').match(
            /(?:^|HTTP[ :]+)([45]\d{2})\b/,
          )?.[1];
          const message = `${tool.name} failed${status ? ` (HTTP ${status})` : ''}. Check the provider configuration and retry.`;
          console.error(`[pi-web-access] ${message}`);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
            details: undefined,
            structuredContent: { error: message },
          };
        }
      },
    });

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    settings = loadWebToolSettings(ctx.cwd, isProjectTrusted(ctx));

    const searchResolved = resolveSearchProvider(settings);
    const hasSearch =
      !('error' in searchResolved) &&
      (Boolean(searchResolved.apiKey) ||
        (searchResolved.id === 'parallel' && settings.search?.provider === 'parallel'));
    const hasFetch = Boolean(settings.fetch?.provider) || Boolean(settings.fetch?.summary);

    if (hasSearch) {
      const runSearch = async (searchParams: SearchParams, signal?: AbortSignal) => {
        const response = searchOutput(await search(searchParams, settings, signal));
        const lines: string[] = [];
        lines.push(`## Web Search Results (${response.provider})`);
        lines.push(`**Query:** ${response.query}`);
        lines.push('');

        if (response.answer) {
          lines.push('### Answer');
          lines.push(response.answer);
          lines.push('');
        } else if (response.results.length > 0) {
          lines.push(
            '_The provider did not generate an answer. Sources gathered during the search are listed below._',
          );
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

        if (!response.answer && response.results.length === 0) {
          lines.push('No results returned by the provider. Consider rephrasing the query.');
          lines.push('');
        }

        if (response.truncated)
          lines.unshift('[Result truncated: some source metadata or text was omitted.]');
        const text = boundText(lines.join('\n'));
        return {
          content: [{ type: 'text' as const, text }],
          details: undefined,
          structuredContent: response,
        };
      };

      registerTool({
        name: 'web_search',
        outputSchema: searchOutputSchema,
        label: 'WebSearch',
        promptSnippet: 'Search the web for current information and source URLs.',
        promptGuidelines: [
          'Use web_search for current information; cite relevant source URLs in the answer.',
        ],
        description: [
          '- Searches the web and returns results to inform responses',
          '- Provides up-to-date information for current events and recent data',
          '- Returns search results with titles, URLs, and content snippets, or a synthesized answer',
          '- Use this tool for accessing information beyond your knowledge cutoff',
          ...(searchResolved.id === 'deepseek'
            ? [
                '- DeepSeek queries, including domain and date filters, must fit within 128 Unicode characters. Returns sources without a synthesized answer; topic is ignored.',
              ]
            : []),
          ...(searchResolved.id === 'cloudflare'
            ? [
                '- Cloudflare returns at most 10 results and ignores topic, timeRange, includeDomains, and excludeDomains.',
              ]
            : []),
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
          signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          return runSearch(params as unknown as SearchParams, signal);
        },
      });
      pi.registerCommand('web-search', {
        description: 'Search the web. Usage: /web-search <query>',
        async handler(args, cmdCtx) {
          const query = args.trim();
          if (!query) {
            cmdCtx.ui.notify('Usage: /web-search <query>', 'warning');
            return;
          }
          try {
            const result = await runSearch({ query }, cmdCtx.signal);
            cmdCtx.ui.notify(result.content[0]!.text, 'info');
          } catch {
            console.error('[pi-web-access] web-search command failed');
            cmdCtx.ui.notify(
              'Web search failed. Check the provider configuration and try again.',
              'error',
            );
          }
        },
      });
    }

    if (hasFetch) {
      const runFetch = async (
        fetchParams: { url: string; prompt: string },
        fetchCtx: ExtensionContext,
        signal?: AbortSignal,
      ) => {
        const result = await webFetch({ url: fetchParams.url }, settings, undefined, signal);

        let content = result.content;
        if (settings.fetch?.summary) {
          content = await summarizeContent(
            content,
            fetchParams.prompt,
            settings.fetch.summary,
            fetchCtx,
            signal,
          );
        }

        const lines: string[] = [];
        lines.push(`## ${result.title}`);
        lines.push(`**Source:** ${result.url}`);
        lines.push('');
        lines.push(content);

        const structuredContent = fetchOutput({ ...result, content });
        if (structuredContent.truncated)
          lines.unshift(
            '[Partial page: some content was omitted. Use focused search or a browser to inspect missing sections; avoid repeating the same full-page fetch.]',
          );
        const text = boundText(lines.join('\n'));
        return {
          content: [{ type: 'text' as const, text }],
          details: undefined,
          structuredContent,
        };
      };

      registerTool({
        name: 'web_fetch',
        outputSchema: fetchOutputSchema,
        label: 'WebFetch',
        description: [
          'Retrieve content from a public HTTP(S) URL.',
          settings.fetch?.summary
            ? 'The configured summary model extracts or summarizes the fetched content according to prompt; returns its response.'
            : 'Returns fetched content directly; prompt is not applied because no summary model is configured. Analyze the returned content yourself.',
          'Loopback, private, link-local, metadata, credentialed, and unsafe redirect destinations are rejected.',
          'Truncated results are partial evidence. Use focused web_search or a browser on the source URL to retrieve missing sections; do not assume omitted information is absent.',
        ].join('\n'),
        parameters: Type.Object({
          url: Type.String({ description: 'The public HTTP(S) URL to fetch content from.' }),
          prompt: Type.String({
            description:
              'Extraction instructions for the configured summary model. Required for compatibility; ignored when summary is disabled.',
          }),
        }),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          _onUpdate: unknown,
          fetchCtx: ExtensionContext,
        ) {
          return runFetch(params as unknown as { url: string; prompt: string }, fetchCtx, signal);
        },
      });
      pi.registerCommand('web-fetch', {
        description: 'Fetch a public URL: /web-fetch <url> [extraction instructions]',
        async handler(args, cmdCtx) {
          const [url, ...instructions] = args.trim().split(/\s+/);
          if (!url) {
            cmdCtx.ui.notify('Usage: /web-fetch <url> [extraction instructions]', 'warning');
            return;
          }
          try {
            const result = await runFetch(
              { url, prompt: instructions.join(' ') || 'Summarize this page.' },
              cmdCtx,
              cmdCtx.signal,
            );
            cmdCtx.ui.notify(result.content[0]!.text, 'info');
          } catch {
            console.error('[pi-web-access] web-fetch command failed');
            cmdCtx.ui.notify(
              'Web fetch failed. Check the URL and provider configuration.',
              'error',
            );
          }
        },
      });
    }

    // x_search: only register when xai provider has an API key
    const xaiResolved = resolveProvider('xai', settings);
    const hasXai = !('error' in xaiResolved) && Boolean(xaiResolved.apiKey);
    if (hasXai) {
      registerTool({
        name: 'x_search',
        outputSchema: searchOutputSchema,
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
          signal: AbortSignal | undefined,
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
          const response = searchOutput(await xaiProvider.xsearch(xParams, xaiResolved, signal));

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

          if (response.truncated)
            lines.unshift('[Result truncated: some source metadata or text was omitted.]');
          const text = boundText(lines.join('\n'));
          return {
            content: [{ type: 'text' as const, text }],
            details: undefined,
            structuredContent: response,
          };
        },
      });
    }

    // image_search: registered when an image search provider (dashscope, unsplash) has an API key
    const imageSearchResolved = resolveImageSearchProvider(settings);
    const hasImageSearch = !('error' in imageSearchResolved) && Boolean(imageSearchResolved.apiKey);
    if (hasImageSearch) {
      const runImageSearch = async (query: string, signal?: AbortSignal) => {
        const provider = getProvider(imageSearchResolved.id);
        if (!provider) {
          throw new Error(`Provider "${imageSearchResolved.id}" is not registered.`);
        }
        const response = searchOutput(
          await provider.imageSearch({ query }, imageSearchResolved, signal),
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: boundText(
                `${response.truncated ? '[Result truncated]\n' : ''}${formatImageSearch(response)}`,
              ),
            },
          ],
          details: undefined,
          structuredContent: response,
        };
      };

      registerTool({
        name: 'image_search',
        outputSchema: searchOutputSchema,
        label: 'ImageSearch',
        description: [
          '- Searches the web for images matching a text description',
          '- Returns matching image titles and URLs',
          '- Use this tool when you need to find images, photos, illustrations, or other visual assets',
        ].join('\n'),
        parameters: Type.Object({
          query: Type.String({ description: 'Description of the images to search for.' }),
        }),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          const imageParams = params as unknown as ImageSearchParams;
          return runImageSearch(imageParams.query, signal);
        },
      });

      pi.registerCommand('image-search', {
        description: 'Search the web for images. Usage: /image-search <query>',
        async handler(args, cmdCtx) {
          const query = args.trim();
          if (!query) {
            cmdCtx.ui.notify('Usage: /image-search <query>', 'warning');
            return;
          }
          try {
            cmdCtx.ui.notify((await runImageSearch(query, cmdCtx.signal)).content[0]!.text, 'info');
          } catch {
            const message = 'image-search failed. Check the provider configuration and retry.';
            console.error(`[pi-web-access] ${message}`);
            cmdCtx.ui.notify(message, 'error');
          }
        },
      });
    }
  });
}
