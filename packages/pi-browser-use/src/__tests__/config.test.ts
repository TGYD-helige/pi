import { afterEach, describe, expect, it, test, vi } from 'vitest';
import {
  buildSubprocessEnv,
  configToArgs,
  DEFAULT_ENV_ALLOWLIST,
  resolveConfig,
} from '../config.js';

describe('browser session configuration', () => {
  it('rejects provider instance IDs in persistent settings', () => {
    const session = JSON.parse(
      JSON.stringify({
        enabled: true,
        key: 'existing-cloud',
        retentionMs: 1000,
        backend: {
          sessionId: 'supplied-id',
          release: { url: 'http://localhost/stop/{sessionId}' },
        },
      }),
    );
    expect(() => resolveConfig({ session, wsEndpoint: 'ws://localhost:9222' })).toThrow(
      'runtime binding',
    );
  });

  it('accepts built-in providers but rejects ambiguous lifecycle ownership', () => {
    const provider = { name: 'steel' as const, apiKey: 'test-key' };
    const session = { enabled: true as const, key: 'cloud', retentionMs: 1000, provider };
    expect(resolveConfig({ session }).session?.provider).toEqual(provider);
    expect(() =>
      resolveConfig({ session: { ...session, adapterModule: '/tmp/custom.mjs' } }),
    ).toThrow('Choose');
    expect(() =>
      resolveConfig({
        session: { ...session, backend: { release: { url: 'https://example.test' } } },
      }),
    ).toThrow('Choose');
    expect(() =>
      resolveConfig({ session: { ...session, provider: { ...provider, apiKey: '' } } }),
    ).toThrow('API key');
    expect(() =>
      resolveConfig({ session: { enabled: false, provider: { ...provider, apiKey: '' } } }),
    ).not.toThrow();
  });

  it('defaults to direct connections and ignores disabled session options', () => {
    expect(resolveConfig().session).toBeUndefined();
    expect(resolveConfig({ session: { enabled: false }, slim: true }).slim).toBe(true);
  });

  it('requires a stable identity and bounded retention only when enabled', () => {
    expect(() => resolveConfig({ session: { enabled: true, key: '', retentionMs: 1000 } })).toThrow(
      'session.key',
    );
    for (const retentionMs of [0, -1, NaN, Infinity, 86_400_001]) {
      expect(() =>
        resolveConfig({ session: { enabled: true, key: 'conversation', retentionMs } }),
      ).toThrow('retentionMs');
    }
    expect(
      resolveConfig({ session: { enabled: true, key: 'conversation', retentionMs: 1000 } }).session
        ?.enabled,
    ).toBe(true);
  });

  it('rejects browser sessions when upstream page identity cannot be checked', () => {
    expect(() =>
      resolveConfig({
        session: { enabled: true, key: 'conversation', retentionMs: 1000 },
        slim: true,
      }),
    ).toThrow('page ID routing');
  });
  it('prevents extraArgs from bypassing the retained browser connection', () => {
    for (const argument of [
      '--ws-endpoint=wss://example.com',
      '--browserUrl=https://example.com',
      '--auto-connect',
      '-u=http://example.test:9222',
      '-w=ws://example.test/launch',
      '-wws://example.test/launch',
      '-e=/another/chrome',
      '--experimental-page-id-routing=false',
      '--no-experimental-page-id-routing',
      '--slim',
      '--no-ws-endpoint',
    ]) {
      expect(() =>
        resolveConfig({
          session: { enabled: true, key: 'conversation', retentionMs: 1000 },
          extraArgs: [argument],
        }),
      ).toThrow('extraArgs');
    }
  });
});

