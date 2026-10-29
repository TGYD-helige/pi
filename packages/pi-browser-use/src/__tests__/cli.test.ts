// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures intentionally contain literal environment placeholders.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, test, vi } from 'vitest';

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
  it('resolves environment-backed connection and management authentication without expanding request bodies', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-browser-use-cli-auth-'));
    vi.stubEnv('PI_BROWSER_CLI_TEST_TOKEN', 'token-"quoted"\\safe');
    vi.stubEnv('PI_BROWSER_CLI_TEST_URL', 'wss://browser.example/cdp?token=private');
    vi.stubEnv('PI_BROWSER_CLI_TEST_MANAGEMENT', 'https://browser.example/session');
    const request = {
      url: '${PI_BROWSER_CLI_TEST_MANAGEMENT}',
      headers: { Authorization: 'Bearer ${PI_BROWSER_CLI_TEST_TOKEN}' },
      body: { expression: '${PI_BROWSER_CLI_TEST_TOKEN}', price: '$PRICE' },
    };
    try {
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
  it.each([
    undefined,
    '',
  ])('fails before connection when authentication environment is missing or empty: %s', (value) => {
    vi.stubEnv('PI_BROWSER_CLI_MISSING_TOKEN', value);
    try {
      expect(() =>
        parseArgs(['--ws-headers={"Authorization":"Bearer ${PI_BROWSER_CLI_MISSING_TOKEN}"}']),
      ).toThrow('PI_BROWSER_CLI_MISSING_TOKEN is missing or empty');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('rejects injected header newlines without exposing the resolved credential', () => {
    vi.stubEnv('PI_BROWSER_CLI_TEST_TOKEN', 'private-token\r\nX-Injected: value');
    try {
      expect(() =>
        parseArgs(['--ws-headers={"Authorization":"${PI_BROWSER_CLI_TEST_TOKEN}"}']),
      ).toThrow('valid HTTP header');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('does not resolve unused backend credentials when sessions are disabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-browser-use-cli-disabled-auth-'));
    try {
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const configPath = join(dir, 'settings.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        'pi-browser-use': {
          headless: true,
          channel: 'canary',
        },
      }),
    );

    try {
      const config = parseArgs(['--config', configPath]);
      expect(config.headless).toBe(true);
      expect(config.channel).toBe('canary');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('--config reads top-level keys when no pi-browser-use section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const configPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({ headless: true, viewport: '1280x720' }));

    try {
      const config = parseArgs(['--config', configPath]);
      expect(config.headless).toBe(true);
      expect(config.viewport).toBe('1280x720');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('--config can be combined with other flags (flags override)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const configPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({ 'pi-browser-use': { channel: 'canary' } }));

    try {
      const config = parseArgs(['--config', configPath, '--channel=stable']);
      expect(config.channel).toBe('stable');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
