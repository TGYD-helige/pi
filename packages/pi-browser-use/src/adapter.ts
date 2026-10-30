import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserUseConfig, resolveConfig } from './config.js';
import {
  BrowserAcquisitionError,
  type BrowserAdapter,
  type BrowserLifecycleAdapter,
  createHttpBrowserAdapter,
  type ManagedBrowser,
  requestBrowserManagement,
  validateBrowserBinding,
  validateBrowserExpiry,
} from './session-backend.js';
import { BrowserSessionError } from './session-control.js';

/** Select lifecycle behavior independently of the MCP/CDP transport. */
export async function createBrowserAdapter(
  config: BrowserUseConfig,
  options: { adapter?: BrowserAdapter; browser?: ManagedBrowser } = {},
): Promise<BrowserAdapter> {
  const session = config.session?.enabled ? config.session : undefined;
  if (
    options.browser &&
    (options.adapter || session?.adapterModule || (!session?.backend && !session?.provider))
  )
    throw new BrowserSessionError(
      'A runtime browser binding requires an HTTP lifecycle backend or built-in provider.',
    );
  if ([session?.provider, session?.backend, session?.adapterModule].filter(Boolean).length > 1)
    throw new BrowserSessionError(
      'Choose one browser session provider, backend, or adapterModule.',
    );
  let adapter = options.adapter;
  if (adapter === undefined) {
    if (session?.provider) adapter = createCloudBrowserAdapter(session.provider, options.browser);
    else if (session?.backend) adapter = createHttpBrowserAdapter(session.backend, options.browser);
    else if (session?.adapterModule) {
      if (!isAbsolute(session.adapterModule))
        throw new BrowserSessionError(
          'Browser adapterModule must be an absolute trusted module path.',
        );
      const module = await import(pathToFileURL(session.adapterModule).href);
      adapter = await module.createBrowserLifecycleAdapter();
    } else {
      const { session: _session, ...connection } = resolveConfig(config);
      adapter = {
        ownership:
          connection.wsEndpoint ||
          connection.browserUrl ||
          connection.autoConnect ||
          connection.sessionMode === 'existing'
            ? 'external'
            : 'local',
        async acquire(_config, signal) {
          signal.throwIfAborted();
          return { id: randomUUID(), connection };
        },
        // MCP/tunnel cleanup closes local launches and detaches external connections.
        async release() {},
      };
    }
  }
  if (
    !adapter ||
    typeof adapter.acquire !== 'function' ||
    typeof adapter.release !== 'function' ||
    (adapter.describe !== undefined && typeof adapter.describe !== 'function') ||
    (adapter.retain !== undefined && typeof adapter.retain !== 'function') ||
    (adapter.ownership !== undefined &&
      !['local', 'external', 'adapter'].includes(adapter.ownership))
  )
    throw new BrowserSessionError('Invalid browser lifecycle adapter.');
  return adapter;
}

export interface CloudBrowserProvider {
  name: 'browserbase' | 'browser-use' | 'steel' | 'browserless';
  apiKey: string;
  /** Browserless Cloud region; defaults to sfo. */
  region?: 'sfo' | 'lon' | 'ams';
  /** Provider-native creation parameters; timeout units follow that provider's API. */
  create?: Record<string, unknown>;
  /** Management request timeout, independent of the browser lifetime. */
  timeoutMs?: number;
}

