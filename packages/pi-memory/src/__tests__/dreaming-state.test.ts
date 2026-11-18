import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockedHome: string;

const crash = vi.hoisted(() => ({
  enabled: false,
  wrap:
    (write: (...args: any[]) => Promise<void>) =>
    async (file: string, data: string, options?: unknown) => {
      if (!crash.enabled) return write(file, data, options);
      await write(file, String(data).slice(0, 5), options);
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises');
  const writeFile = crash.wrap(actual.writeFile as never);
  return { ...actual, default: { ...actual, writeFile }, writeFile };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  const promises = {
    ...actual.promises,
    writeFile: crash.wrap(actual.promises.writeFile as never),
  };
  return { ...actual, default: { ...actual, promises }, promises };
});

vi.mock('@amaster.ai/pi-shared/settings', () => ({
  resolveHome: () => mockedHome,
}));

describe('dreaming-state', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-dreaming-state-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mockedHome = tempDir;
  });

  afterEach(() => {
    crash.enabled = false;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps the previous checkpoint readable when a write is interrupted', async () => {
    const { readDreamingState, writeDreamingState } = await import('../dreaming-state.js');
    const previous = { lastConsolidatedAt: '2026-06-20T10:00:00.000Z', lastSessionCount: 7 };
    await writeDreamingState(previous);

    crash.enabled = true;
    await expect(
      writeDreamingState({ lastConsolidatedAt: '2026-06-21T10:00:00.000Z', lastSessionCount: 9 }),
    ).rejects.toThrow('ENOSPC');
    crash.enabled = false;

    await expect(readDreamingState()).resolves.toEqual(previous);
  });

  it('readDreamingState returns defaults when file does not exist', async () => {
    const { readDreamingState } = await import('../dreaming-state.js');
    const state = await readDreamingState();
    expect(state).toEqual({ lastConsolidatedAt: null, lastSessionCount: 0 });
  });

  it('writeDreamingState creates file and readDreamingState reads it back', async () => {
    const { readDreamingState, writeDreamingState } = await import('../dreaming-state.js');

    await writeDreamingState({
      lastConsolidatedAt: '2026-06-20T10:00:00.000Z',
      lastSessionCount: 7,
    });

    const state = await readDreamingState();
    expect(state.lastConsolidatedAt).toBe('2026-06-20T10:00:00.000Z');
    expect(state.lastSessionCount).toBe(7);
  });

  it('writeDreamingState creates directories if needed', async () => {
    mockedHome = join(tempDir, 'nested', 'deep');
    const { writeDreamingState } = await import('../dreaming-state.js');

    await writeDreamingState({
      lastConsolidatedAt: '2026-06-20T10:00:00.000Z',
      lastSessionCount: 3,
    });

    const filePath = join(mockedHome, 'memories', 'dreaming-state.json');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.lastConsolidatedAt).toBe('2026-06-20T10:00:00.000Z');
  });

  it.each([
    'not json',
    '{}',
    'null',
    '{"lastConsolidatedAt":null,"lastSessionCount":0,"scanCursor":{}}',
  ])('readDreamingState refuses to reset a malformed checkpoint: %s', async (raw) => {
    const { readDreamingState } = await import('../dreaming-state.js');
    const memoriesDir = join(tempDir, 'memories');
    mkdirSync(memoriesDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(memoriesDir, 'dreaming-state.json'), raw, 'utf-8');

    await expect(readDreamingState()).rejects.toThrow(/checkpoint/i);
  });
});
