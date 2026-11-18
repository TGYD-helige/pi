import type { RuntimeSession } from '@amaster.ai/pi-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DbSessionWorkspaceStore,
  sessionWorkspaceFromRuntimeSession,
} from '../session-workspaces.js';

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  where: undefined as unknown,
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    piAgentSession = {
      findFirst: async ({ where }: { where: unknown }) => {
        state.where = where;
        return state.row;
      },
    };
  },
}));

describe('session workspaces', () => {
  beforeEach(() => {
    state.row = undefined;
    state.where = undefined;
  });

  it('reads the workspace directory from stored session metadata', async () => {
    state.row = {
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      workspaceId: null,
      metadataJson: JSON.stringify({ session: { workspaceDir: '  /work/one  ' } }),
    };
    const store = new DbSessionWorkspaceStore('mysql://unused');
    expect(
      await store.get({ tenantId: 'tenant-1', sessionId: 'session-1', userId: 'user-1' }),
    ).toEqual({
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      workspaceDir: '/work/one',
    });
    expect(state.where).toEqual({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      deletedAt: null,
      userId: 'user-1',
    });
  });

  it('returns nothing for missing rows, malformed metadata, or blank directories', async () => {
    const store = new DbSessionWorkspaceStore('mysql://unused');
    expect(await store.get({ tenantId: 'tenant-1', sessionId: 'missing' })).toBeUndefined();
    state.row = { sessionId: 's', tenantId: 't', metadataJson: '{not json' };
    expect(await store.get({ tenantId: 't', sessionId: 's' })).toBeUndefined();
    state.row = { ...state.row, metadataJson: { session: { workspaceDir: '   ' } } };
    expect(await store.get({ tenantId: 't', sessionId: 's' })).toBeUndefined();
  });

  it('derives a binding only from sessions with a tenant and workspace', () => {
    const session = { sessionId: 's', tenantId: 't', workspaceDir: '/w' } as RuntimeSession & {
      workspaceDir: string;
    };
    expect(sessionWorkspaceFromRuntimeSession(session)).toEqual({
      sessionId: 's',
      tenantId: 't',
      workspaceDir: '/w',
    });
    expect(sessionWorkspaceFromRuntimeSession(undefined)).toBeUndefined();
    expect(sessionWorkspaceFromRuntimeSession({ ...session, tenantId: '' })).toBeUndefined();
    expect(
      sessionWorkspaceFromRuntimeSession({ ...session, workspaceDir: ' ' } as RuntimeSession),
    ).toBeUndefined();
  });
});
