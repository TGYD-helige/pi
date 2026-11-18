import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => any;

describe('piLarkExtension', () => {
  let base: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = join(tmpdir(), `pi-lark-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    originalEnv = { ...process.env };
    process.env.PI_CODING_AGENT_DIR = join(base, 'agent');
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(base, { recursive: true, force: true });
  });

  it('does not inject skills when config is missing', async () => {
    const handlers: Record<string, Handler> = {};
    const mockPi = {
      on: (event: string, handler: Handler) => {
        handlers[event] = handler;
      },
    };

    const { default: piLarkExtension } = await import('../index.js');
    piLarkExtension(mockPi as any);

    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });

    await handlers.session_start!(
      { type: 'session_start', reason: 'startup' },
      { cwd: project, ui: { notify: vi.fn(), setStatus: vi.fn() } },
    );

    const result = handlers.resources_discover!({
      type: 'resources_discover',
      cwd: project,
      reason: 'startup',
    });
    expect(result).toEqual({});
  });

  it('session_shutdown clears skillsDir', async () => {
    const handlers: Record<string, Handler> = {};
    const mockPi = {
      on: (event: string, handler: Handler) => {
        handlers[event] = handler;
      },
    };

    const { default: piLarkExtension } = await import('../index.js');
    piLarkExtension(mockPi as any);

    await handlers.session_shutdown!({ type: 'session_shutdown' }, {} as any);

    const result = handlers.resources_discover!({
      type: 'resources_discover',
      cwd: base,
      reason: 'startup',
    });
    expect(result).toEqual({});
  });
});
