import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileArtifactStore } from '../artifact-stores.js';

const TEST_DIR = path.join(tmpdir(), 'pi-storage-artifact-stores-test');
const filePath = path.join(TEST_DIR, 'artifacts.json');

function artifact(id: string, overrides: Record<string, string> = {}) {
  return {
    id,
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    artifactType: 'file',
    storageUri: `file:///${id}`,
    ...overrides,
  } as Parameters<JsonFileArtifactStore['create']>[0];
}

describe('JsonFileArtifactStore', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('isolates reads and deletes by tenant and user', async () => {
    const store = new JsonFileArtifactStore(filePath);
    await store.create(artifact('a1'));
    expect(await store.get({ tenantId: 'tenant-2' }, 'a1')).toBeUndefined();
    expect(await store.get({ tenantId: 'tenant-1', userId: 'user-2' }, 'a1')).toBeUndefined();
    expect(await store.delete({ tenantId: 'tenant-2' }, 'a1')).toBe(false);
    expect((await store.get({ tenantId: 'tenant-1' }, 'a1'))?.storageUri).toBe('file:///a1');
    expect(await store.delete({ tenantId: 'tenant-1', userId: 'user-1' }, 'a1')).toBe(true);
    const reloaded = new JsonFileArtifactStore(filePath);
    expect(await reloaded.get({ tenantId: 'tenant-1' }, 'a1')).toBeUndefined();
  });

  it('filters lists and keeps the newest entries within the limit', async () => {
    const store = new JsonFileArtifactStore(filePath);
    await Promise.all([
      store.create(artifact('a1', { turnId: 't1' })),
      store.create(artifact('a2', { turnId: 't2' })),
      store.create(artifact('a3', { turnId: 't2', sessionId: 'session-2' })),
      store.create(artifact('a4', { tenantId: 'tenant-2' })),
    ]);
    const ids = async (input: Parameters<JsonFileArtifactStore['list']>[0]) =>
      (await store.list(input)).map((item) => item.id);

    expect(await ids({ tenantId: 'tenant-1' })).toEqual(['a1', 'a2', 'a3']);
    expect(await ids({ tenantId: 'tenant-1', turnId: 't2' })).toEqual(['a2', 'a3']);
    expect(await ids({ tenantId: 'tenant-1', sessionId: 'session-2' })).toEqual(['a3']);
    expect(await ids({ tenantId: 'tenant-1', limit: 2 })).toEqual(['a2', 'a3']);
  });
});
