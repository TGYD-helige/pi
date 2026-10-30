// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures intentionally contain literal environment placeholders.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import { BrowserSessionClient } from '../session-client.js';

const mockPrepareBrowserProfile = vi.hoisted(() => vi.fn());
const { mockHandlers, mockCliCall } = vi.hoisted(() => ({
  mockHandlers: [] as Array<(request: unknown, extra: unknown) => Promise<unknown>>,
  mockCliCall: vi.fn(),
}));

vi.mock('../profile.js', () => ({ prepareBrowserProfile: mockPrepareBrowserProfile }));

vi.mock('../index.js', () => ({
  DevToolsClient: class {
    connect = vi.fn();
    listAllTools = vi.fn(() =>
      Promise.resolve([{ name: 'take_snapshot', inputSchema: { type: 'object' } }]),
    );
    callTool = mockCliCall;
    close = vi.fn();
  },
  default: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler = vi.fn(
      (_schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) =>
        mockHandlers.push(handler),
    );
    connect = vi.fn();
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const { parseArgs, reportStartupFailure } = await import('../cli.js');

describe('cli startup', () => {
  it.each([
    '界'.repeat(30000),
    'row\n'.repeat(3000),
  ])('bounds standalone MCP text and structured output', async (large) => {
    await mockHandlers[0]!({}, {});
    mockCliCall.mockResolvedValueOnce({
      content: [
        { type: 'text', text: large },
        { type: 'text', text: large },
        { type: 'image', data: 'image', mimeType: 'image/png' },
      ],
      structuredContent: { records: [{ id: 'record-1', body: large }] },
      isError: true,
    });
    const result = (await mockHandlers[1]!(
      { params: { name: 'browser_take_snapshot', arguments: {} } },
      {},
    )) as {
      content: Array<{ type: string; text?: string }>;
      structuredContent: object;
      isError?: boolean;
    };
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
    expect(text.split('\n').length).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
      12 * 1024,
    );
    expect(result.content).toContainEqual({ type: 'image', data: 'image', mimeType: 'image/png' });
    expect(result.isError).toBe(true);
  });
  it('logs diagnostic categories without raw errors or credentials', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportStartupFailure(
        Object.assign(new Error('wss://secret.test/?token=private'), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      );
      expect(log).toHaveBeenLastCalledWith(
        '[pi-browser-use] startup failed (Error, ERR_MODULE_NOT_FOUND); check browser configuration and runtime availability',
      );
      const diagnostic = new SyntaxError('private JSON contents');
      reportStartupFailure(new Error('private config path', { cause: diagnostic }));
      expect(log).toHaveBeenLastCalledWith(
        '[pi-browser-use] startup failed (SyntaxError); check browser configuration and runtime availability',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    } finally {
      log.mockRestore();
    }
  });
  it('prepares the resolved browser profile before starting the client', () => {
    expect(mockPrepareBrowserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: 'persistent', userDataDir: expect.any(String) }),
    );
  });
});

