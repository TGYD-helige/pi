import type { RuntimeSession } from '@amaster.ai/pi-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbRuntimeStores } from '../db-runtime-storage.js';

const state = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));
vi.mock('@prisma/client', () => ({
  Prisma: {},
  PrismaClient: class {
    piAgentSession = {
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        state.row = JSON.parse(JSON.stringify(state.row ? { ...state.row, ...update } : create));
      },
      findFirst: async () => state.row,
      findMany: async () => (state.row ? [state.row] : []),
    };
  },
}));

function session(): RuntimeSession {
  return {
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    model: { provider: 'openai', model: 'model-1', authProfileId: 'profile-1', reasoning: true },
    sandboxStatus: 'running',
    toolPolicyProfile: 'default',
    piSessionFile: '/sessions/one.jsonl',
    piSessionFilesByModel: { 'openai/model-1': '/sessions/one.jsonl' },
    metadata: { assistantMode: 'development', existing: 'kept', nested: { enabled: true } },
  };
}

describe('DbRuntimeSessionStore', () => {
  beforeEach(() => {
    state.row = undefined;
  });

  it('preserves metadata and model/file mappings across create, update, and read/save', async () => {
    const { store } = createDbRuntimeStores('mysql://unused', 'redis://localhost:6379');
    const scope = { tenantId: 'tenant-1', userId: 'user-1' };
    const original = session();
    await store.saveRuntimeSession(original);
    const loaded = await store.getRuntimeSession(scope, original.sessionId);
    expect(loaded).toEqual(original);
    await store.saveRuntimeSession({
      ...loaded!,
      metadata: { ...loaded!.metadata, assistantMode: 'production' },
    });
    const updated = await store.getRuntimeSession(scope, original.sessionId);
    expect(updated?.metadata).toEqual({ ...original.metadata, assistantMode: 'production' });
    await store.saveRuntimeSession(updated!);
    expect(await store.getRuntimeSession(scope, original.sessionId)).toEqual(updated);
    expect(await store.listRuntimeSessions(scope)).toEqual([updated]);
  });

  it.each([
    undefined,
    null,
    [],
    'invalid',
    42,
    true,
  ])('ignores malformed metadata (%j)', async (metadata) => {
    const { store } = createDbRuntimeStores('mysql://unused', 'redis://localhost:6379');
    await store.saveRuntimeSession(session());
    state.row!.metadataJson = { session: { metadata } };
    expect(
      (await store.getRuntimeSession({ tenantId: 'tenant-1' }, 'session-1'))?.metadata,
    ).toBeUndefined();
  });
});
