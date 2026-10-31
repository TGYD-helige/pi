import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialMaskValues, loadConfigFromFile, resolveConfig } from '../config.js';
import { resolveLangfuseExporterConfig } from '../langfuse/config.js';
import { resolveOtelExporterConfig } from '../otel.js';
import { parseBoolean } from '../parse.js';

describe('config', () => {
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