export function createCloudBrowserAdapter(
  config: CloudBrowserProvider,
  browser?: ManagedBrowser,
): BrowserLifecycleAdapter {
  if (
    !['browserbase', 'browser-use', 'steel', 'browserless'].includes(config?.name) ||
    typeof config.apiKey !== 'string' ||
    !config.apiKey.trim()
  )
    throw new BrowserSessionError('Invalid browser cloud provider or missing API key.');
  if (
    Object.hasOwn(config, 'sessionId') ||
    (config.create && Object.hasOwn(config.create, 'sessionId'))
  )
    throw new BrowserSessionError(
      'Provider sessionId is runtime state; supply a runtime binding instead of settings.',
    );
  if (
    config.create !== undefined &&
    (!config.create || typeof config.create !== 'object' || Array.isArray(config.create))
  )
    throw new BrowserSessionError('Browser cloud create parameters must be a JSON object.');
  if (browser) {
    validateBrowserBinding(browser);
    if (config.create !== undefined)
      throw new BrowserSessionError(
        'Choose provider creation parameters or a runtime binding, not both.',
      );
  }
  const timeoutMs = config.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new BrowserSessionError('Browser backend timeoutMs must be between 1 and 60000.');
  try {
    new Headers({ Authorization: config.apiKey });
  } catch {
    throw new BrowserSessionError('Browser cloud API key must be a valid HTTP header value.');
  }
  if (
    config.region !== undefined &&
    (config.name !== 'browserless' || !['sfo', 'lon', 'ams'].includes(config.region))
  )
    throw new BrowserSessionError('Browserless Cloud region must be sfo, lon, or ams.');
  if (config.name === 'browserless') {
    const params = config.create ?? {};
    if (['token', 'session', 'ttl', 'processKeepAlive'].some((key) => Object.hasOwn(params, key)))
      throw new BrowserSessionError(
        'Browserless launch options cannot override authentication or enable persistent sessions.',
      );
    const timeout = params.timeout ?? 60000;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1)
      throw new BrowserSessionError(
        'Browserless connection timeout must be a positive integer in milliseconds.',
      );
    validateBrowserExpiry(Date.now() + timeout);
    const endpoint = new URL(`wss://production-${config.region ?? 'sfo'}.browserless.io/chrome`);
    try {
      for (const [key, value] of Object.entries(params))
        if (value !== undefined)
          endpoint.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch {
      throw new BrowserSessionError('Browserless launch options must be JSON-serializable.');
    }
    endpoint.searchParams.set('token', config.apiKey);
    endpoint.searchParams.set('timeout', String(timeout));
    return {
      async acquire(_config, signal) {
        signal.throwIfAborted();
        return (
          browser ?? {
            id: randomUUID(),
            connection: { wsEndpoint: endpoint.href },
            expiresAt: Date.now() + timeout,
          }
        );
      },
      // Standard Browserless sessions end when their CDP transport disconnects.
      async release() {},
    };
  }
  const browserbase = config.name === 'browserbase';
  const steel = config.name === 'steel';
  const url = steel
    ? 'https://api.steel.dev/v1/sessions'
    : browserbase
      ? 'https://api.browserbase.com/v1/sessions'
      : 'https://api.browser-use.com/api/v4/browsers';
  const headers = {
    [steel ? 'steel-api-key' : browserbase ? 'X-BB-API-Key' : 'X-Browser-Use-API-Key']:
      config.apiKey,
  };
  const request = async (
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    signal: AbortSignal,
    body?: unknown,
  ) =>
    (await requestBrowserManagement(
      { url: `${url}${path}`, headers, method, ...(body === undefined ? {} : { body }) },
      signal,
      timeoutMs,
    )) as Record<string, unknown> | null;
  const expiry = (response: Record<string, unknown> | null) => {
    const timestamp = response?.[steel ? 'createdAt' : browserbase ? 'expiresAt' : 'timeoutAt'];
    if (
      typeof timestamp !== 'string' ||
      (steel &&
        (typeof response?.timeout !== 'number' ||
          !Number.isFinite(response.timeout) ||
          response.timeout <= 0))
    )
      throw new BrowserSessionError('Browser cloud returned an invalid browser deadline.');
    const expiresAt = Date.parse(timestamp) + (steel ? (response!.timeout as number) : 0);
    validateBrowserExpiry(expiresAt);
    return expiresAt;
  };
  return {
    async acquire(_config, signal) {
      signal.throwIfAborted();
      if (browser) return browser;
      const response = await request('', 'POST', signal, config.create ?? {});
      if (typeof response?.id !== 'string' || !response.id.trim() || response.id.length > 1024)
        throw new BrowserSessionError(
          'Browser cloud creation returned no valid session ID; inspect the provider before retrying.',
        );
      try {
        let endpoint = response[browserbase ? 'connectUrl' : 'cdpUrl'];
        if (steel) {
          const url = new URL('wss://connect.steel.dev');
          url.searchParams.set('apiKey', config.apiKey);
          url.searchParams.set('sessionId', response.id);
          endpoint = url.href;
        }
        if (typeof endpoint !== 'string') throw new Error();
        const acquired = {
          id: response.id,
          connection: { wsEndpoint: endpoint },
          expiresAt: expiry(response),
        };
        validateBrowserBinding(acquired);
        return acquired;
      } catch {
        throw new BrowserAcquisitionError({ id: response.id, connection: {} });
      }
    },
    async describe(browser, signal) {
      const response = await request(`/${encodeURIComponent(browser.id)}`, 'GET', signal);
      return {
        alive: response?.status === (steel ? 'live' : browserbase ? 'RUNNING' : 'active'),
        expiresAt: expiry(response),
      };
    },
    async release(browser, signal) {
      await request(
        `/${encodeURIComponent(browser.id)}${steel ? '/release' : ''}`,
        browserbase || steel ? 'POST' : 'PATCH',
        signal,
        steel ? undefined : browserbase ? { status: 'REQUEST_RELEASE' } : { action: 'stop' },
      );
    },
  };
}
