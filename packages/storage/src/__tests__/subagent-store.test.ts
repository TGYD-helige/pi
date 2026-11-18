import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileSubagentRunStore } from '../subagent-store.js';

const TEST_DIR = path.join(tmpdir(), 'pi-storage-subagent-store-test');
const filePath = path.join(TEST_DIR, 'subagents.json');
const scope = { tenantId: 'tenant-1' };

type CreateInput = Parameters<JsonFileSubagentRunStore['create']>[0];

function createInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    parentSessionId: 'parent',
    childSessionId: 'child',
    task: 'summarize',
    depth: 1,
    model: { provider: 'test', model: 'test-model' },
    toolPolicyProfile: 'default',
    ...overrides,
  } as CreateInput;
}

describe('JsonFileSubagentRunStore', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('records the run lifecycle and persists it across store instances', async () => {
    const store = new JsonFileSubagentRunStore(filePath);
    const run = await store.create(createInput());
    expect(run).toMatchObject({ status: 'pending', taskRunId: run.runId });
    await store.markRunning(scope, run.runId);
    await store.markFailed(scope, run.runId, 'first try failed');
    await store.markCompleted(scope, run.runId, 'done');

    const reloaded = await new JsonFileSubagentRunStore(filePath).get(scope, run.runId);
    expect(reloaded).toMatchObject({ status: 'completed', result: 'done' });
    expect(reloaded).not.toHaveProperty('error');
    expect(reloaded?.events.map((event) => event.type)).toEqual([
      'subagent_spawning',
      'subagent_spawned',
      'subagent_started',
      'subagent_ended',
      'subagent_ended',
    ]);
  });

  it('keeps cancelled and terminal runs from being overwritten', async () => {
    const store = new JsonFileSubagentRunStore(filePath);
    const cancelled = await store.create(createInput());
    await store.markCancelled(scope, cancelled.runId, 'user stopped');
    await store.markCompleted(scope, cancelled.runId, 'late result');
    await store.markFailed(scope, cancelled.runId, 'late error');
    expect(await store.get(scope, cancelled.runId)).toMatchObject({
      status: 'cancelled',
      error: 'user stopped',
    });

    const completed = await store.create(createInput({ childSessionId: 'child-2' }));
    await store.markCompleted(scope, completed.runId, 'done');
    await store.markCancelled(scope, completed.runId);
    expect((await store.get(scope, completed.runId))?.status).toBe('completed');
    expect(await store.markRunning(scope, 'missing')).toBeUndefined();
  });

  it('answers depth and active-child queries', async () => {
    const store = new JsonFileSubagentRunStore(filePath);
    const active = await store.create(createInput({ childSessionId: 'child-a' }));
    const done = await store.create(createInput({ childSessionId: 'child-b' }));
    await store.create(createInput({ parentSessionId: 'other', childSessionId: 'child-c' }));
    await store.markRunning(scope, active.runId);
    await store.markCompleted(scope, done.runId, 'done');

    expect(await store.countActiveChildren(scope, 'parent')).toBe(1);
    expect(await store.getDepthForSession(scope, 'child-a')).toBe(1);
    expect(await store.getDepthForSession(scope, 'unknown')).toBe(0);
    expect(await store.list(scope, 'parent')).toHaveLength(2);
    expect(await store.list(scope)).toHaveLength(3);
  });

  it('serializes concurrent writes without losing runs', async () => {
    const store = new JsonFileSubagentRunStore(filePath);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.create(createInput({ childSessionId: `child-${index}` })),
      ),
    );
    expect(await new JsonFileSubagentRunStore(filePath).list(scope)).toHaveLength(10);
  });
});
