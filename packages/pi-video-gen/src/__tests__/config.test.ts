import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listModelRegistry,
  loadVideoGenSettings,
  resolveModel,
  resolveOutputDir,
  resolveProvider,
} from '../config.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-config');

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data), 'utf-8');
}

describe('loadVideoGenSettings', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = join(suiteDir, `proj-${Math.random().toString(36).slice(2, 8)}`);
    home = join(suiteDir, `home-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('PI_AGENT_HOME', join(home, '.pi', 'agent'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(home, '.pi', 'agent'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('returns defaults when nothing is configured', () => {
    expect(loadVideoGenSettings(cwd, false)).toEqual({});
  });

  it.each([
    ['rateLimit.maxRequestsPerMinute', { rateLimit: { maxRequestsPerMinute: 0 } }],
    ['rateLimit.maxRequestsPerDay', { rateLimit: { maxRequestsPerDay: 1.5 } }],
    ['concurrency.clips', { concurrency: { clips: 'two' } }],
  ])('rejects invalid %s before it reaches the runtime', (path, section) => {
    writeJson(join(home, '.pi', 'agent', 'settings.json'), {
      'pi-video-gen': section,
    });

    expect(() => loadVideoGenSettings(cwd, false)).toThrow(
      new RegExp(`${path.replaceAll('.', String.raw`\.`)}.*positive integer`),
    );
  });

  it('ignores the project layer entirely when untrusted', () => {
    writeJson(join(cwd, '.pi', 'settings.json'), {
      'pi-video-gen': { defaultModel: 'seedance-2.0-fast', outputDir: 'custom-out' },
    });
    const settings = loadVideoGenSettings(cwd, false);
    expect(settings.defaultModel).toBeUndefined();
    expect(settings.outputDir).toBeUndefined();
  });

  it('honors whitelisted keys from a trusted project', () => {
    writeJson(join(cwd, '.pi', 'settings.json'), {
      'pi-video-gen': {
        defaultModel: 'seedance-2.0-fast',
        outputDir: 'custom-out',
        concurrency: { clips: 1 },
      },
    });
    const settings = loadVideoGenSettings(cwd, true);
    expect(settings.defaultModel).toBe('seedance-2.0-fast');
    expect(settings.outputDir).toBe('custom-out');
    expect(settings.concurrency?.clips).toBe(1);
  });

  it('strips sensitive keys from a trusted project layer', () => {
    writeJson(join(cwd, '.pi', 'settings.json'), {
      'pi-video-gen': {
        defaultModel: 'seedance-2.0-fast',
        providers: { ark: { apiKey: 'stolen', baseUrl: 'https://evil.example' } },
        ffmpegPath: '/tmp/evil-ffmpeg',
      },
    });
    const settings = loadVideoGenSettings(cwd, true);
    expect(settings.defaultModel).toBe('seedance-2.0-fast');
    expect(settings.providers?.ark?.apiKey).toBeUndefined();
    expect(settings.ffmpegPath).toBeUndefined();
  });

  it('applies global-layer providers with env interpolation', () => {
    vi.stubEnv('ARK_TEST_KEY', 'ark-secret');
    // Build the literal ${...} at runtime so no template-curly appears in source.
    const keyRef = '$' + '{ARK_TEST_KEY}';
    writeJson(join(home, '.pi', 'agent', 'settings.json'), {
      'pi-video-gen': {
        providers: { ark: { apiKey: keyRef } },
        ffmpegPath: '/opt/ffmpeg',
      },
    });
    const settings = loadVideoGenSettings(cwd, false);
    expect(settings.providers?.ark?.apiKey).toBe('ark-secret');
    expect(settings.ffmpegPath).toBe('/opt/ffmpeg');
  });

  it('does not expand env vars in the trusted project layer', () => {
    vi.stubEnv('ARK_TEST_KEY', 'ark-secret');
    writeJson(join(cwd, '.pi', 'settings.json'), {
      'pi-video-gen': { outputDir: `${'${'}ARK_TEST_KEY}-out` },
    });
    const settings = loadVideoGenSettings(cwd, true);
    expect(settings.outputDir).toBe(`${'${'}ARK_TEST_KEY}-out`);
  });

  it('strips customProviders from a trusted project layer', () => {
    writeJson(join(cwd, '.pi', 'settings.json'), {
      'pi-video-gen': {
        defaultModel: 'evil-model',
        customProviders: {
          evil: { api: 'ark', baseUrl: 'https://evil.example', models: ['evil-model'] },
        },
      },
    });
    const settings = loadVideoGenSettings(cwd, true);
    expect(settings.customProviders).toBeUndefined();
    // defaultModel is whitelisted, but the custom model it points to does not resolve
    expect(resolveModel(settings)).toBeNull();
  });

  it('project whitelist keys override global ones when trusted', () => {
    writeJson(join(home, '.pi', 'agent', 'settings.json'), {
      'pi-video-gen': { defaultModel: 'seedance-2.0-mini' },
    });
    writeJson(join(cwd, '.pi', 'settings.json'), {
      'pi-video-gen': { defaultModel: 'seedance-2.0-fast' },
    });
    expect(loadVideoGenSettings(cwd, true).defaultModel).toBe('seedance-2.0-fast');
    expect(loadVideoGenSettings(cwd, false).defaultModel).toBe('seedance-2.0-mini');
  });
});

describe('config validation & loud project read', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = join(suiteDir, `proj-${Math.random().toString(36).slice(2, 8)}`);
    home = join(suiteDir, `home-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('PI_AGENT_HOME', join(home, '.pi', 'agent'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(home, '.pi', 'agent'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('loadVideoGenSettings fails clearly on malformed customProviders entries', () => {
    writeJson(join(home, '.pi', 'agent', 'settings.json'), {
      'pi-video-gen': { customProviders: { bad: null } },
    });
    expect(() => loadVideoGenSettings(cwd, false)).toThrow(/customProviders.bad must be an object/);

    writeJson(join(home, '.pi', 'agent', 'settings.json'), {
      'pi-video-gen': { customProviders: { bad: { api: 'not-a-format', models: [] } } },
    });
    expect(() => loadVideoGenSettings(cwd, false)).toThrow(
      /customProviders.bad.api must be one of/,
    );
  });

  it('fails closed on corrupted trusted project settings', () => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'settings.json'), '{corrupted');
    expect(() => loadVideoGenSettings(cwd, true)).toThrow(/project settings/i);
  });

  it.each([
    ['defaultModel', { defaultModel: 42 }],
    ['outputDir', { outputDir: [] }],
    ['ffmpegPath', { ffmpegPath: false }],
    ['providers', { providers: [] }],
    ['providers.ark.apiKey', { providers: { ark: { apiKey: 42 } } }],
    ['providers.ark.baseUrl', { providers: { ark: { baseUrl: true } } }],
    ['customProviders.bad.baseUrl', { customProviders: { bad: { api: 'ark', baseUrl: 7 } } }],
    [
      'customProviders.bad.models[0].id',
      {
        customProviders: { bad: { api: 'ark', models: [{}] } },
      },
    ],
    [
      'customProviders.bad.models[0].alias',
      {
        customProviders: { bad: { api: 'ark', models: [{ id: 'm', alias: 7 }] } },
      },
    ],
    [
      'customProviders.bad.models[0].capabilities.durations',
      {
        customProviders: {
          bad: { api: 'ark', models: [{ id: 'm', capabilities: { durations: [4] } }] },
        },
      },
    ],
    [
      'customProviders.bad.models[0].capabilities.referenceAssetModalities',
      {
        customProviders: {
          bad: {
            api: 'ark',
            models: [
              { id: 'm', capabilities: { referenceAssetModalities: ['image', 'document'] } },
            ],
          },
        },
      },
    ],
    [
      'customProviders.bad.models[0].capabilities.maxReferenceVideos',
      {
        customProviders: {
          bad: {
            api: 'ark',
            models: [{ id: 'm', capabilities: { maxReferenceVideos: -1 } }],
          },
        },
      },
    ],
    [
      'customProviders.bad.models[0].defaultDurationSec',
      {
        customProviders: { bad: { api: 'ark', models: [{ id: 'm', defaultDurationSec: 1.5 }] } },
      },
    ],
  ])('rejects invalid %s before model resolution', (path, section) => {
    writeJson(join(home, '.pi', 'agent', 'settings.json'), {
      'pi-video-gen': section,
    });
    expect(() => loadVideoGenSettings(cwd, false)).toThrow(path);
  });
});

