import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDingTalkConfig } from '../config.js';

describe('loadDingTalkConfig', () => {
  let base: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = join(
      tmpdir(),
      `pi-dingtalk-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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
    const config = loadDingTalkConfig(join(base, 'project'));
    expect(config).toBeUndefined();
  });

  it('loads config from .pi/settings.json', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-dingtalk': {
          clientId: 'dingabc123',
          clientSecret: 'secret456',
        },
      }),
    );

    const config = loadDingTalkConfig(project, true);

    expect(config).toEqual({
      clientId: 'dingabc123',
      clientSecret: 'secret456',
    });
  });

  it('returns undefined when clientId and clientSecret are both empty', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-dingtalk': {},
      }),
    );

    const config = loadDingTalkConfig(project, true);
    expect(config).toBeUndefined();
  });
});
