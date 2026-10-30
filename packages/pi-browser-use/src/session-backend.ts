import type { CloudBrowserProvider } from './adapter.js';
import type { BrowserUseConfig } from './config.js';
import { parseBrowserHeaders } from './session-connection.js';
import { BrowserSessionError } from './session-control.js';

export interface ManagedBrowser {
  /** Provider ID, or a private reference for a direct adapter. */
  id: string;
  connection: Omit<BrowserUseConfig, 'session'>;
  /** Absolute provider deadline, not a promise that the provider will extend it. */
  expiresAt?: number;
}

/** Recovery metadata stays in the protected record, never in the model-visible error. */
export class BrowserAcquisitionError extends BrowserSessionError {
  constructor(readonly browser: ManagedBrowser) {
    super(
      'Browser creation returned invalid connection details; inspect the provider before retrying.',
    );
  }
}

/** Loaded in the independent session process, so cleanup survives the Pi client. */
export interface BrowserAdapter {
  /** Built-in direct connections declare ownership; managed backends default to adapter-owned. */
  readonly ownership?: 'local' | 'external' | 'adapter';
  acquire(config: BrowserUseConfig, signal: AbortSignal): Promise<ManagedBrowser>;
  describe?(
    browser: ManagedBrowser,
    signal: AbortSignal,
  ): Promise<{ alive: boolean; expiresAt?: number }>;
  retain?(
    browser: ManagedBrowser,
    expiresAt: number,
    signal: AbortSignal,
  ): Promise<{ expiresAt: number }>;
  /** Ends an adapter-owned browser. Must preserve reusable profiles unless explicitly configured otherwise. */
  release(browser: ManagedBrowser, signal: AbortSignal): Promise<void>;
}

/** Compatibility name for existing custom lifecycle modules and SDK callers. */
export type BrowserLifecycleAdapter = BrowserAdapter;

export interface HttpSessionRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpBrowserBackend {
  create?: HttpSessionRequest;
  release: HttpSessionRequest;
  status?: HttpSessionRequest;
  retain?: HttpSessionRequest;
  fields?: {
    id?: string;
    wsEndpoint?: string;
    expiresAt?: string;
    status?: string;
    liveStatus?: string;
  };
  timeoutMs?: number;
}

export type BrowserSessionConfig = {
  /** Built-in cloud lifecycle integration; mutually exclusive with backend and adapterModule. */
  provider?: CloudBrowserProvider;
  backend?: HttpBrowserBackend;
  /** Trusted absolute module exporting createBrowserLifecycleAdapter(). */
  adapterModule?: string;
} & (
  | {
      enabled: true;
      /** Stable logical conversation identity; never reuse across unrelated tasks. */
      key: string;
      /** Upper bound per handoff; no idle retention is enabled by this setting alone. */
      retentionMs: number;
    }
  | { enabled: false; key?: string; retentionMs?: number }
);

export function validateBrowserExpiry(value: unknown) {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(new Date(value).getTime()))
  )
    throw new BrowserSessionError('The browser backend returned an invalid expiry.');
}

export function validateBrowserBinding(
  browser: ManagedBrowser,
  ownership: NonNullable<BrowserAdapter['ownership']> = 'adapter',
) {
  try {
    if (
      !browser ||
      typeof browser.id !== 'string' ||
      !browser.id.trim() ||
      browser.id.length > 1024 ||
      !browser.connection ||
      typeof browser.connection !== 'object' ||
      Array.isArray(browser.connection) ||
      Object.hasOwn(browser.connection, 'session')
    )
      throw new Error();
    validateBrowserExpiry(browser.expiresAt);
    const { wsEndpoint, browserUrl, wsHeaders } = browser.connection;
    if (
      [wsEndpoint, browserUrl, wsHeaders].some(
        (value) => value !== undefined && typeof value !== 'string',
      )
    )
      throw new Error();
    if (ownership !== 'adapter' && !wsEndpoint && !browserUrl) {
      parseBrowserHeaders(wsHeaders);
      return;
    }
    const endpoint = new URL(wsEndpoint || browserUrl || '');
    if (!(wsEndpoint ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(endpoint.protocol))
      throw new Error();
    parseBrowserHeaders(wsHeaders);
  } catch {
    throw new BrowserSessionError(
      'Invalid runtime browser binding; provide a provider ID and explicit CDP connection.',
    );
  }
}

/** Only entry points read this environment value; SDK clients receive a per-client binding. */
export function readBrowserSessionBinding(config: BrowserUseConfig): ManagedBrowser | undefined {
  const raw = process.env.PI_BROWSER_USE_SESSION_BINDING;
  if (!raw || !config.session?.enabled) return undefined;
  try {
    if (Buffer.byteLength(raw) > 65_536) throw new Error();
    const value = JSON.parse(raw) as { key?: string; browser?: ManagedBrowser };
    if (value?.key !== config.session.key || !value.browser) throw new Error();
    validateBrowserBinding(value.browser);
    return value.browser;
  } catch {
    throw new BrowserSessionError('Invalid runtime browser binding or conversation key mismatch.');
  }
}

function field(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, name) =>
        current !== null && typeof current === 'object' && Object.hasOwn(current, name)
          ? (current as Record<string, unknown>)[name]
          : undefined,
      value,
    );
}

function deadline(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  validateBrowserExpiry(parsed);
  return parsed;
}

