import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { loadChannelConfig, updateLocalChannelConfig } from '../config.js';

describe('loadChannelConfig', () => {
  let base: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = join(
      tmpdir(),
      `pi-channels-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    originalEnv = { ...process.env };
    process.env.PI_CODING_AGENT_DIR = join(base, 'agent');
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses to overwrite existing malformed settings during an update', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    const file = join(project, '.pi', 'settings.json');
    const original = '{"other-extension":{"keep":true}, "unfinished":';
    writeFileSync(file, original);
    expect(() => updateLocalChannelConfig(project, () => ({ adapters: {} }), true)).toThrow(
      /settings/i,
    );
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  test('loads project settings from an ancestor .pi directory', () => {
    const project = join(base, 'project');
    const workspace = join(project, 'workspace');
    mkdirSync(join(project, '.pi'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-channels': {
          adapters: {
            feishu: { type: 'feishu', appId: 'cli_test', appSecret: 'secret' },
          },
          routes: {
            ops: { adapter: 'feishu', recipient: 'oc_test' },
          },
          bridge: { enabled: true },
        },
      }),
    );

    const config = loadChannelConfig(workspace, true);

    expect(Object.keys(config.adapters ?? {})).toEqual(['feishu']);
    expect(config.routes?.ops).toEqual({ adapter: 'feishu', recipient: 'oc_test' });
    expect(config.bridge?.enabled).toBe(true);
  });

  test('loads settings from PI_AGENT_HOME', () => {
    const piHome = join(base, '.pi');
    const workspace = join(base, 'workspace');
    mkdirSync(piHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PI_AGENT_HOME = piHome;
    writeFileSync(
      join(piHome, 'settings.json'),
      JSON.stringify({
        'pi-channels': {
          adapters: {
            webhook: { type: 'webhook' },
          },
          routes: {
            ops: { adapter: 'webhook', recipient: 'https://example.test/hook' },
          },
        },
      }),
    );

    const config = loadChannelConfig(workspace);

    expect(Object.keys(config.adapters ?? {})).toEqual(['webhook']);
    expect(config.routes?.ops).toEqual({
      adapter: 'webhook',
      recipient: 'https://example.test/hook',
    });
  });

  test('updates agent settings when no project settings file exists', () => {
    const workspace = join(base, 'workspace');
    const agentSettings = join(base, 'agent', 'settings.json');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(base, 'agent'), { recursive: true });
    writeFileSync(
      agentSettings,
      JSON.stringify({
        'pi-channels': {
          routes: {
            ops: { adapter: 'webhook', recipient: '' },
          },
        },
      }),
    );

    const updated = updateLocalChannelConfig(
      workspace,
      (config) => ({
        ...config,
        routes: {
          ...config.routes,
          ops: { adapter: 'webhook', recipient: 'https://example.test/hook' },
        },
      }),
      true,
    );

    expect(updated).toBe(true);
    expect(JSON.parse(readFileSync(agentSettings, 'utf-8'))).toMatchObject({
      'pi-channels': {
        routes: {
          ops: { adapter: 'webhook', recipient: 'https://example.test/hook' },
        },
      },
    });
  });
});
