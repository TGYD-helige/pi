import { createRequire } from 'node:module';
import type { ResolvedProvider, SearchParams, SearchResponse } from './base.js';
import { BaseProvider } from './base.js';

const version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
const forbiddenHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'api-key', 'x-api-key', 'x-access-token', 'x-auth-token', 'x-parallel-api-key']);

interface RpcResponse { id?: number; result?: any; error?: { message?: string } }

export class ParallelProvider extends BaseProvider {
  readonly id = 'parallel' as const;

  async search(params: SearchParams, provider: ResolvedProvider, signal?: AbortSignal): Promise<SearchResponse> {
    const timeout = AbortSignal.timeout(provider.timeoutMs ?? 30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = new Headers({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'User-Agent': `pi/${version}` });
    for (const [name, value] of Object.entries(provider.headers ?? {})) {
      if (!forbiddenHeaders.has(name.toLowerCase())) headers.set(name, value);
    }
    let sessionId: string | undefined;
    let nextId = 1;
    const request = async (method: string, parameters?: unknown, notification = false): Promise<any> => {
      const body: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (!notification) body.id = nextId++;
      if (parameters !== undefined) body.params = parameters;
      const currentHeaders = new Headers(headers);
      if (sessionId) currentHeaders.set('Mcp-Session-Id', sessionId);
      const response = await fetch(provider.baseUrl, { method: 'POST', headers: currentHeaders, body: JSON.stringify(body), signal: requestSignal });
      if (!sessionId) sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;
      if (!response.ok) throw new Error(`Parallel MCP request failed (${response.status}).`);
      if (notification && response.status === 202) return undefined;
      const text = await response.text();
      if (notification && !text.trim()) return undefined;
      const messages = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()) as RpcResponse)
        : [JSON.parse(text) as RpcResponse];
      const message = messages.find((item) => item.id === body.id) ?? messages.at(-1);
      if (message?.error) throw new Error(message.error.message ?? 'Parallel MCP returned an error.');
      return message?.result;
    };
    try {
      await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pi', version } });
      await request('notifications/initialized', undefined, true);
      const listed = await request('tools/list');
      if (!listed?.tools?.some((tool: { name?: string }) => tool.name === 'web_search')) throw new Error('Parallel MCP web_search tool is unavailable.');
      const called = await request('tools/call', { name: 'web_search', arguments: { objective: params.query, search_queries: [params.query] } });
      const structured = called?.structuredContent ?? called?.content?.map((item: { text?: string }) => item.text).filter(Boolean).map((text: string) => JSON.parse(text))[0];
      const results = Array.isArray(structured?.results) ? structured.results.slice(0, params.maxResults ?? 5) : [];
      return { provider: this.id, query: params.query, results: results.map((item: { title?: string | null; url: string; excerpts?: string[] }) => ({ title: item.title ?? item.url, url: item.url, content: (item.excerpts ?? []).join('\n') })) };
    } finally {
      if (sessionId) {
        const cleanupHeaders = new Headers(headers);
        cleanupHeaders.set('Mcp-Session-Id', sessionId);
        await fetch(provider.baseUrl, { method: 'DELETE', headers: cleanupHeaders, signal: requestSignal }).catch(() => undefined);
      }
    }
  }
}
