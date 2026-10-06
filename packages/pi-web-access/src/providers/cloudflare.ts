import { truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';
import type { ResolvedProvider, SearchParams, SearchResponse } from './base.js';
import { BaseProvider, timeoutSignal } from './base.js';

export class CloudflareProvider extends BaseProvider {
  readonly id = 'cloudflare' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (typeof provider.apiKey !== 'string' || !provider.apiKey.trim()) {
      throw new Error(
        'Cloudflare API token not configured. Set CLOUDFLARE_API_TOKEN or providers.cloudflare.apiKey.',
      );
    }
    if (typeof provider.accountId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(provider.accountId)) {
      throw new Error(
        'Cloudflare account ID missing or invalid. Set CLOUDFLARE_ACCOUNT_ID or providers.cloudflare.accountId.',
      );
    }
    if (
      typeof params.query !== 'string' ||
      !params.query.trim() ||
      [...params.query].length > 1024
    ) {
      throw new Error('Cloudflare search query must contain 1–1024 characters.');
    }
    const maxResults = params.maxResults ?? 5;
    if (!Number.isInteger(maxResults) || maxResults < 1) {
      throw new Error('Cloudflare maxResults must be a positive integer.');
    }
    const limit = Math.min(maxResults, 10);
    const searchProvider = provider.searchProvider ?? 'ceramic';
    if (!['ceramic', 'exa', 'linkup'].includes(searchProvider)) {
      throw new Error('Cloudflare searchProvider must be ceramic, exa, or linkup.');
    }
    const gatewayId = provider.gatewayId ?? 'default';
    if (typeof gatewayId !== 'string' || !gatewayId.trim())
      throw new Error('Cloudflare gatewayId must not be empty.');
    if (
      provider.byokAlias !== undefined &&
      (typeof provider.byokAlias !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(provider.byokAlias))
    ) {
      throw new Error(
        'Cloudflare byokAlias must contain 1–64 letters, digits, underscores, or hyphens.',
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${provider.baseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(provider.accountId)}/ai/websearch/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
            ...provider.headers,
          },
          body: JSON.stringify({
            query: params.query,
            provider: searchProvider,
            limit,
            options: { gateway: { id: gatewayId } },
            ...(provider.byokAlias === undefined ? {} : { byokAlias: provider.byokAlias }),
          }),
          signal: timeoutSignal(provider.timeoutMs ?? 30_000, signal),
        },
      );
    } catch {
      console.error('[pi-web-access] Cloudflare search request failed or was cancelled');
      throw new Error('Cloudflare search request failed or was cancelled.');
    }
    if (!response.ok) {
      console.error(`[pi-web-access] Cloudflare Web Search API error (HTTP ${response.status})`);
      throw new Error(`Cloudflare Web Search API error (HTTP ${response.status}).`);
    }

    let data: {
      items?: Array<{ title: string; url: string; description?: string }>;
      success?: boolean;
      errors?: unknown[];
    };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      console.error('[pi-web-access] Cloudflare returned invalid JSON');
      throw new Error('Cloudflare returned an invalid search response.');
    }
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.success === false ||
      (Array.isArray(data.errors) && data.errors.length > 0) ||
      (data.items !== undefined &&
        (!Array.isArray(data.items) ||
          data.items.some(
            (item) =>
              !item ||
              typeof item.title !== 'string' ||
              typeof item.url !== 'string' ||
              (item.description !== undefined && typeof item.description !== 'string'),
          )))
    ) {
      console.error('[pi-web-access] Cloudflare returned an invalid search response');
      throw new Error('Cloudflare returned an invalid search response.');
    }
    return {
      provider: provider.id,
      query: params.query,
      results: (data.items ?? [])
        .slice(0, limit)
        .filter((item) => Buffer.byteLength(item.url) <= 2048 && !/[\r\n]/.test(item.url))
        .map((item) => ({
          title: truncateHead(truncateLine(item.title, 80).text, { maxBytes: 256, maxLines: 1 })
            .content,
          url: item.url,
          content: truncateHead(truncateLine(item.description ?? '', 600).text, {
            maxBytes: 2000,
            maxLines: 40,
          }).content,
        })),
    };
  }
}