/** Shared bounded transport for generic and built-in lifecycle adapters. */
export async function requestBrowserManagement(
  spec: HttpSessionRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await fetch(spec.url, {
      method: spec.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...spec.headers },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      signal: boundedSignal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BrowserSessionError(`Browser management request failed (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new BrowserSessionError('Browser management response exceeded 64 KiB.');
      }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as unknown) : {};
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof BrowserSessionError) throw error;
    throw new BrowserSessionError(
      'Browser management request failed; its outcome may be unknown. Inspect the provider before retrying.',
    );
  }
}

export function createHttpBrowserAdapter(
  config: HttpBrowserBackend,
  browser?: ManagedBrowser,
): BrowserLifecycleAdapter {
  const fields = config?.fields ?? {};
  if (browser !== undefined) validateBrowserBinding(browser);
  if (
    !config?.release ||
    Object.hasOwn(config, 'sessionId') ||
    Boolean(config.create) === (browser !== undefined) ||
    (config.create &&
      ![fields.id, fields.wsEndpoint].every(
        (value) => typeof value === 'string' && value.trim().length > 0,
      )) ||
    (config.fields !== undefined &&
      (!config.fields || typeof config.fields !== 'object' || Array.isArray(config.fields))) ||
    Object.values(fields).some((value) => typeof value !== 'string' || !value.trim()) ||
    (config.status && (!fields.status || !fields.liveStatus)) ||
    (config.retain && !fields.expiresAt)
  )
    throw new BrowserSessionError(
      'Browser backend requires release and exactly one of create or a runtime browser binding, with valid response field mappings.',
    );
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new BrowserSessionError('Browser backend timeoutMs must be between 1 and 60000.');
  }
  for (const request of [config.create, config.release, config.status, config.retain]) {
    if (!request) continue;
    try {
      if (
        request.headers !== undefined &&
        (!request.headers ||
          typeof request.headers !== 'object' ||
          Array.isArray(request.headers) ||
          Object.values(request.headers).some((value) => typeof value !== 'string'))
      )
        throw new Error();
      new Headers(request.headers);
    } catch {
      throw new BrowserSessionError('Browser management headers must be valid HTTP string values.');
    }
    if (
      (request.method !== undefined &&
        !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) ||
      (request.method === 'GET' && request.body !== undefined)
    )
      throw new BrowserSessionError('Browser management request method or body is invalid.');
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new BrowserSessionError(
        'Browser management URLs must use HTTP(S) without URL credentials.',
      );
    }
  }

  async function request(
    spec: HttpSessionRequest,
    signal: AbortSignal,
    browser?: ManagedBrowser,
    expiresAt?: number,
  ) {
    const replace = (value: string, encodeId = false) =>
      value
        .replaceAll(
          '{sessionId}',
          encodeId ? encodeURIComponent(browser?.id ?? '') : (browser?.id ?? ''),
        )
        .replaceAll('{expiresAt}', String(expiresAt ?? ''));
    const map = (value: unknown): unknown => {
      if (value === '{expiresAt}') return expiresAt;
      if (typeof value === 'string') return replace(value);
      if (Array.isArray(value)) return value.map(map);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(child)]));
      return value;
    };
    return requestBrowserManagement(
      {
        ...spec,
        url: replace(spec.url, true),
        ...(spec.body === undefined ? {} : { body: map(spec.body) }),
      },
      signal,
      timeoutMs,
    );
  }

  return {
    async acquire(_browserConfig, signal) {
      signal.throwIfAborted();
      if (browser) return browser;
      const response = await request(config.create!, signal);
      const id = field(response, fields.id!);
      const endpoint = field(response, fields.wsEndpoint!);
      if (typeof id !== 'string' || !id || id.length > 1024) {
        throw new BrowserSessionError(
          'Browser creation returned no valid session ID or CDP endpoint; inspect the provider before retrying.',
        );
      }
      try {
        if (typeof endpoint !== 'string') throw new Error();
        const url = new URL(endpoint);
        if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) throw new Error();
        const expiresAt = fields.expiresAt
          ? deadline(field(response, fields.expiresAt))
          : undefined;
        return {
          id,
          connection: url.protocol.startsWith('ws')
            ? { wsEndpoint: endpoint }
            : { browserUrl: endpoint },
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
      } catch {
        throw new BrowserAcquisitionError({ id, connection: {} });
      }
    },
    ...(config.status
      ? {
          async describe(browser: ManagedBrowser, signal: AbortSignal) {
            const response = await request(config.status!, signal, browser);
            const expiresAt = fields.expiresAt
              ? deadline(field(response, fields.expiresAt))
              : undefined;
            return {
              alive: field(response, fields.status!) === fields.liveStatus,
              ...(expiresAt === undefined ? {} : { expiresAt }),
            };
          },
        }
      : {}),
    ...(config.retain
      ? {
          async retain(browser: ManagedBrowser, expiresAt: number, signal: AbortSignal) {
            const response = await request(config.retain!, signal, browser, expiresAt);
            const effective = fields.expiresAt
              ? deadline(field(response, fields.expiresAt))
              : undefined;
            if (effective === undefined)
              throw new BrowserSessionError(
                'A backend retain request must return its effective expiresAt.',
              );
            return { expiresAt: effective };
          },
        }
      : {}),
    async release(browser, signal) {
      await request(config.release, signal, browser);
    },
  };
}
