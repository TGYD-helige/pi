import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLarkConfig } from '../config.js';

describe('loadLarkConfig', () => {
  let base: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = join(tmpdir(), `pi-lark-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    originalEnv = { ...process.env };
    process.env.PI_CODING_AGENT_DIR = join(base, 'agent');
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('returns undefined when no config exists', () => {
    mkdirSync(join(base, 'project'), { recursive: true });
    const config = loadLarkConfig(join(base, 'project'));
    expect(config).toBeUndefined();
  });

  it('loads config from .pi/settings.json', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-lark': {
          appId: 'cli_test123',
          appSecret: 'secret456',
          domain: 'feishu',
        },
      }),
    );

    const config = loadLarkConfig(project, true);

    expect(config).toEqual({
      appId: 'cli_test123',
      appSecret: 'secret456',
      domain: 'feishu',
    });
  });

  it('returns undefined when appId and appSecret are both empty', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-lark': { domain: 'feishu' },
      }),
    );

    const config = loadLarkConfig(project, true);
    expect(config).toBeUndefined();
  });
});