describe('buildSubprocessEnv', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('matches Windows names case-insensitively and masks SDK canonical keys', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const env = buildSubprocessEnv(
      { Path: '/bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', MyToken: 'secret' },
      ['mytoken'],
      ['pAtH', 'MYTOKEN'],
    );
    expect(env).toStrictEqual({
      PATH: undefined,
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'cmd.exe',
      MYTOKEN: undefined,
    });
  });

  it('keeps default-allowlisted vars and strips the rest', () => {
    const env = buildSubprocessEnv({
      PATH: '/usr/bin',
      DISPLAY: ':0',
      SECRET_API_TOKEN: 's3cret',
    });
    expect(env).toEqual({ PATH: '/usr/bin', DISPLAY: ':0' });
  });

  it('drops undefined values and blank extra names', () => {
    const env = buildSubprocessEnv({ HOME: '/home/u', SKIP: undefined }, ['', '  ']);
    expect(env).toEqual({ HOME: '/home/u' });
  });

  it('extends the default allowlist with configured extras', () => {
    const env = buildSubprocessEnv({ HOME: '/home/u', MY_TOKEN: 't' }, ['MY_TOKEN']);
    expect(env).toEqual({ HOME: '/home/u', MY_TOKEN: 't' });
    expect(DEFAULT_ENV_ALLOWLIST).toContain('DISPLAY');
  });

  it('drops blocklisted vars even when default- or extra-allowlisted', () => {
    const env = buildSubprocessEnv(
      { HOME: '/home/u', HTTP_PROXY: 'http://p:1', MY_TOKEN: 't' },
      ['MY_TOKEN'],
      ['HTTP_PROXY', 'MY_TOKEN'],
    );
    expect(env).toEqual({ HOME: '/home/u' });
  });

  it('ignores blank blocklist entries', () => {
    const env = buildSubprocessEnv({ HOME: '/home/u' }, [], ['', '  ']);
    expect(env).toEqual({ HOME: '/home/u' });
  });
});

describe('resolveConfig', () => {
  it('enables page ID routing and network header redaction by default', () => {
    const config = resolveConfig();

    expect(config.experimentalPageIdRouting).toBe(true);
    expect(config.redactNetworkHeaders).toBe(true);
    expect(config.acceptInsecureCerts).toBe(false);
  });

  test('returns defaults when called with no args', () => {
    const config = resolveConfig();
    expect(config.categoryPerformance).toBe(false);
    expect(config.categoryNetwork).toBe(true);
    expect(config.categoryEmulation).toBe(true);
    expect(config.categoryExtensions).toBe(false);
    expect(config.experimentalVision).toBe(true);
    expect(config.experimentalScreencast).toBe(false);
    expect(config.experimentalMemory).toBe(false);
    expect(config.usageStatistics).toBe(false);
    expect(config.performanceCrux).toBe(false);
    expect(config.toolProfile).toBe('core');
  });

  test('preserves the full tool profile', () => {
    expect(resolveConfig({ toolProfile: 'full' }).toolProfile).toBe('full');
  });

  test('returns defaults when called with empty object', () => {
    const config = resolveConfig({});
    expect(config.categoryPerformance).toBe(false);
    expect(config.experimentalVision).toBe(true);
  });

  test('merges user config over defaults', () => {
    const config = resolveConfig({ headless: true, channel: 'canary' });
    expect(config.headless).toBe(true);
    expect(config.channel).toBe('canary');
    expect(config.categoryPerformance).toBe(false);
  });

  test('user values override defaults', () => {
    const config = resolveConfig({
      categoryPerformance: true,
      experimentalVision: false,
    });
    expect(config.categoryPerformance).toBe(true);
    expect(config.experimentalVision).toBe(false);
  });
});

