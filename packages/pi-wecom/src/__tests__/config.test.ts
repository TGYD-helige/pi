import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWeComConfig } from '../config.js';

describe('loadWeComConfig', () => {
  let base: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = join(tmpdir(), `pi-wecom-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    const config = loadWeComConfig(join(base, 'project'));
    expect(config).toBeUndefined();
  });

  it('loads config from .pi/settings.json', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-wecom': {
          botId: 'bot_abc123',
          botSecret: 'secret456',
        },
      }),
    );

    const config = loadWeComConfig(project, true);

    expect(config).toEqual({
      botId: 'bot_abc123',
      botSecret: 'secret456',
    });
  });

  it('returns undefined when botId and botSecret are both empty', () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-wecom': {},
      }),
    );

    const config = loadWeComConfig(project, true);
    expect(config).toBeUndefined();
  });
});
