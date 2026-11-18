import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => ({ fail: false }));

vi.mock('../json-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../json-file.js')>();
  return {
    ...actual,
    writeJsonFile: async (...args: Parameters<typeof actual.writeJsonFile>) => {
      if (writes.fail) throw new Error('disk full');
      return await actual.writeJsonFile(...args);
    },
  };
});

const { JsonFileSubagentRunStore } = await import('../subagent-store.js');

const TEST_DIR = path.join(tmpdir(), 'pi-storage-subagent-persistence-test');
const filePath = path.join(TEST_DIR, 'subagents.json');
const scope = { tenantId: 'tenant-1' };

describe('JsonFileSubagentRunStore persistence', () => {
  beforeEach(() => {
    writes.fail = false;
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('keeps reads on the persisted state when a write fails', async () => {
    const store = new JsonFileSubagentRunStore(filePath);
    const input = {
      parentSessionId: 'parent',
      childSessionId: 'child',
      task: 'summarize',
      depth: 1,
      model: { provider: 'test', model: 'test-model' },
      toolPolicyProfile: 'default',
    } as Parameters<typeof store.create>[0];
    const run = await store.create(input);

    writes.fail = true;
    await expect(store.markRunning(scope, run.runId)).rejects.toThrow('disk full');
    await expect(store.create({ ...input, childSessionId: 'child-2' })).rejects.toThrow(
      'disk full',
    );

    expect((await store.get(scope, run.runId))?.status).toBe('pending');
    expect(await store.countActiveChildren(scope, 'parent')).toBe(1);
    expect(await store.list(scope)).toHaveLength(1);

    writes.fail = false;
    await store.markRunning(scope, run.runId);
    const reloaded = new JsonFileSubagentRunStore(filePath);
    expect((await reloaded.get(scope, run.runId))?.status).toBe('running');
  });
});
