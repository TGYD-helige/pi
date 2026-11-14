import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialMaskValues, loadConfigFromFile, resolveConfig } from '../config.js';
import { resolveLangfuseExporterConfig } from '../langfuse/config.js';
import { resolveOtelExporterConfig, resolvePhoenixExporterConfig } from '../otel.js';
import { parseBoolean } from '../parse.js';

describe('config', () => {
  it('resolves payload limits consistently for every backend', () => {
    for (const resolve of [
      resolveLangfuseExporterConfig,
      resolveOtelExporterConfig,
      resolvePhoenixExporterConfig,
    ]) {
      expect(resolve({})).toMatchObject({ maxAttributeBytes: 1_000_000, previewBytes: 256_000 });
      expect(resolve({ maxAttributeBytes: 2_000_000, previewBytes: 512_000 })).toMatchObject({
        maxAttributeBytes: 2_000_000,
        previewBytes: 512_000,
      });
      expect(
        resolve(JSON.parse('{"maxAttributeBytes":"2000000","previewBytes":"512000"}')),
      ).toMatchObject({
        maxAttributeBytes: 2_000_000,
        previewBytes: 512_000,
      });
      for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_VALUE]) {
        expect(resolve({ previewBytes: invalid })).toMatchObject({ previewBytes: 256_000 });
      }
      for (const invalid of [0, -1, 1.5, 127, NaN, Infinity, Number.MAX_VALUE]) {
        expect(resolve({ maxAttributeBytes: invalid, previewBytes: 0 })).toMatchObject({
          maxAttributeBytes: 1_000_000,
          previewBytes: 256_000,
        });
      }
    }
  });

  it('bounds examined tag candidates and stops after retaining the supported tags', () => {
    const readLate = vi.fn(() => 'late');
    const tags = Array.from({ length: 10_000 }, (_, index) => `tag-${index}`);
    Object.defineProperty(tags, 9999, { get: readLate });
    expect(resolveOtelExporterConfig({ tags }).tags).toHaveLength(32);
    const duplicates = Array.from({ length: 10_000 }, () => 'tag');
    Object.defineProperty(duplicates, 9999, { get: readLate });
    expect(resolveOtelExporterConfig({ tags: duplicates }).tags).toEqual(['tag']);
    expect(readLate).not.toHaveBeenCalled();
  });

  it('validates and forwards optional tags, trace name and field redaction to every backend', () => {
    const config = {
      tags: [' batch ', 'batch', '', 1] as any,
      traceName: ' task ',
      redactFields: [' password ', 'password'],
    };
    for (const resolve of [
      resolveLangfuseExporterConfig,
      resolveOtelExporterConfig,
      resolvePhoenixExporterConfig,
    ]) {
      expect(resolve(config)).toMatchObject({
        tags: ['batch'],
        traceName: 'task',
        redactFields: ['password'],
      });
      expect(resolve({ tags: 'bad' as any, redactFields: null as any })).toMatchObject({
        tags: [],
        redactFields: [],
      });
    }
  });

  it('only enables media when content export is explicitly enabled', () => {
    expect(resolveConfig({ mediaUploadEnabled: true })).toMatchObject({
      includePayloads: false,
      mediaUploadEnabled: false,
    });
    expect(resolveConfig({ includePayloads: true, mediaUploadEnabled: true })).toMatchObject({
      mediaUploadEnabled: true,
    });
    expect(resolveConfig({ includePayloads: true })).toMatchObject({ mediaUploadEnabled: false });
  });

  it('masks normalized credentials and their authorization header', () => {
    expect(
      credentialMaskValues({ langfuse: { publicKey: ' pk-test ', secretKey: ' sk-test ' } }),
    ).toEqual(
      expect.arrayContaining([
        ' pk-test ',
        ' sk-test ',
        'pk-test',
        'sk-test',
        Buffer.from('pk-test:sk-test').toString('base64'),
      ]),
    );
  });

  it('excludes payloads by default', () => {
    expect(resolveConfig()).toMatchObject({
      includePayloads: false,
    });
  });

  it('ignores whitespace-only Phoenix API keys when masking', () => {
    expect(credentialMaskValues({ phoenix: { apiKey: ' \n\t ' } })).toEqual([]);
  });

  it('uses PHOENIX_PROJECT_NAME as a fallback below settings', () => {
    const env = { PHOENIX_PROJECT_NAME: 'env-project' };
    expect(resolvePhoenixExporterConfig({ phoenix: { enabled: true } }, env).projectName).toBe(
      'env-project',
    );
    expect(
      resolvePhoenixExporterConfig(
        { phoenix: { enabled: true, projectName: 'settings-project' } },
        env,
      ).projectName,
    ).toBe('settings-project');
    expect(resolvePhoenixExporterConfig({ phoenix: { enabled: true } }, {}).projectName).toBe(
      undefined,
    );
  });

  it('resolves Phoenix settings and masks its API key', () => {
    const config = {
      phoenix: {
        enabled: true,
        endpoint: ' https://phoenix.example.com/ ',
        apiKey: ' phoenix-secret ',
        projectName: ' agent-runs ',
        flushAt: 0,
        flushIntervalMs: 250,
      },
    };
    expect(resolvePhoenixExporterConfig(config)).toMatchObject({
      enabled: true,
      endpoint: 'https://phoenix.example.com',
      apiKey: 'phoenix-secret',
      projectName: 'agent-runs',
      flushAt: 20,
      flushIntervalMs: 250,
      includePayloads: false,
    });
    expect(credentialMaskValues(config)).toEqual(
      expect.arrayContaining([' phoenix-secret ', 'phoenix-secret']),
    );
    expect(resolvePhoenixExporterConfig({ phoenix: { enabled: true } }).endpoint).toBe(
      'http://localhost:6006',
    );
    expect(
      resolvePhoenixExporterConfig({ phoenix: { enabled: true, endpoint: ' ' } }),
    ).toMatchObject({ enabled: false, configurationWarnings: ['Phoenix endpoint is blank'] });
  });
});

