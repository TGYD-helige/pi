import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import memoryExtension from '../extension.js';
import { MEMORY_GUIDANCE } from '../guidance.js';
import { MemoryStore } from '../store.js';

const TEST_ROOT = path.join(tmpdir(), 'pi-memory-command-test');

function freshDir(): string {
  const dir = path.join(TEST_ROOT, `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => mkdirSync(TEST_ROOT, { recursive: true }));
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

/**
 * Creates a mock ExtensionAPI and runs the extension to capture the registered
 * command handler. Returns a helper to invoke the command with args.
 */
async function setupCommand(dir: string) {
  const store = new MemoryStore({ dir });
  await store.loadFromDisk();

  const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const registeredTools: unknown[] = [];
  const eventHandlers: Record<
    string,
    Array<(event: unknown, ctx: unknown) => Promise<unknown>>
  > = {};

  const notify = vi.fn();
  const ctx = {
    cwd: dir,
    ui: { notify, setStatus: vi.fn() },
    modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
    sessionManager: {},
  };

  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    },
    registerTool: (tool: unknown) => registeredTools.push(tool),
    registerCommand: (
      name: string,
      opts: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      handlers[name] = opts.handler;
    },
  };

  memoryExtension(pi as never, { store, dataDir: dir });

  // Trigger session_start to initialize the store and register commands
  for (const handler of eventHandlers.session_start ?? []) {
    await handler({}, ctx);
  }

  async function runCommand(args: string) {
    notify.mockClear();
    await handlers.memory!(args, ctx);
    return notify;
  }

  return { store, runCommand, notify, eventHandlers, ctx };
}

// ---------------------------------------------------------------------------
// prompt snapshot
// ---------------------------------------------------------------------------

describe('prompt snapshot', () => {
  it('refreshes from disk before each agent run', async () => {
    const dir = freshDir();
    const { eventHandlers, ctx } = await setupCommand(dir);

    writeFileSync(path.join(dir, 'MEMORY.md'), 'late memory fact', 'utf-8');

    const result = await eventHandlers.before_agent_start?.[0]?.(
      { systemPrompt: 'base prompt' },
      ctx,
    );

    expect(result).toEqual({
      systemPrompt: expect.stringContaining('late memory fact'),
    });
    expect(result).toEqual({ systemPrompt: expect.stringContaining(MEMORY_GUIDANCE) });
    const withToolGuidance = await eventHandlers.before_agent_start?.[0]?.(
      { systemPrompt: MEMORY_GUIDANCE },
      ctx,
    );
    expect(withToolGuidance).toEqual({ systemPrompt: expect.stringContaining('late memory fact') });
    expect(
      (withToolGuidance as { systemPrompt: string }).systemPrompt.split(MEMORY_GUIDANCE),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// /memory status
// ---------------------------------------------------------------------------

describe('/memory status', () => {
  it('shows entry counts and usage for both stores', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('memory', 'project uses vitest');
    await store.add('user', 'prefers dark mode');

    const notify = await runCommand('status');

    expect(notify).toHaveBeenCalledOnce();
    const msg = String(notify.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('MEMORY.md: 1 entries');
    expect(msg).toContain('USER.md: 1 entries');
  });

  it('defaults to status when no subcommand given', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('MEMORY.md'), 'info');
  });
});

// ---------------------------------------------------------------------------
// /memory read
// ---------------------------------------------------------------------------

describe('/memory read', () => {
  it('shows entries numbered', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('memory', 'fact one');
    await store.add('memory', 'fact two');

    const notify = await runCommand('read');

    const msg = String(notify.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('1. fact one');
    expect(msg).toContain('2. fact two');
  });

  it('reads user target when specified', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('user', 'user likes cats');

    const notify = await runCommand('read user');

    const msg = String(notify.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('1. user likes cats');
  });

  it('shows empty message when no entries', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('read');
    expect(notify).toHaveBeenCalledWith('memory: (empty)', 'info');
  });
});

// ---------------------------------------------------------------------------
// /memory add
// ---------------------------------------------------------------------------

describe('/memory add', () => {
  it('adds to memory by default', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);

    const notify = await runCommand('add project uses pnpm');

    expect(notify).toHaveBeenCalledWith('Added to memory.', 'info');
    expect(store.getEntries('memory')).toContain('project uses pnpm');
  });

  it('adds to user when target specified', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);

    await runCommand('add user prefers TypeScript');

    expect(store.getEntries('user')).toContain('prefers TypeScript');
  });

  it('adds to memory target explicitly', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);

    await runCommand('add memory runs on macOS');

    expect(store.getEntries('memory')).toContain('runs on macOS');
  });

  it('shows usage warning when no content provided', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('add');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });

  it('shows usage warning when target given but no content', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('add user');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });
});

// ---------------------------------------------------------------------------
// /memory replace
// ---------------------------------------------------------------------------

describe('/memory replace', () => {
  it('replaces matching entry', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('memory', 'timezone UTC+8');

    const notify = await runCommand('replace UTC+8 -> timezone UTC+9');

    expect(notify).toHaveBeenCalledWith('Replaced in memory.', 'info');
    expect(store.getEntries('memory')).toContain('timezone UTC+9');
    expect(store.getEntries('memory')).not.toContain('timezone UTC+8');
  });

  it('replaces in user target', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('user', 'name: Alice');

    await runCommand('replace user Alice -> name: Bob');

    expect(store.getEntries('user')).toContain('name: Bob');
  });

  it('shows usage when no -> separator', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('replace old text new text');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });

  it('shows usage when args empty', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('replace');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });

  it('reports failure when no match found', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('replace nonexistent -> something');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed:'), 'warning');
  });
});

// ---------------------------------------------------------------------------
// /memory remove
// ---------------------------------------------------------------------------

describe('/memory remove', () => {
  it('removes matching entry', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('memory', 'old fact');

    const notify = await runCommand('remove old fact');

    expect(notify).toHaveBeenCalledWith('Removed from memory.', 'info');
    expect(store.getEntries('memory')).toEqual([]);
  });

  it('removes from user target', async () => {
    const dir = freshDir();
    const { store, runCommand } = await setupCommand(dir);
    await store.add('user', 'stale preference');

    await runCommand('remove user stale');

    expect(store.getEntries('user')).toEqual([]);
  });

  it('shows usage when no substring provided', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('remove');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });

  it('reports failure when no match found', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('remove nonexistent');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed:'), 'warning');
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe('/memory unknown', () => {
  it('shows available subcommands', async () => {
    const { runCommand } = await setupCommand(freshDir());
    const notify = await runCommand('foobar');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Unknown subcommand'), 'warning');
  });
});
