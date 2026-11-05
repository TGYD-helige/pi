import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockedHome: string;

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
    rmSync(tempDir, { recursive: true, force: true });
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