describe('resolveModel', () => {
  it('defaults to the seedance 2.0 standard model and ark default base url', () => {
    const resolved = resolveModel({});
    expect(resolved?.entry.id).toBe('doubao-seedance-2-0-260128');
    expect(resolved?.provider.style).toBe('ark');
    expect(resolved?.provider.baseUrl).toContain('volces.com');
  });

  it('resolves aliases case-insensitively', () => {
    expect(resolveModel({}, 'Seedance-2.0-FAST')?.entry.id).toBe('doubao-seedance-2-0-fast-260128');
  });

  it('returns null for unknown models', () => {
    expect(resolveModel({}, 'no-such-model')).toBeNull();
  });

  it('honors provider overrides from settings', () => {
    const resolved = resolveModel({
      providers: { ark: { apiKey: 'k', baseUrl: 'https://proxy.example/v3' } },
    });
    expect(resolved?.provider.apiKey).toBe('k');
    expect(resolved?.provider.baseUrl).toBe('https://proxy.example/v3');
  });

  it('resolves newapi custom models only with an explicit baseUrl', () => {
    const resolved = resolveModel(
      {
        customProviders: {
          relay: {
            api: 'newapi',
            baseUrl: 'https://newapi.example.com',
            apiKey: 'k',
            models: ['kling-v1'],
          },
        },
      },
      'kling-v1',
    );
    expect(resolved?.provider.style).toBe('newapi');
    expect(resolved?.provider.baseUrl).toBe('https://newapi.example.com');
  });

  it('fails clearly when a newapi custom provider has no baseUrl', () => {
    expect(() =>
      resolveModel(
        { customProviders: { relay: { api: 'newapi', apiKey: 'k', models: ['kling-v1'] } } },
        'kling-v1',
      ),
    ).toThrow(/customProviders.relay.baseUrl/);
    expect(() => resolveProvider({ providers: { newapi: { apiKey: 'k' } } }, 'newapi')).toThrow(
      /providers.newapi.baseUrl/,
    );
  });

  it('custom models with unknown ids get conservative capabilities', () => {
    const resolved = resolveModel(
      {
        customProviders: {
          myproxy: { api: 'ark', baseUrl: 'https://proxy.example/v3', models: ['mystery-9'] },
        },
      },
      'mystery-9',
    );
    expect(resolved?.entry.capabilities).toMatchObject({
      maxReferenceImages: 1,
      resolutions: ['720p'],
      aspectRatios: ['16:9'],
      nativeAudio: false,
      supportsFirstLastFrame: false,
    });
    expect(resolved?.entry.defaultResolution).toBe('720p');
  });

  it('custom models inherit built-in capabilities when the id names a known model', () => {
    const resolved = resolveModel(
      {
        customProviders: {
          relay: {
            api: 'minimax',
            baseUrl: 'https://relay.example',
            apiKey: 'k',
            models: [{ id: 'MiniMax-H3', alias: 'h3-relay' }],
          },
        },
      },
      'h3-relay',
    );
    // No capabilities declared: the registry's H3 contract applies (768P/2K,
    // flf, 4-15s) instead of the conservative 720p/16:9 fallback, while the
    // relay keeps its own wire format, endpoint and remote id.
    expect(resolved?.provider.style).toBe('minimax');
    expect(resolved?.provider.baseUrl).toBe('https://relay.example');
    expect(resolved?.remoteId).toBe('MiniMax-H3');
    expect(resolved?.entry.capabilities.resolutions).toEqual(['768P', '2K']);
    expect(resolved?.entry.capabilities.supportsFirstLastFrame).toBe(true);
    expect(resolved?.entry.defaultResolution).toBe('768P');
    expect(resolved?.entry.defaultAspectRatio).toBe('16:9');
    expect(resolved?.entry.defaultDurationSec).toBe(5);
  });

  it('explicit custom capabilities/defaults override the inherited ones per field', () => {
    const resolved = resolveModel(
      {
        customProviders: {
          relay: {
            api: 'minimax',
            baseUrl: 'https://relay.example',
            models: [
              {
                id: 'MiniMax-H3',
                alias: 'h3x',
                capabilities: {
                  resolutions: ['768P'],
                  referenceAssetModalities: ['image', 'audio'],
                },
                defaultDurationSec: 10,
              },
            ],
          },
        },
      },
      'h3x',
    );
    // Overridden field wins; untouched fields keep the built-in values; the
    // built-in 2K default is skipped because the override dropped it.
    expect(resolved?.entry.capabilities.resolutions).toEqual(['768P']);
    expect(resolved?.entry.capabilities.aspectRatios).toContain('21:9');
    expect(resolved?.entry.capabilities.referenceAssetModalities).toEqual(['image', 'audio']);
    expect(resolved?.entry.defaultResolution).toBe('768P');
    expect(resolved?.entry.defaultDurationSec).toBe(10);
  });
});

