import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonFile, writeJsonFile } from '../json-file.js';

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});

const tmpDirs: string[] = [];

describe('json-file', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes through a temp file and keeps the latest valid backup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-json-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'state.json');

    await writeJsonFile(filePath, [{ id: 'first' }]);
    await writeJsonFile(filePath, [{ id: 'second' }]);

    await expect(readJsonFile(filePath, [])).resolves.toEqual([{ id: 'second' }]);
    await expect(readJsonFile(`${filePath}.bak`, [])).resolves.toEqual([{ id: 'first' }]);
    await expect(readFile(filePath, 'utf8')).resolves.toContain('\n');
  });

  it('recovers from a corrupt primary file using the backup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-json-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'state.json');

    await writeJsonFile(filePath, [{ id: 'stable' }]);
    await writeJsonFile(`${filePath}.bak`, [{ id: 'backup' }]);
    await writeFile(filePath, '[');

    await expect(readJsonFile(filePath, [])).resolves.toEqual([{ id: 'backup' }]);
  });

  it('keeps the recovered backup when a later write cannot replace the primary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-json-recovery-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'state.json');
    await writeFile(file, '{broken');
    await writeFile(`${file}.bak`, '[{"id":"last-good"}]');
    expect(await readJsonFile(file, [])).toEqual([{ id: 'last-good' }]);
    renameMock.mockRejectedValueOnce(
      Object.assign(new Error('injected write error'), { code: 'EIO' }),
    );
    await expect(writeJsonFile(file, [{ id: 'new' }])).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual([{ id: 'last-good' }]);
    expect(await readJsonFile(file, [])).toEqual([{ id: 'last-good' }]);
  });

  it('refuses to initialize empty data when corrupt primary has no backup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-json-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'state.json');

    await writeFile(filePath, '[');

    await expect(readJsonFile(filePath, [{ id: 'fallback' }])).rejects.toThrow(/backup/i);
    expect(await readFile(filePath, 'utf8')).toBe('[');
  });
});
