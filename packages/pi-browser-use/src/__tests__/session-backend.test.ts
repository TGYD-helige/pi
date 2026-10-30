import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpBrowserAdapter, readBrowserSessionBinding } from '../session-backend.js';

describe('browser session HTTP adapter', () => {
  it('rejects incomplete lifecycle configuration before any paid creation', () => {
    const base = {
      create: { url: 'https://example.test/create' },
      release: { url: 'https://example.test/release' },
      fields: { id: 'id', wsEndpoint: 'cdpUrl' },
    };
    for (const invalid of [
      { ...base, release: undefined },
      { ...base, fields: undefined },
      { ...base, sessionId: 'both-sources' },
      { ...base, create: undefined },
      { ...base, create: undefined, sessionId: '' },
      { ...base, create: undefined, sessionId: 123 },
      { ...base, create: undefined, sessionId: 'x'.repeat(1025) },
      { ...base, status: { url: 'https://example.test/status' } },
      { ...base, retain: { url: 'https://example.test/retain' } },
      { ...base, release: { ...base.release, method: 'INVALID' } },
      { ...base, release: { ...base.release, headers: { Authorization: 'bad\nvalue' } } },
      { ...base, fields: { ...base.fields, expiresAt: true } },
      {
        ...base,
        status: { url: base.create.url },
        fields: { ...base.fields, status: 123, liveStatus: 'live' },
      },
    ]) {
      expect(() => createHttpBrowserAdapter(JSON.parse(JSON.stringify(invalid)))).toThrow();
    }
  });

  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('accepts runtime environment bindings only for their matching conversation', () => {
    const config = {
      session: { enabled: true as const, key: 'conversation-a', retentionMs: 1000 },
    };
    const browser = {
      id: 'private-provider-id',
      connection: { wsEndpoint: 'ws://localhost:9222/devtools/browser/existing' },
    };
    vi.stubEnv(
      'PI_BROWSER_USE_SESSION_BINDING',
      JSON.stringify({ key: 'conversation-a', browser }),
    );
    expect(readBrowserSessionBinding(config)).toEqual(browser);
    expect(readBrowserSessionBinding({ session: { enabled: false } })).toBeUndefined();
    expect(() =>
      readBrowserSessionBinding({ session: { ...config.session, key: 'conversation-b' } }),
    ).toThrow('key mismatch');
    for (const value of [
      'invalid-json',
      JSON.stringify({ key: 'conversation-a', browser: { ...browser, id: '' } }),
      JSON.stringify({ key: 'conversation-a', browser: { ...browser, connection: {} } }),
    ]) {
      vi.stubEnv('PI_BROWSER_USE_SESSION_BINDING', value);
      expect(() => readBrowserSessionBinding(config)).toThrow('Invalid runtime browser binding');
    }
  });

  it('rejects creation and a runtime binding together', () => {
    expect(() =>
      createHttpBrowserAdapter(
        {
          create: { url: 'https://example.test/create' },
          release: { url: 'https://example.test/stop' },
          fields: { id: 'id', wsEndpoint: 'cdp' },
        },
        { id: 'existing', connection: { wsEndpoint: 'ws://localhost:9222' } },
      ),
    ).toThrow('exactly one');
  });

  it('manages a supplied session ID and CDP connection without creating a browser', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.end(req.method === 'GET' ? '{"status":"running"}' : '{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    const url = `http://127.0.0.1:${address.port}/sessions/{sessionId}`;
    const connection = {
      wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/existing',
      wsHeaders: '{"Authorization":"Bearer cdp-token"}',
    };
    const adapter = createHttpBrowserAdapter(
      {
        release: { url, method: 'DELETE' },
        status: { url, method: 'GET' },
        fields: { status: 'status', liveStatus: 'running' },
      },
      { id: 'already-created/123', connection },
    );
    const browser = await adapter.acquire({}, new AbortController().signal);
    expect(browser).toEqual({ id: 'already-created/123', connection });
    expect(requests).toEqual([]);
    expect(await adapter.describe!(browser, new AbortController().signal)).toEqual({ alive: true });
    await adapter.release(browser, new AbortController().signal);
    expect(requests).toEqual([
      'GET /sessions/already-created%2F123',
      'DELETE /sessions/already-created%2F123',
    ]);
  });

  it('creates a cloud browser and releases that same backend session', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.method === 'POST'
            ? { data: { id: 'cloud-123', cdp: 'ws://127.0.0.1:9222?token=secret' } }
            : { status: 'stopped' },
        ),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    const adapter = createHttpBrowserAdapter({
      create: {
        url: `http://127.0.0.1:${address.port}/browsers`,
        method: 'POST',
        body: { keepAlive: true },
      },
      release: { url: `http://127.0.0.1:${address.port}/browsers/{sessionId}`, method: 'DELETE' },
      fields: { id: 'data.id', wsEndpoint: 'data.cdp' },
    });
    const browser = await adapter.acquire({}, new AbortController().signal);
    expect(browser.id).toBe('cloud-123');
    expect(browser.connection.wsEndpoint).toBe('ws://127.0.0.1:9222?token=secret');
    await adapter.release(browser, new AbortController().signal);
    expect(requests).toEqual(['POST /browsers', 'DELETE /browsers/cloud-123']);
  });

  it('preserves session IDs in JSON bodies while encoding URL path components', async () => {
    let received: unknown;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    const url = `http://127.0.0.1:${address.port}/{sessionId}`;
    const adapter = createHttpBrowserAdapter({
      create: { url },
      release: { url, body: { id: '{sessionId}' } },
      fields: { id: 'id', wsEndpoint: 'cdpUrl' },
    });
    await adapter.release({ id: 'a/b', connection: {} }, new AbortController().signal);
    expect(received).toEqual({ url: '/a%2Fb', body: { id: 'a/b' } });
  });

  it('bounds provider responses and never exposes their error bodies', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/large') res.end('x'.repeat(70_000));
      else {
        res.statusCode = 403;
        res.end('secret-provider-response');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    for (const [path, message] of [
      ['/large', '64 KiB'],
      ['/error', 'HTTP 403'],
    ]) {
      const url = `http://127.0.0.1:${address.port}${path}`;
      const adapter = createHttpBrowserAdapter({
        create: { url },
        release: { url },
        fields: { id: 'id', wsEndpoint: 'cdpUrl' },
      });
      await expect(adapter.acquire({}, new AbortController().signal)).rejects.toThrow(message);
      await expect(adapter.acquire({}, new AbortController().signal)).rejects.not.toThrow(
        'secret-provider-response',
      );
    }
  });

  it.each([
    { cdpUrl: 'invalid' },
    { cdpUrl: 'ws://localhost:9222', expiresAt: Number.MAX_VALUE },
  ])('preserves a known paid session ID when its connection response is invalid (%j)', async (response) => {
    const server = createServer((_req, res) =>
      res.end(JSON.stringify({ id: 'recover-me', ...response })),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    const url = `http://127.0.0.1:${address.port}`;
    const adapter = createHttpBrowserAdapter({
      create: { url },
      release: { url },
      fields: { id: 'id', wsEndpoint: 'cdpUrl', expiresAt: 'expiresAt' },
    });
    await expect(adapter.acquire({}, new AbortController().signal)).rejects.toMatchObject({
      browser: { id: 'recover-me', connection: {} },
    });
  });
});
