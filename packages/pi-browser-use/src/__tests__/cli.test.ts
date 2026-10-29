import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, test, vi } from 'vitest';

const mockPrepareBrowserProfile = vi.hoisted(() => vi.fn());

vi.mock('../profile.js', () => ({ prepareBrowserProfile: mockPrepareBrowserProfile }));

vi.mock('../index.js', () => ({
  DevToolsClient: class {
    connect = vi.fn();
    listAllTools = vi.fn(() => Promise.resolve([]));
    callTool = vi.fn();
    close = vi.fn();
  },
  default: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler = vi.fn();
    connect = vi.fn();
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const { parseArgs, reportStartupFailure } = await import('../cli.js');

describe('cli startup', () => {
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
