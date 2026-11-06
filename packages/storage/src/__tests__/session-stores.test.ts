import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConversationTurn, RuntimeSession } from '@amaster.ai/pi-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileConversationStore, JsonFileTranscriptStore } from '../session-stores.js';

const tmpDirs: string[] = [];

describe('JsonFileTranscriptStore', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('refuses to overwrite parseable history with an invalid schema', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');
    const original = JSON.stringify({ version: 2, turns: [], messages: [{ text: 'keep me' }] });
    await writeFile(filePath, original);
    const store = new JsonFileTranscriptStore(filePath);
    await expect(store.appendTurn(turn('turn-1', 'session-1', 'hello', 'hi'))).rejects.toThrow(
      /schema/,
    );
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('writes versioned history state with turns, messages, and session summaries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');

    const store = new JsonFileTranscriptStore(filePath);
    await store.appendTurn(turn('turn-1', 'session-1', 'hello', 'hi'));
    await store.appendTurn(turn('turn-2', 'session-1', 'next', 'done'));

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted).toMatchObject({
      version: 1,
      sessionSummaries: {
        'session-1': {
          title: 'hello',
          turnCount: 2,
          firstUserMessage: 'hello',
          lastUserMessage: 'next',
          lastAssistantMessage: 'done',
          lastMessageAt: '2026-05-13T00:00:00.000Z',
        },
      },
    });
    expect(persisted.turns).toHaveLength(2);
    expect(persisted.messages).toMatchObject([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
      { role: 'user', text: 'next' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('returns session summaries from persisted summary state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');
    const store = new JsonFileTranscriptStore(filePath);

    await store.appendTurn(turn('turn-1', 'session-1', 'first question', 'first answer'));

    expect(
      await store.listSessionSummaries({ tenantId: 'tenant-1' }, [
        {
          sessionId: 'session-1',
          conversationId: 'session-1',
          tenantId: 'tenant-1',
          model: model(),
          sandboxStatus: 'running',
          toolPolicyProfile: 'default',
        },
      ]),
    ).toMatchObject([
      {
        sessionId: 'session-1',
        title: 'first question',
        turnCount: 1,
        lastUserMessage: 'first question',
        lastAssistantMessage: 'first answer',
      },
    ]);
  });

  it('updateSessionTitle overwrites the title on an existing summary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');
    const store = new JsonFileTranscriptStore(filePath);

    await store.appendTurn(turn('turn-1', 'session-1', 'first question', 'first answer'));
    await store.updateSessionTitle({ tenantId: 'tenant-1' }, 'session-1', 'AI generated title');

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted.sessionSummaries['session-1']).toMatchObject({
      title: 'AI generated title',
      turnCount: 1,
      firstUserMessage: 'first question',
    });
  });

  it('updateSessionTitle upserts when summary does not yet exist and is preserved by a later appendTurn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');
    const store = new JsonFileTranscriptStore(filePath);

    await store.updateSessionTitle({ tenantId: 'tenant-1' }, 'session-1', 'AI generated title');

    let persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted.sessionSummaries['session-1']).toEqual({
      turnCount: 0,
      title: 'AI generated title',
    });

    await store.appendTurn(turn('turn-1', 'session-1', 'first question', 'first answer'));

    persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted.sessionSummaries['session-1']).toMatchObject({
      title: 'AI generated title',
      turnCount: 1,
      firstUserMessage: 'first question',
      lastAssistantMessage: 'first answer',
    });
  });

  it('listRuntimeSessions returns sessions sorted by sessionId descending (newest first)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'sessions.json');
    const store = new JsonFileConversationStore(filePath);

    await store.saveRuntimeSession({
      sessionId: 'web-2024-01-01-aaa',
      conversationId: 'web-2024-01-01-aaa',
      tenantId: 'default',
      model: model(),
      sandboxStatus: 'running',
      toolPolicyProfile: 'default',
    });
    await store.saveRuntimeSession({
      sessionId: 'web-2024-06-15-zzz',
      conversationId: 'web-2024-06-15-zzz',
      tenantId: 'default',
      model: model(),
      sandboxStatus: 'running',
      toolPolicyProfile: 'default',
    });
    await store.saveRuntimeSession({
      sessionId: 'web-2024-03-10-mmm',
      conversationId: 'web-2024-03-10-mmm',
      tenantId: 'default',
      model: model(),
      sandboxStatus: 'running',
      toolPolicyProfile: 'default',
    });

    const sessions = await store.listRuntimeSessions({ tenantId: 'default' });
    expect(sessions.map((s) => s.sessionId)).toEqual([
      'web-2024-06-15-zzz',
      'web-2024-03-10-mmm',
      'web-2024-01-01-aaa',
    ]);
  });

  it('treats legacy JSON sessions without tenantId as default tenant sessions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'sessions.json');
    const store = new JsonFileConversationStore(filePath);
    const legacySession = {
      sessionId: 'legacy-session',
      conversationId: 'legacy-session',
      model: model(),
      sandboxStatus: 'running',
      toolPolicyProfile: 'default',
    } satisfies RuntimeSession;

    await store.saveRuntimeSession(legacySession);

    await expect(store.listRuntimeSessions({ tenantId: 'default' })).resolves.toMatchObject([
      { sessionId: 'legacy-session' },
    ]);
    await expect(
      store.getRuntimeSession({ tenantId: 'default' }, 'legacy-session'),
    ).resolves.toMatchObject({
      sessionId: 'legacy-session',
    });
    await expect(store.listRuntimeSessions({ tenantId: 'tenant-1' })).resolves.toEqual([]);
  });
});

function turn(
  id: string,
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
): ConversationTurn {
  return {
    id,
    sessionId,
    conversationId: sessionId,
    userMessage,
    assistantMessage,
    model: model(),
    createdAt: '2026-05-13T00:00:00.000Z',
  };
}

function model(): ConversationTurn['model'] {
  return {
    provider: 'openai',
    model: 'gpt-test',
  };
}