describe('parseArgs', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pi-browser-use-cli-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([
    'wsEndpoint',
    'browserUrl',
  ] as const)('rejects malformed %s values with a safe field-specific diagnostic', (field) => {
    const file = join(directory, 'config.json');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const value of [true, false, null, 42, {}, []]) {
        writeFileSync(file, JSON.stringify({ [field]: value }));
        try {
          parseArgs(['--config', file]);
          throw new Error('Invalid value was accepted');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(`${field} must be a string.`);
          reportStartupFailure(error);
          expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining(`${field} must be a string.`),
          );
        }
      }
      expect(() => parseArgs([field === 'wsEndpoint' ? '--ws-endpoint' : '--browser-url'])).toThrow(
        `${field} must be a string.`,
      );
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ' { "Authorization" : "Bearer token" } ',
    '{"Authorization":"Bearer \\u0074oken"}',
  ])('resumes a pre-upgrade session without changing header spelling: %s', async (headers) => {
    vi.stubEnv('PI_AGENT_HOME', directory);
    const original = {
      wsEndpoint: 'ws://127.0.0.1:1',
      wsHeaders: headers,
      session: { enabled: true as const, key: 'upgrade', retentionMs: 1000 },
    };
    const previous = resolveConfig(original);
    const file = join(directory, 'config.json');
    writeFileSync(file, JSON.stringify(original));
    const worker = createServer((request, response) => {
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end('{"result":{"state":"active"}}');
    });
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
    const address = worker.address();
    if (!address || typeof address === 'string') throw new Error('Missing worker address');
    const record = join(
      directory,
      'browser-sessions',
      createHash('sha256').update('upgrade').digest('hex'),
    );
    mkdirSync(record, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(record, 'session.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(previous)).digest('hex'),
        port: address.port,
      }),
      { mode: 0o600 },
    );
    const client = new BrowserSessionClient(resolveConfig(parseArgs(['--config', file])));
    try {
      await expect(client.control('status')).resolves.toEqual({ state: 'active' });
      expect(parseArgs(['--config', file]).wsHeaders).toBe(headers);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => worker.close(() => resolve()));
    }
  });
  it('resolves environment-backed connection and management authentication without expanding request bodies', () => {
    vi.stubEnv('PI_BROWSER_CLI_TEST_TOKEN', 'token-"quoted"\\safe');
    vi.stubEnv('PI_BROWSER_CLI_TEST_URL', 'wss://browser.example/cdp?token=private');
    vi.stubEnv('PI_BROWSER_CLI_TEST_MANAGEMENT', 'https://browser.example/session');
    const request = {
      url: '${PI_BROWSER_CLI_TEST_MANAGEMENT}',
      headers: { Authorization: 'Bearer ${PI_BROWSER_CLI_TEST_TOKEN}' },
      body: { expression: '${PI_BROWSER_CLI_TEST_TOKEN}', price: '$PRICE' },
    };
    const file = join(directory, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        wsEndpoint: '${PI_BROWSER_CLI_TEST_URL}',
        wsHeaders: JSON.stringify({ Authorization: 'Bearer ${PI_BROWSER_CLI_TEST_TOKEN}' }),
        session: {
          enabled: true,
          key: 'auth',
          retentionMs: 1000,
          backend: { create: request, status: request, retain: request, release: request },
        },
      }),
    );
    const config = parseArgs(['--config', file]);
    expect(config.wsEndpoint).toBe('wss://browser.example/cdp?token=private');
    expect(JSON.parse(config.wsHeaders!)).toEqual({
      Authorization: 'Bearer token-"quoted"\\safe',
    });
    for (const action of ['create', 'status', 'retain', 'release'] as const) {
      expect(config.session?.backend?.[action]?.url).toBe('https://browser.example/session');
      expect(config.session?.backend?.[action]?.headers).toEqual({
        Authorization: 'Bearer token-"quoted"\\safe',
      });
      expect(config.session?.backend?.[action]?.body).toEqual(request.body);
    }
  });
  it.each([
    undefined,
    '',
  ])('fails before connection when authentication environment is missing or empty: %s', (value) => {
    vi.stubEnv('PI_BROWSER_CLI_MISSING_TOKEN', value);
    expect(() =>
      parseArgs(['--ws-headers={"Authorization":"Bearer ${PI_BROWSER_CLI_MISSING_TOKEN}"}']),
    ).toThrow('PI_BROWSER_CLI_MISSING_TOKEN is missing or empty');
  });
  it('rejects injected header newlines without exposing the resolved credential', () => {
    vi.stubEnv('PI_BROWSER_CLI_TEST_TOKEN', 'private-token\r\nX-Injected: value');
    expect(() =>
      parseArgs(['--ws-headers={"Authorization":"${PI_BROWSER_CLI_TEST_TOKEN}"}']),
    ).toThrow('valid HTTP header');
  });
  it('resolves built-in provider credentials while leaving native creation parameters untouched', () => {
    vi.stubEnv('PI_BROWSER_PROVIDER_TEST_KEY', 'private-key');
    const file = join(directory, 'provider.json');
    const session = {
      enabled: true,
      key: 'provider',
      retentionMs: 1000,
      provider: {
        name: 'steel',
        apiKey: '${PI_BROWSER_PROVIDER_TEST_KEY}',
        create: { userAgent: '$RAW' },
      },
    };
    writeFileSync(file, JSON.stringify({ session }));
    expect(parseArgs(['--config', file]).session?.provider).toEqual({
      ...session.provider,
      apiKey: 'private-key',
    });
    vi.stubEnv('PI_BROWSER_PROVIDER_TEST_KEY', undefined);
    expect(() => parseArgs(['--config', file])).toThrow('missing or empty');
    writeFileSync(file, JSON.stringify({ session: { ...session, enabled: false } }));
    expect(() => parseArgs(['--config', file])).not.toThrow();
  });

  it('does not resolve unused backend credentials when sessions are disabled', () => {
    const file = join(directory, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        session: {
          enabled: false,
          backend: {
            release: {
              url: 'https://browser.example',
              headers: { Authorization: '${PI_BROWSER_CLI_MISSING_TOKEN}' },
            },
          },
        },
      }),
    );
    expect(parseArgs(['--config', file]).session?.enabled).toBe(false);
    expect(
      parseArgs(['--ws-headers={"Authorization":"$PI_BROWSER_CLI_MISSING_TOKEN"}']).wsHeaders,
    ).toContain('$PI_BROWSER_CLI_MISSING_TOKEN');
  });
  it('collects repeated URL pattern flags into arrays', () => {
    const config = parseArgs([
      '--allowed-url-pattern=https://one.example/*',
      '--allowed-url-pattern=https://two.example/*',
    ]);

    expect(config.allowedUrlPattern).toEqual(['https://one.example/*', 'https://two.example/*']);
  });

  it('collects repeated env-allowlist flags into arrays', () => {
    const config = parseArgs(['--env-allowlist=FOO', '--env-allowlist=BAR']);

    expect(config.envAllowlist).toEqual(['FOO', 'BAR']);
  });

  it('collects repeated env-blocklist flags into arrays', () => {
    const config = parseArgs(['--env-blocklist=FOO', '--env-blocklist=BAR']);

    expect(config.envBlocklist).toEqual(['FOO', 'BAR']);
  });

  it('reports a clear error for a missing config file', () => {
    expect(() => parseArgs(['--config', '/definitely-missing/config.json'])).toThrow(
      'Cannot read config file: /definitely-missing/config.json',
    );
  });

  test('--headless produces boolean true', () => {
    const config = parseArgs(['--headless']);
    expect(config.headless).toBe(true);
  });

  test('--channel=canary produces string value', () => {
    const config = parseArgs(['--channel=canary']);
    expect(config.channel).toBe('canary');
  });

  test('--flag=true produces boolean true', () => {
    const config = parseArgs(['--headless=true']);
    expect(config.headless).toBe(true);
  });

  test('--flag=false produces boolean false', () => {
    const config = parseArgs(['--headless=false']);
    expect(config.headless).toBe(false);
  });

  test('kebab-case converts to camelCase', () => {
    const config = parseArgs(['--user-data-dir=/tmp/chrome']);
    expect(config.userDataDir).toBe('/tmp/chrome');
  });

  test('multiple flags combined', () => {
    const config = parseArgs(['--headless', '--channel=stable', '--viewport=1920x1080']);
    expect(config.headless).toBe(true);
    expect(config.channel).toBe('stable');
    expect(config.viewport).toBe('1920x1080');
  });

  test('empty args returns empty config', () => {
    const config = parseArgs([]);
    expect(config).toEqual({});
  });

  test('--config reads JSON file', () => {
    const configPath = join(directory, 'settings.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        'pi-browser-use': {
          headless: true,
          channel: 'canary',
        },
      }),
    );

    const config = parseArgs(['--config', configPath]);
    expect(config.headless).toBe(true);
    expect(config.channel).toBe('canary');
  });

  test('--config reads top-level keys when no pi-browser-use section', () => {
    const configPath = join(directory, 'settings.json');
    writeFileSync(configPath, JSON.stringify({ headless: true, viewport: '1280x720' }));

    const config = parseArgs(['--config', configPath]);
    expect(config.headless).toBe(true);
    expect(config.viewport).toBe('1280x720');
  });

  test('--config can be combined with other flags (flags override)', () => {
    const configPath = join(directory, 'settings.json');
    writeFileSync(configPath, JSON.stringify({ 'pi-browser-use': { channel: 'canary' } }));

    const config = parseArgs(['--config', configPath, '--channel=stable']);
    expect(config.channel).toBe('stable');
  });
});
