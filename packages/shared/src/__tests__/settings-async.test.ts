import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPiSettingsAsync } from '../settings.js';

let mockedHome: string;
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => mockedHome,
}));
const root = join(tmpdir(), 'pi-shared-settings-async');
const options = { cwd: root, configDir: join(root, 'config') };
describe('loadPiSettingsAsync', () => {
  beforeEach(async () => {
    mockedHome = root;
    await rm(root, { recursive: true, force: true });
    for (const dir of [join(root, '.pi', 'agent'), join(root, '.pi'), options.configDir])
      await mkdir(dir, { recursive: true });
    vi.stubEnv('PI_TEST_ASYNC_SETTING', 'expanded');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  it('preserves precedence and expands environment values only outside the project', async () => {
    const literal = '$' + '{PI_TEST_ASYNC_SETTING}';
    await writeFile(
      join(root, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ test: { source: 'global', env: literal } }),
    );
    await writeFile(
      join(options.configDir, 'settings.json'),
      JSON.stringify({ test: { source: 'config' } }),
    );
    await writeFile(
      join(root, '.pi', 'settings.json'),
      JSON.stringify({ test: { source: 'project', env: literal } }),
    );
    expect(await loadPiSettingsAsync('test', options)).toEqual({
      source: 'config',
      env: 'expanded',
    });
    expect(await loadPiSettingsAsync('test', { ...options, projectTrusted: true })).toEqual({
      source: 'project',
      env: literal,
    });
    await writeFile(
      join(options.configDir, 'settings.json'),
      JSON.stringify({ test: { source: 'changed' } }),
    );
    expect(await loadPiSettingsAsync('test', options)).toEqual({
      source: 'changed',
      env: 'expanded',
    });
  });
  it('rejects oversized or malformed inline configuration', async () => {
    const path = join(root, '.pi', 'settings.json');
    await writeFile(path, JSON.stringify({ test: { padding: 'x'.repeat(1024 * 1024) } }));
    await expect(loadPiSettingsAsync('test', { ...options, projectTrusted: true })).rejects.toThrow(
      /limit/,
    );
    await writeFile(path, '{invalid');
    await expect(
      loadPiSettingsAsync('test', { ...options, projectTrusted: true }),
    ).rejects.toThrow();
  });
});
