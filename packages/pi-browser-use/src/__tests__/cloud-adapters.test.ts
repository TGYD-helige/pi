import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserAdapter, createCloudBrowserAdapter } from '../adapter.js';
import { serveBrowserSession } from '../session-server.js';

describe('cloud browser lifecycle adapters', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function api(response: object, origin = 'https://api.browserbase.com', status = 200) {
    const requests: Array<{
      url: string;
      method: string;
      key: string | undefined;
      body?: unknown;
    }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({
        url: req.url!,
        method: req.method!,
        key: (req.headers['x-bb-api-key'] ??
          req.headers['x-browser-use-api-key'] ??
          req.headers['steel-api-key']) as string | undefined,
        ...(body ? { body: JSON.parse(body) } : {}),
      });
      if (status === 0) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(response));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const remote = new URL(url);
      if (remote.hostname === '127.0.0.1') return fetch(url, init);
      expect(remote.origin).toBe(origin);
      return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
    });
    return requests;
  }

  it('selects Browserless Cloud by provider name with bounded CDP connection options', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const now = Date.now();
    const config = {
      session: {
        enabled: true as const,
        key: 'browserless',
        retentionMs: 1000,
        provider: {
          name: 'browserless' as const,
          apiKey: 'key+&',
          region: 'lon' as const,
          create: { timeout: 180000, launch: { headless: true, args: ['--lang=zh-CN'] } },
        },
      },
    };
    const adapter = await createBrowserAdapter(config);
    const signal = new AbortController().signal;
    const browser = await adapter.acquire(config, signal);
    const endpoint = new URL(browser.connection.wsEndpoint!);
    expect(endpoint.origin).toBe('wss://production-lon.browserless.io');
    expect(endpoint.pathname).toBe('/chrome');
    expect(endpoint.searchParams.get('token')).toBe('key+&');
    expect(endpoint.searchParams.get('timeout')).toBe('180000');
    expect(JSON.parse(endpoint.searchParams.get('launch')!)).toEqual({
      headless: true,
      args: ['--lang=zh-CN'],
    });
    expect(browser.expiresAt).toBeGreaterThanOrEqual(now + 180000);
    expect(adapter.describe).toBeUndefined();
    expect(adapter.retain).toBeUndefined();
    await adapter.release(browser, signal);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates Browserless launch options and cancels acquisition without allocating a browser', async () => {
    for (const create of [
      { timeout: 0 },
      { timeout: '60000' },
      { timeout: -1 },
      { session: 'persisted' },
      { ttl: 60000 },
      { processKeepAlive: 60000 },
      { token: 'override' },
    ])
      expect(() =>
        createCloudBrowserAdapter({ name: 'browserless', apiKey: 'key', create }),
      ).toThrow();
    expect(() =>
      createCloudBrowserAdapter(
        JSON.parse('{"name":"browserless","apiKey":"key","region":"invalid"}'),
      ),
    ).toThrow('region');
    const adapter = createCloudBrowserAdapter({ name: 'browserless', apiKey: 'key' });
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(adapter.acquire({}, signal)).rejects.toThrow('cancelled');
    const browser = await adapter.acquire({}, new AbortController().signal);
    const endpoint = new URL(browser.connection.wsEndpoint!);
    expect(endpoint.hostname).toBe('production-sfo.browserless.io');
    expect(endpoint.searchParams.get('timeout')).toBe('60000');
  });

  it('creates, describes and explicitly releases the same Browserbase session', async () => {
    const requests = await api({
      id: 'bb/123',
      connectUrl: 'wss://connect.browserbase.com?sessionId=bb',
      expiresAt: '2030-01-01T00:00:00Z',
      status: 'RUNNING',
    });
    const adapter = await createBrowserAdapter({
      session: {
        enabled: true,
        key: 'cloud',
        retentionMs: 1000,
        provider: {
          name: 'browserbase',
          apiKey: 'test-key',
          create: { projectId: 'project', timeout: 120 },
        },
      },
    });
    const signal = new AbortController().signal;
    const browser = await adapter.acquire({}, signal);
    expect(browser).toEqual({
      id: 'bb/123',
      connection: { wsEndpoint: 'wss://connect.browserbase.com?sessionId=bb' },
      expiresAt: 1893456000000,
    });
    expect(await adapter.describe!(browser, signal)).toEqual({
      alive: true,
      expiresAt: 1893456000000,
    });
    await adapter.release(browser, signal);
    expect(requests).toEqual([
      {
        url: '/v1/sessions',
        method: 'POST',
        key: 'test-key',
        body: { projectId: 'project', timeout: 120 },
      },
      { url: '/v1/sessions/bb%2F123', method: 'GET', key: 'test-key' },
      {
        url: '/v1/sessions/bb%2F123',
        method: 'POST',
        key: 'test-key',
        body: { status: 'REQUEST_RELEASE' },
      },
    ]);
    expect(adapter.retain).toBeUndefined();
  });
  it('uses Browser Use Cloud browser infrastructure rather than hosted agent sessions', async () => {
    const requests = await api(
      {
        id: 'bu-123',
        cdpUrl: 'wss://browser.example/cdp',
        timeoutAt: '2030-01-01T00:00:00Z',
        status: 'active',
      },
      'https://api.browser-use.com',
    );
    const adapter = createCloudBrowserAdapter({
      name: 'browser-use',
      apiKey: 'test-key',
      create: { timeout: 2 },
    });
    const signal = new AbortController().signal;
    const browser = await adapter.acquire({}, signal);
    expect(browser).toEqual({
      id: 'bu-123',
      connection: { wsEndpoint: 'wss://browser.example/cdp' },
      expiresAt: 1893456000000,
    });
    expect(await adapter.describe!(browser, signal)).toEqual({
      alive: true,
      expiresAt: 1893456000000,
    });
    await adapter.release(browser, signal);
    expect(requests).toEqual([
      { url: '/api/v4/browsers', method: 'POST', key: 'test-key', body: { timeout: 2 } },
      { url: '/api/v4/browsers/bu-123', method: 'GET', key: 'test-key' },
      {
        url: '/api/v4/browsers/bu-123',
        method: 'PATCH',
        key: 'test-key',
        body: { action: 'stop' },
      },
    ]);
    expect(adapter.retain).toBeUndefined();
  });
  it('authenticates Steel CDP for the returned session and derives its hard deadline', async () => {
    const requests = await api(
      {
        id: 'steel/123',
        websocketUrl: 'ws://internal:9222',
        createdAt: '2030-01-01T00:00:00Z',
        timeout: 120000,
        status: 'live',
      },
      'https://api.steel.dev',
    );
    const adapter = createCloudBrowserAdapter({
      name: 'steel',
      apiKey: 'test+key&',
      create: { timeout: 120000 },
    });
    const signal = new AbortController().signal;
    const browser = await adapter.acquire({}, signal);
    expect(browser).toEqual({
      id: 'steel/123',
      connection: {
        wsEndpoint: 'wss://connect.steel.dev/?apiKey=test%2Bkey%26&sessionId=steel%2F123',
      },
      expiresAt: 1893456120000,
    });
    expect(await adapter.describe!(browser, signal)).toEqual({
      alive: true,
      expiresAt: 1893456120000,
    });
    await adapter.release(browser, signal);
    expect(requests).toEqual([
      { url: '/v1/sessions', method: 'POST', key: 'test+key&', body: { timeout: 120000 } },
      { url: '/v1/sessions/steel%2F123', method: 'GET', key: 'test+key&' },
      { url: '/v1/sessions/steel%2F123/release', method: 'POST', key: 'test+key&' },
    ]);
    expect(adapter.retain).toBeUndefined();
  });
  it.each([
    'browserbase',
    'browser-use',
    'steel',
  ] as const)('validates %s before any allocation and adopts runtime bindings without creation', async (name) => {
    const browser = { id: 'existing', connection: { wsEndpoint: 'wss://existing.example' } };
    for (const invalid of [
      { name, apiKey: '' },
      { name, apiKey: 'secret\r\nInjected: yes' },
      { name, apiKey: 'secret', timeoutMs: 60001 },
      { name, apiKey: 'secret', timeoutMs: 0 },
      { name, apiKey: 'secret', create: [] },
      { name, apiKey: 'secret', sessionId: 'persistent-id' },
      { name, apiKey: 'secret', create: { sessionId: 'persistent-id' } },
    ])
      expect(() => createCloudBrowserAdapter(JSON.parse(JSON.stringify(invalid)))).toThrow();
    expect(() => createCloudBrowserAdapter({ name, apiKey: 'key', create: {} }, browser)).toThrow(
      'runtime binding',
    );
    const adapter = createCloudBrowserAdapter({ name, apiKey: 'key' }, browser);
    expect(await adapter.acquire({}, new AbortController().signal)).toEqual(browser);
    expect(() =>
      createCloudBrowserAdapter({ name, apiKey: 'key' }, { ...browser, connection: {} }),
    ).toThrow();
  });
  const fixtures = [
    {
      name: 'browserbase',
      origin: 'https://api.browserbase.com',
      response: {
        id: 'paid-id',
        connectUrl: 'wss://example.test',
        expiresAt: '2030-01-01T00:00:00Z',
        status: 'RUNNING',
      },
    },
    {
      name: 'browser-use',
      origin: 'https://api.browser-use.com',
      response: {
        id: 'paid-id',
        cdpUrl: 'wss://example.test',
        timeoutAt: '2030-01-01T00:00:00Z',
        status: 'active',
      },
    },
    {
      name: 'steel',
      origin: 'https://api.steel.dev',
      response: {
        id: 'paid-id',
        createdAt: '2030-01-01T00:00:00Z',
        timeout: 120000,
        status: 'live',
      },
    },
  ] as const;

  it.each(fixtures)('preserves literal native $name creation bodies', async ({
    name,
    origin,
    response,
  }) => {
    const requests = await api(response, origin);
    const create = { userMetadata: { label: 'literal-{sessionId}', deadline: '{expiresAt}' } };
    const adapter = createCloudBrowserAdapter({ name, apiKey: 'key', create });
    await adapter.acquire({}, new AbortController().signal);
    expect(requests[0]?.body).toEqual(create);
  });

  it.each(
    fixtures,
  )('preserves the allocated $name ID when its required deadline is absent', async ({
    name,
    origin,
    response,
  }) => {
    await api({ ...response, expiresAt: null, timeoutAt: null, createdAt: null }, origin);
    const adapter = createCloudBrowserAdapter({ name, apiKey: 'key' });
    await expect(adapter.acquire({}, new AbortController().signal)).rejects.toMatchObject({
      browser: { id: 'paid-id', connection: {} },
    });
  });

  it.each(
    fixtures,
  )('never reports unknown $name states as alive and preserves malformed paid handles', async ({
    name,
    origin,
    response,
  }) => {
    const data = { ...response, status: 'unexpected' };
    await api(data, origin);
    const adapter = createCloudBrowserAdapter({ name, apiKey: 'key' });
    const signal = new AbortController().signal;
    const browser = await adapter.acquire({}, signal);
    expect(await adapter.describe!(browser, signal)).toMatchObject({ alive: false });
    Object.assign(data, {
      expiresAt: 'invalid-date',
      timeoutAt: 'invalid-date',
      createdAt: 'invalid-date',
    });
    await expect(adapter.acquire({}, signal)).rejects.toMatchObject({
      browser: { id: 'paid-id', connection: {} },
    });
  });

  it.each(
    fixtures,
  )('keeps $name HTTP cleanup failures visible without leaking response data', async ({
    name,
    origin,
  }) => {
    await api({ secret: 'private-provider-response' }, origin, 403);
    const adapter = createCloudBrowserAdapter({ name, apiKey: 'key' });
    const signal = new AbortController().signal;
    const browser = { id: 'paid-id', connection: { wsEndpoint: 'wss://example.test' } };
    for (const operation of [
      () => adapter.acquire({}, signal),
      () => adapter.describe!(browser, signal),
      () => adapter.release(browser, signal),
    ]) {
      await expect(operation()).rejects.toThrow('HTTP 403');
      await expect(operation()).rejects.not.toThrow('private-provider-response');
    }
  });

  it.each(fixtures)('cancels and bounds pending $name management requests', async ({
    name,
    origin,
  }) => {
    await api({}, origin, 0);
    const controller = new AbortController();
    const adapter = createCloudBrowserAdapter({ name, apiKey: 'key', timeoutMs: 20 });
    const pending = adapter.acquire({}, controller.signal);
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    await expect(adapter.acquire({}, new AbortController().signal)).rejects.toThrow(
      'outcome may be unknown',
    );
  });
  it.each(
    fixtures,
  )('preserves and releases $name allocations through the worker after malformed creation', async ({
    name,
    origin,
    response,
  }) => {
    const requests = await api(
      {
        ...response,
        expiresAt: 'invalid-date',
        timeoutAt: 'invalid-date',
        createdAt: 'invalid-date',
      },
      origin,
    );
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    const onAcquire = vi.fn();
    const server = await serveBrowserSession(
      {
        session: {
          enabled: true,
          key: 'provider-worker',
          retentionMs: 1000,
          provider: { name, apiKey: 'key' },
        },
      },
      token,
      { onAcquire },
    );
    const request = (action: string, args: object = {}) =>
      fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, owner, ...args }),
      });
    try {
      await request('attach');
      expect(requests).toEqual([]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const failed = await request('call', { name: 'list_pages', args: {} });
        expect(failed.status).toBe(409);
        expect(await failed.text()).not.toContain('paid-id');
      }
      expect(onAcquire).toHaveBeenCalledExactlyOnceWith({ id: 'paid-id', connection: {} });
      expect(requests).toHaveLength(1);
      await server.stop();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.url).toContain('/paid-id');
      expect(requests[1]?.method).toBe(name === 'browser-use' ? 'PATCH' : 'POST');
    } finally {
      await server.stop();
    }
  });
});
