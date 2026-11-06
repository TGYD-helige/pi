/**
 * JSON-file stores for conversations, transcripts, and memory.
 *
 * Owns persistence adapters used by PiAgentRuntime and HTTP routes. Keep route
 * validation, runtime event recording, and memory tool policy outside these
 * stores.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConversationMessage,
  ConversationTurn,
  CopilotMemoryStore,
  JsonObject,
  MemoryRecord,
  RuntimeScope,
  RuntimeSession,
  RuntimeSessionStore,
  RuntimeSessionSummary,
  TranscriptStore,
} from '@amaster.ai/pi-shared';
import { ValidationError } from '@amaster.ai/pi-shared';
import { readJsonFile, writeJsonFile } from './json-file.js';

type RuntimeSessionSummaryFields = Omit<RuntimeSessionSummary, keyof RuntimeSession>;

type JsonConversationHistoryState = {
  version: 1;
  turns: ConversationTurn[];
  messages: ConversationMessage[];
  sessionSummaries: Record<string, RuntimeSessionSummaryFields>;
};

export class JsonFileConversationStore implements RuntimeSessionStore {
  private sessionsLoaded = false;
  private readonly sessions = new Map<string, RuntimeSession>();
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getRuntimeSession(
    scope: RuntimeScope,
    sessionId: string,
  ): Promise<RuntimeSession | undefined> {
    await this.load();
    const session = this.sessions.get(sessionId);
    return session && sessionMatchesScope(session, scope) ? session : undefined;
  }

  async saveRuntimeSession(session: RuntimeSession): Promise<void> {
    await this.update(() => {
      this.sessions.set(session.sessionId, session);
    });
  }

  async listRuntimeSessions(
    scope: RuntimeScope,
    options?: { limit?: number; offset?: number },
  ): Promise<RuntimeSession[]> {
    await this.load();
    const filtered = [...this.sessions.values()].filter((session) =>
      sessionMatchesScope(session, scope),
    );
    // RuntimeSession 不含 updatedAt，按 sessionId（含日期前缀）降序即按创建时间排序。
    const sorted = filtered.sort((a, b) => b.sessionId.localeCompare(a.sessionId));
    const offset = options?.offset ?? 0;
    if (options?.limit !== undefined) {
      return sorted.slice(offset, offset + options.limit);
    }
    return offset > 0 ? sorted.slice(offset) : sorted;
  }

  private async load(): Promise<void> {
    if (this.sessionsLoaded) {
      return;
    }
    const sessions = await readJsonFile<RuntimeSession[]>(this.filePath, []);
    this.sessions.clear();
    for (const session of sessions) {
      this.sessions.set(session.sessionId, session);
    }
    this.sessionsLoaded = true;
  }

  private async update(mutator: () => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      await this.load();
      mutator();
      await writeJsonFile(this.filePath, [...this.sessions.values()]);
    });
    this.writeTail = pending.catch(() => undefined);
    await pending;
  }
}

export class JsonFileTranscriptStore implements TranscriptStore {
  private loaded = false;
  private state: JsonConversationHistoryState = createEmptyConversationHistoryState();
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async appendTurn(turn: ConversationTurn): Promise<void> {
    await this.update((state) => {
      state.turns.push(turn);
      state.messages.push(...messagesForTurn(turn));
      state.sessionSummaries[turn.sessionId] = nextSessionSummaryFields(
        state.sessionSummaries[turn.sessionId],
        turn,
      );
    });
  }

  async listTurns(scope: RuntimeScope, sessionId?: string): Promise<ConversationTurn[]> {
    return this.list(scope, sessionId);
  }

  async list(scope: RuntimeScope, sessionId?: string): Promise<ConversationTurn[]> {
    await this.load();
    const turns = this.state.turns;
    void scope;
    return turns.filter((turn) => !sessionId || turn.sessionId === sessionId);
  }

  async listMessages(scope: RuntimeScope, sessionId: string): Promise<ConversationMessage[]> {
    await this.load();
    void scope;
    return this.state.messages.filter((message) => message.sessionId === sessionId);
  }

  async listSessionSummaries(
    scope: RuntimeScope,
    sessions: RuntimeSession[],
  ): Promise<RuntimeSessionSummary[]> {
    await this.load();
    return sessions
      .filter((session) => sessionMatchesScope(session, scope))
      .map((session) => ({
        ...session,
        turnCount: 0,
        ...this.state.sessionSummaries[session.sessionId],
      }));
  }

  async updateSessionTitle(scope: RuntimeScope, sessionId: string, title: string): Promise<void> {
    void scope;
    await this.update((state) => {
      let summary = state.sessionSummaries[sessionId];
      if (!summary) {
        summary = { turnCount: 0 };
        state.sessionSummaries[sessionId] = summary;
      }
      summary.title = title;
    });
  }

  private async update(mutator: (state: JsonConversationHistoryState) => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      await this.load();
      mutator(this.state);
      await this.save();
    });
    this.writeTail = pending.catch(() => undefined);
    await pending;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const raw = await readJsonFile<unknown>(this.filePath, createEmptyConversationHistoryState());
    if (!isConversationHistoryState(raw))
      throw new ValidationError(
        'Stored conversation history has an invalid or unsupported schema. Restore the file before updating it; existing data was not replaced.',
        'configuration_error',
      );
    this.state = raw;
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.state);
  }
}

function sessionMatchesScope(session: RuntimeSession, scope: RuntimeScope): boolean {
  return (
    runtimeTenantId(session.tenantId) === scope.tenantId &&
    (!scope.userId || session.userId === scope.userId)
  );
}

function runtimeTenantId(tenantId: string | undefined): string {
  return tenantId ?? 'default';
}

function createEmptyConversationHistoryState(): JsonConversationHistoryState {
  return {
    version: 1,
    turns: [],
    messages: [],
    sessionSummaries: {},
  };
}

function isConversationHistoryState(raw: unknown): raw is JsonConversationHistoryState {
  if (!isJsonObject(raw)) {
    return false;
  }
  return (
    raw.version === 1 &&
    Array.isArray(raw.turns) &&
    raw.turns.every(isConversationTurn) &&
    Array.isArray(raw.messages) &&
    raw.messages.every(isConversationMessage) &&
    isSummaryRecord(raw.sessionSummaries)
  );
}

function messagesForTurn(turn: ConversationTurn): ConversationMessage[] {
  return [
    {
      id: `${turn.id}:user`,
      sessionId: turn.sessionId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      role: 'user',
      text: turn.userMessage,
      model: turn.model,
      ...(turn.traceId ? { traceId: turn.traceId } : {}),
      createdAt: turn.createdAt,
    },
    {
      id: `${turn.id}:assistant`,
      sessionId: turn.sessionId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      role: 'assistant',
      text: turn.assistantMessage,
      model: turn.model,
      ...(turn.traceId ? { traceId: turn.traceId } : {}),
      createdAt: turn.createdAt,
    },
  ];
}

function nextSessionSummaryFields(
  previous: RuntimeSessionSummaryFields | undefined,
  turn: ConversationTurn,
): RuntimeSessionSummaryFields {
  const firstUserMessage = previous?.firstUserMessage ?? turn.userMessage;
  const title = previous?.title ?? firstLine(firstUserMessage) ?? firstLine(turn.userMessage);
  return {
    turnCount: (previous?.turnCount ?? 0) + 1,
    ...(title ? { title } : {}),
    updatedAt: turn.createdAt,
    firstUserMessage,
    lastUserMessage: turn.userMessage,
    lastAssistantMessage: turn.assistantMessage,
    lastMessageAt: turn.createdAt,
  };
}

function isConversationTurn(value: unknown): value is ConversationTurn {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.conversationId === 'string' &&
    typeof value.userMessage === 'string' &&
    typeof value.assistantMessage === 'string' &&
    typeof value.createdAt === 'string' &&
    isJsonObject(value.model)
  );
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.conversationId === 'string' &&
    typeof value.role === 'string' &&
    ['user', 'assistant', 'tool', 'system'].includes(value.role) &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isSummaryRecord(value: unknown): value is Record<string, RuntimeSessionSummaryFields> {
  if (!isJsonObject(value)) {
    return false;
  }
  return Object.values(value).every(
    (entry) => isJsonObject(entry) && typeof entry.turnCount === 'number',
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLine(value: string | undefined): string {
  return (
    value
      ?.split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 120) ?? ''
  );
}

export class JsonFileMemoryStore implements CopilotMemoryStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(input: {
    sessionId: string;
    text: string;
    tags?: string[];
    metadata?: JsonObject;
  }): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: randomUUID(),
      text: input.text,
      ...(input.tags ? { tags: input.tags } : {}),
      createdAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await this.update((records) => {
      records.push({ sessionId: input.sessionId, record });
    });
    return record;
  }

  async search(input: {
    sessionId: string;
    query: string;
    limit: number;
  }): Promise<MemoryRecord[]> {
    const query = input.query.trim().toLowerCase();
    await this.writeTail.catch(() => undefined);
    const records = await this.load();
    return records
      .filter((entry) => entry.sessionId === input.sessionId)
      .map((entry) => entry.record)
      .filter((record) => {
        if (!query) {
          return true;
        }
        return (
          record.text.toLowerCase().includes(query) ||
          record.tags?.some((tag) => tag.toLowerCase().includes(query))
        );
      })
      .slice(0, input.limit);
  }

  private load(): Promise<Array<{ sessionId: string; record: MemoryRecord }>> {
    return readJsonFile<Array<{ sessionId: string; record: MemoryRecord }>>(this.filePath, []);
  }

  private async update(
    mutator: (records: Array<{ sessionId: string; record: MemoryRecord }>) => void,
  ): Promise<void> {
    const pending = this.writeTail.then(async () => {
      const records = await this.load();
      mutator(records);
      await writeJsonFile(this.filePath, records);
    });
    this.writeTail = pending.catch(() => undefined);
    await pending;
  }
}
