import {
  assertPublicHttpUrl,
  type DnsLookup,
  hostFromUrl,
  readResponseBytes,
  safeFetch,
  type TrustedHosts,
} from '@amaster.ai/pi-shared';
import TurndownService from 'turndown';
import { resolveFetchProvider } from './config.js';
import { timeoutSignal } from './providers/base.js';
import type { FetchResponse } from './providers/index.js';
import { getProvider } from './providers/index.js';
import type { WebToolSettings } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const JINA_READER_BASE = 'https://r.jina.ai';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type WebFetchParams = { url: string };
export type WebFetchResponse = FetchResponse;

/** Hosts from user-configured provider baseUrls — trusted for SSRF purposes. */
function trustedHostsFromSettings(settings: WebToolSettings): TrustedHosts {
  const hosts: string[] = [];
  for (const config of Object.values(settings.providers ?? {})) {
    const host = hostFromUrl(config?.baseUrl);
    if (host) hosts.push(host);
  }
  return hosts;
}

// ─── Jina Reader (free, supports JS rendering) ──────────────────────────────

async function fetchViaJina(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const endpoint = `${JINA_READER_BASE}/${url}`;

  const response = await fetch(endpoint, {
    headers: { Accept: 'text/markdown', 'X-No-Cache': 'true' },
    signal: timeoutSignal(timeoutMs, signal),
  });

  if (!response.ok) {
    throw new Error(`Jina Reader error ${response.status}`);
  }

  const markdown = new TextDecoder().decode(await readResponseBytes(response, MAX_FETCH_BYTES));
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? url;

  return { url, title, content: markdown };
}

// ─── Local fallback (HTTP GET + turndown) ────────────────────────────────────

async function fetchLocal(
  url: string,
  lookup?: DnsLookup,
  trustedHosts?: TrustedHosts,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const response = await safeFetch(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      ...(signal ? { signal } : {}),
    },
    { lookup, trustedHosts },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = new TextDecoder().decode(await readResponseBytes(response, MAX_FETCH_BYTES));

  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return { url, title: url, content: text };
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(text);

  const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? url;

  return { url, title, content: markdown };
}

// ─── Default fallback: Jina Reader → Local ───────────────────────────────────

async function fetchWithFallback(
  url: string,
  timeoutMs: number,
  lookup?: DnsLookup,
  trustedHosts?: TrustedHosts,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const deadline = timeoutSignal(timeoutMs, signal);
  await assertPublicHttpUrl(url, { lookup, trustedHosts, signal: deadline });
  deadline.throwIfAborted();
  try {
    return await fetchViaJina(url, Math.max(1, Math.floor(timeoutMs / 2)), deadline);
  } catch (error) {
    if (deadline.aborted) throw error;
    return fetchLocal(url, lookup, trustedHosts, deadline);
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function webFetch(
  params: WebFetchParams,
  settings: WebToolSettings,
  lookup?: DnsLookup,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  signal?.throwIfAborted();
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trustedHosts = trustedHostsFromSettings(settings);
  const resolved = resolveFetchProvider(settings);
  if (resolved) {
    await assertPublicHttpUrl(params.url, { lookup, trustedHosts, signal });
    const provider = getProvider(resolved.id);
    if (!provider) {
      throw new Error(`Provider "${resolved.id}" is not registered.`);
    }
    return provider.fetch(params.url, resolved, signal);
  }
  return fetchWithFallback(params.url, timeoutMs, lookup, trustedHosts, signal);
}