describe('listModelRegistry', () => {
  it('marks key readiness per provider', () => {
    const info = listModelRegistry({ providers: { ark: { apiKey: 'k' } } });
    expect(info.activeResolved).toBe(true);
    expect(info.models.filter((m) => m.provider === 'ark').every((m) => m.keyReady)).toBe(true);
    expect(info.models.filter((m) => m.provider === 'dashscope').every((m) => !m.keyReady)).toBe(
      true,
    );
    expect(info.models).toHaveLength(9);
  });

  it('includes custom provider models in the registry view', () => {
    const info = listModelRegistry({
      defaultModel: 'em',
      customProviders: {
        myproxy: { api: 'ark', apiKey: 'k', models: [{ id: 'm1', alias: 'em' }, 'm2'] },
      },
    });
    const customs = info.models.filter((m) => m.provider.includes('myproxy'));
    expect(customs).toHaveLength(2);
    expect(customs[0]).toMatchObject({ id: 'm1', aliases: ['em'], keyReady: true });
    expect(info).toMatchObject({ activeId: 'm1', activeResolved: true });
  });
});

describe('resolveOutputDir', () => {
  it('defaults to <cwd>/.video-gen and honors override', () => {
    expect(resolveOutputDir({}, '/x')).toBe('/x/.video-gen');
    expect(resolveOutputDir({ outputDir: 'out' }, '/x')).toBe('/x/out');
  });
});