describe('configToArgs', () => {
  it('enables page ID routing and network header redaction by default', () => {
    const args = configToArgs({});

    expect(args).toContain('--experimental-page-id-routing');
    expect(args).toContain('--redact-network-headers');
    expect(args).not.toContain('--accept-insecure-certs');
  });

  it('maps URL patterns and insecure certificate configuration', () => {
    const args = configToArgs({
      blockedUrlPattern: ['https://example.com/*', 'https://*.internal/*'],
      acceptInsecureCerts: true,
    });

    expect(args).toContain('--blocked-url-pattern=https://example.com/*');
    expect(args).toContain('--blocked-url-pattern=https://*.internal/*');
    expect(args).toContain('--accept-insecure-certs');
  });

  it('allows page routing and header redaction to be disabled explicitly', () => {
    const args = configToArgs({
      experimentalPageIdRouting: false,
      redactNetworkHeaders: false,
    });

    expect(args).not.toContain('--experimental-page-id-routing');
    expect(args).not.toContain('--redact-network-headers');
  });

  it('rejects simultaneous URL allow and block lists', () => {
    expect(() =>
      configToArgs({
        allowedUrlPattern: ['https://allowed.example/*'],
        blockedUrlPattern: ['https://blocked.example/*'],
      }),
    ).toThrow('allowedUrlPattern and blockedUrlPattern cannot be used together');
  });

  it('disables page ID routing automatically in slim mode', () => {
    expect(configToArgs({ slim: true })).not.toContain('--experimental-page-id-routing');
  });

  it('rejects explicitly enabled page ID routing in slim mode', () => {
    expect(() => configToArgs({ slim: true, experimentalPageIdRouting: true })).toThrow(
      'experimentalPageIdRouting cannot be used with slim mode',
    );
  });

  test('empty config produces default flags', () => {
    const args = configToArgs({});
    expect(args).toContain('--category-performance=false');
    expect(args).toContain('--experimental-vision');
    expect(args).toContain('--no-usage-statistics');
    expect(args).toContain('--no-performance-crux');
  });

  test('boolean flags', () => {
    const args = configToArgs({ headless: true, isolated: true, autoConnect: true });
    expect(args).toContain('--headless');
    expect(args).toContain('--isolated');
    expect(args).toContain('--auto-connect');
  });

  test('value flags', () => {
    const args = configToArgs({
      channel: 'canary',
      viewport: '1280x720',
      browserUrl: 'http://localhost:9222',
      wsEndpoint: 'ws://localhost:9222',
      wsHeaders: '{"Authorization":"Bearer x"}',
      executablePath: '/usr/bin/chrome',
      userDataDir: '/tmp/chrome',
    });
    expect(args).toContain('--channel=canary');
    expect(args).toContain('--viewport=1280x720');
    expect(args).toContain('--browser-url=http://localhost:9222');
    expect(args).toContain('--ws-endpoint=ws://localhost:9222');
    expect(args).toContain('--ws-headers={"Authorization":"Bearer x"}');
    expect(args).toContain('--executable-path=/usr/bin/chrome');
    expect(args).toContain('--user-data-dir=/tmp/chrome');
  });

  test('slim flag', () => {
    const args = configToArgs({ slim: true });
    expect(args).toContain('--slim');
  });

  test('category toggles', () => {
    const args = configToArgs({
      categoryPerformance: true,
      categoryNetwork: false,
      categoryEmulation: false,
      categoryExtensions: true,
    });
    expect(args).not.toContain('--category-performance=false');
    expect(args).toContain('--category-network=false');
    expect(args).toContain('--category-emulation=false');
    expect(args).toContain('--category-extensions=true');
  });

  test('experimental flags', () => {
    const args = configToArgs({
      experimentalVision: true,
      experimentalScreencast: true,
      experimentalMemory: true,
    });
    expect(args).toContain('--experimental-vision');
    expect(args).toContain('--experimental-screencast');
    expect(args).toContain('--experimental-memory');
  });

  test('extraArgs passthrough', () => {
    const args = configToArgs({ extraArgs: ['--custom-flag', '--another=value'] });
    expect(args).toContain('--custom-flag');
    expect(args).toContain('--another=value');
  });

  test('headless false does not add flag', () => {
    const args = configToArgs({ headless: false });
    expect(args).not.toContain('--headless');
  });

  test('experimentalVision false does not add --experimental-vision', () => {
    const args = configToArgs({ experimentalVision: false });
    expect(args).not.toContain('--experimental-vision');
  });

  test('experimentalScreencast false does not add --experimental-screencast', () => {
    const args = configToArgs({ experimentalScreencast: false });
    expect(args).not.toContain('--experimental-screencast');
  });

  test('experimentalMemory false does not add --experimental-memory', () => {
    const args = configToArgs({ experimentalMemory: false });
    expect(args).not.toContain('--experimental-memory');
  });

  test('usageStatistics true does not add --no-usage-statistics', () => {
    const args = configToArgs({ usageStatistics: true });
    expect(args).not.toContain('--no-usage-statistics');
  });

  test('performanceCrux true does not add --no-performance-crux', () => {
    const args = configToArgs({ performanceCrux: true });
    expect(args).not.toContain('--no-performance-crux');
  });

  test('categoryNetwork true does not add --category-network=false', () => {
    const args = configToArgs({ categoryNetwork: true });
    expect(args).not.toContain('--category-network=false');
  });

  test('categoryEmulation true does not add --category-emulation=false', () => {
    const args = configToArgs({ categoryEmulation: true });
    expect(args).not.toContain('--category-emulation=false');
  });

  test('categoryExtensions false does not add --category-extensions=true', () => {
    const args = configToArgs({ categoryExtensions: false });
    expect(args).not.toContain('--category-extensions=true');
  });

  test('visionModel config does not produce its own CLI flag', () => {
    const args = configToArgs({
      visionModel: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(args.join(' ')).not.toContain('openai');
    expect(args.join(' ')).not.toContain('gpt-4o');
  });
});
