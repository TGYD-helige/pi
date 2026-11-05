import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readJsonFile, writeJsonFile } from '../json-file.js';

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});

describe('json-file', () => {
  it('preserves a recovered backup after the next primary replacement fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-scheduler-json-recovery-'));
    try {
      const file = path.join(dir, 'tasks.json');
      await writeFile(file, '{broken');
      await writeFile(`${file}.bak`, '[{"id":"last-good"}]');
      expect(await readJsonFile(file, [])).toEqual([{ id: 'last-good' }]);
      renameMock.mockRejectedValueOnce(
        Object.assign(new Error('injected write error'), { code: 'EIO' }),
      );
      await expect(writeJsonFile(file, [{ id: 'new' }])).rejects.toMatchObject({ code: 'EIO' });
      expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual([{ id: 'last-good' }]);
      expect(await readJsonFile(file, [])).toEqual([{ id: 'last-good' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