describe('interpolated telemetry settings', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-telemetry-config-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function load(
    langfuse: Record<string, unknown>,
    includePayloads: unknown = false,
    mediaUploadEnabled: unknown = false,
  ) {
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        'pi-telemetry': {
          langfuse: { enabled: true, publicKey: ' pk-test ', secretKey: ' sk-test ', ...langfuse },
          otel: { enabled: '$PI_TELEMETRY_TEST_ENABLED', endpoint: 'https://otel.example.com' },
          includePayloads,
          mediaUploadEnabled,
        },
      }),
    );
    return resolveConfig(loadConfigFromFile({ configDir: root, cwd: root, projectTrusted: false }));
  }

  it.each([
    'false',
    '0',
    'no',
    '',
  ])('does not enable exporters for interpolated %j', async (value) => {
    vi.stubEnv('PI_TELEMETRY_TEST_ENABLED', value);
    const config = await load({ enabled: '$PI_TELEMETRY_TEST_ENABLED' });
    expect(resolveLangfuseExporterConfig(config).enabled).toBe(false);
    expect(resolveOtelExporterConfig(config).enabled).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes'])('normalizes interpolated opt-ins (%s)', async (value) => {
    vi.stubEnv('PI_TELEMETRY_TEST_ENABLED', value);
    const config = await load(
      { enabled: '$PI_TELEMETRY_TEST_ENABLED' },
      '$PI_TELEMETRY_TEST_ENABLED',
      '$PI_TELEMETRY_TEST_ENABLED',
    );
    expect(config).toMatchObject({ includePayloads: true, mediaUploadEnabled: true });
    expect(resolveLangfuseExporterConfig(config)).toMatchObject({
      enabled: true,
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      includePayloads: true,
      mediaUploadEnabled: true,
    });
    expect(resolveOtelExporterConfig(config).enabled).toBe(true);
  });

  it.each([true, false])('preserves native boolean %s', async (value) => {
    const config = await load({ enabled: value }, value, value);
    expect(resolveLangfuseExporterConfig(config)).toMatchObject({
      enabled: value,
      includePayloads: value,
      mediaUploadEnabled: value,
    });
    expect(parseBoolean(value)).toBe(value);
  });

  it.each([
    { publicKey: ' ' },
    { secretKey: '\t' },
    { publicKey: '' },
    { secretKey: '' },
  ])('disables blank credentials (%j)', async (credentials) => {
    expect(resolveLangfuseExporterConfig(await load(credentials)).enabled).toBe(false);
  });

  it.each(['', '  '])('disables explicit blank interpolated URLs (%j)', async (value) => {
    vi.stubEnv('PI_TELEMETRY_TEST_URL', value);
    expect(
      resolveLangfuseExporterConfig(await load({ baseUrl: '$PI_TELEMETRY_TEST_URL' })).enabled,
    ).toBe(false);
  });

  it('defaults omitted URLs and trims explicit URLs', async () => {
    expect(resolveLangfuseExporterConfig(await load({}))).toMatchObject({
      enabled: true,
      baseUrl: 'https://cloud.langfuse.com',
    });
    expect(
      resolveLangfuseExporterConfig(await load({ baseUrl: ' https://langfuse.example.com ' }))
        .baseUrl,
    ).toBe('https://langfuse.example.com');
  });

  it('keeps media disabled when interpolated payload inclusion is false', async () => {
    vi.stubEnv('PI_TELEMETRY_TEST_ENABLED', 'false');
    const config = await load({}, '$PI_TELEMETRY_TEST_ENABLED', true);
    expect(config).toMatchObject({ includePayloads: false, mediaUploadEnabled: false });
    expect(resolveLangfuseExporterConfig(config).mediaUploadEnabled).toBe(false);
  });
});
