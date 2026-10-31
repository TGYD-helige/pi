/**
 * MySQL-backed runtime stores for platform mode.
 *
 * These adapters map the runtime store interfaces onto the platform schema in
 * packages/storage/prisma/schema.prisma. JSON mode remains the local developer
 * adapter; DB mode uses these stores directly and never falls back silently.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ConversationMessage,
  ConversationTurn,
  CopilotMemoryStore,
  JsonObject,
  JsonValue,
  LlmGenerationEventStore,
  MemoryRecord,
  RuntimeArtifact,
  RuntimeArtifactCreateInput,
  RuntimeArtifactListInput,
  RuntimeArtifactStore,
  RuntimeEventStore,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeModelConfig,
  RuntimeScope,
  RuntimeSession,
  RuntimeSessionStore,
  RuntimeSessionSummary,
  RuntimeTimelineCursor,
  RuntimeTimelineEvent,
  RuntimeTimelineEventInput,
  RuntimeTimelineEventSource,
  RuntimeTimelineEventStore,
  RuntimeToolEvent,
  SubagentLifecycleEvent,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunStore,
  ToolEventStore,
  TranscriptStore,
} from '@amaster.ai/pi-shared';
import { Prisma, PrismaClient } from '@prisma/client';
import { RedisLockManager } from './redis-locks.js';
import { isTerminalSubagentStatus } from './subagent-store.js';

export type DbRuntimeStores = {
  store: RuntimeSessionStore;
  transcripts: TranscriptStore;
  memory: CopilotMemoryStore;
  runtimeEvents: RuntimeEventStore;
  toolEvents: ToolEventStore;
  llmGenerationEvents: LlmGenerationEventStore;
  timelineEvents: RuntimeTimelineEventStore;
  subagents: SubagentRunStore;
  artifacts: RuntimeArtifactStore;
};

const REQUIRED_DB_TABLES = [
  'pi_agent_sessions',
  'pi_agent_turns',
  'pi_agent_messages',
  'pi_agent_turn_queue',
  'pi_agent_turn_signals',
  'pi_agent_events',
  'pi_agent_subagent_runs',
  'pi_agent_approvals',
  'pi_agent_memory',
  'pi_agent_scheduled_tasks',
  'pi_agent_task_runs',
  'pi_agent_artifacts',
] as const;

type Identity = {
  tenantId: string;
  userId: string;
  workspaceId?: string;
};

export function createDbRuntimeStores(databaseUrl: string, redisUrl: string): DbRuntimeStores {
  const context = new DbRuntimeContext(databaseUrl, redisUrl);
  const timelineEvents = new DbRuntimeTimelineEventStore(context);
  return {
    store: new DbRuntimeSessionStore(context),
    transcripts: new DbTranscriptStore(context),
    memory: new DbMemoryStore(context),
    runtimeEvents: new DbRuntimeEventStore(timelineEvents),
    toolEvents: new DbToolEventStore(timelineEvents),
    llmGenerationEvents: new DbLlmGenerationEventStore(timelineEvents),
    timelineEvents,
    subagents: new DbSubagentRunStore(context),
    artifacts: new DbArtifactStore(context),
  };
}

export async function verifyDbRuntimeSchema(databaseUrl: string): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>(
      Prisma.sql`SELECT TABLE_NAME AS table_name
                 FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME IN (${Prisma.join([...REQUIRED_DB_TABLES])})`,
    );
    const found = new Set(rows.map((row) => row.table_name));
    const missing = REQUIRED_DB_TABLES.filter((table) => !found.has(table));
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_MODE=db schema is missing required table(s): ${missing.join(', ')}. ` +
          'Apply the pi runtime DB migration before starting server.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

type PrismaTx = Prisma.TransactionClient;

class DbRuntimeContext {
  readonly prisma: PrismaClient;
  readonly locks: RedisLockManager;

  constructor(databaseUrl: string, redisUrl: string) {
    this.prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl },
      },
    });
    this.locks = new RedisLockManager(redisUrl);
  }

  async resolveIdentity(
    sessionId: string,
    tx: PrismaTx | PrismaClient = this.prisma,
  ): Promise<Identity> {
    const row = await tx.piAgentSession.findFirst({
      where: { sessionId: { in: identityLookupSessionIds(sessionId) }, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { tenantId: true, userId: true, workspaceId: true },
    });
    return {
      tenantId: row?.tenantId ?? 'default',
      userId: row?.userId ?? 'system',
      ...(row?.workspaceId ? { workspaceId: row.workspaceId } : {}),
    };
  }
}

function identityLookupSessionIds(sessionId: string): string[] {
  const subagentMarker = ':subagent:';
  const markerIndex = sessionId.indexOf(subagentMarker);
  if (markerIndex <= 0) {
    return [sessionId];
  }
  return [sessionId, sessionId.slice(0, markerIndex)];
}

class DbRuntimeSessionStore implements RuntimeSessionStore {
  constructor(private readonly db: DbRuntimeContext) {}

  async getRuntimeSession(
    scope: RuntimeScope,
    sessionId: string,
  ): Promise<RuntimeSession | undefined> {
    const row = await this.db.prisma.piAgentSession.findFirst({
      where: { sessionId, deletedAt: null, ...sessionScopeWhere(scope) },
      orderBy: { updatedAt: 'desc' },
    });
    return row ? sessionFromPrisma(row) : undefined;
  }

  async saveRuntimeSession(session: RuntimeSession): Promise<void> {
    const now = new Date().toISOString();
    const tenantId = session.tenantId ?? 'default';
    const userId = session.userId ?? 'system';
    const rowId = stableRowId('session', tenantId, session.sessionId);
    await this.db.prisma.piAgentSession.upsert({
      where: { id: rowId },
      create: {
        id: rowId,
        tenantId,
        userId,
        workspaceId: session.workspaceId ?? null,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        parentSessionId: session.parentSessionId ?? null,
        childSessionId: session.childSessionId ?? null,
        taskRunId: session.taskRunId ?? null,
        runId: session.runId ?? null,
        spawnBatchId: session.spawnBatchId ?? null,
        triggerType: 'user',
        status: 'active',
        modelProvider: session.model.provider,
        modelName: session.model.model,
        thinkingLevel: session.model.thinkingLevel ?? null,
        toolPolicyProfile: session.toolPolicyProfile,
        sandboxSessionId: session.sandboxSessionId ?? null,
        sandboxStatus: session.sandboxStatus,
        piSessionRef: session.piSessionFile ?? null,
        metadataJson: jsonInput({ session, model: session.model }),
        createdAt: toDate(now),
        updatedAt: toDate(now),
        lastActiveAt: toDate(now),
      },
      update: {
        userId,
        workspaceId: session.workspaceId ?? null,
        conversationId: session.conversationId,
        parentSessionId: session.parentSessionId ?? null,
        childSessionId: session.childSessionId ?? null,
        taskRunId: session.taskRunId ?? null,
        runId: session.runId ?? null,
        spawnBatchId: session.spawnBatchId ?? null,
        modelProvider: session.model.provider,
        modelName: session.model.model,
        thinkingLevel: session.model.thinkingLevel ?? null,
        toolPolicyProfile: session.toolPolicyProfile,
        sandboxSessionId: session.sandboxSessionId ?? null,
        sandboxStatus: session.sandboxStatus,
        piSessionRef: session.piSessionFile ?? null,
        metadataJson: jsonInput({ session, model: session.model }),
        updatedAt: toDate(now),
        lastActiveAt: toDate(now),
        deletedAt: null,
      },
    });
  }

  async listRuntimeSessions(
    scope: RuntimeScope,
    options?: { limit?: number; offset?: number },
  ): Promise<RuntimeSession[]> {
    const rows = await this.db.prisma.piAgentSession.findMany({
      where: { deletedAt: null, ...sessionScopeWhere(scope) },
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
      ...(options?.limit !== undefined ? { take: options.limit } : {}),
      ...(options?.offset !== undefined ? { skip: options.offset } : {}),
    });
    return rows.map(sessionFromPrisma);
  }
}

class DbTranscriptStore implements TranscriptStore {
  constructor(private readonly db: DbRuntimeContext) {}

  async appendTurn(turn: ConversationTurn): Promise<void> {
    const identity = await this.db.resolveIdentity(turn.sessionId);
    await this.db.locks.withLock({
      key: `pi:turns:${identity.tenantId}:${turn.sessionId}`,
      ttlMs: 10_000,
      timeoutMs: 5_000,
      task: async () => {
        await this.db.prisma.$transaction(async (tx) => {
          const [turnSeq, messageSeq] = await Promise.all([
            nextBigIntSeq(
              tx.piAgentTurn.aggregate({
                where: { tenantId: identity.tenantId, sessionId: turn.sessionId },
                _max: { turnSeq: true },
              }),
              'turnSeq',
            ),
            nextBigIntSeq(
              tx.piAgentMessage.aggregate({
                where: { tenantId: identity.tenantId, sessionId: turn.sessionId },
                _max: { messageSeq: true },
              }),
              'messageSeq',
            ),
          ]);
          await tx.piAgentTurn.create({
            data: {
              id: turn.id,
              tenantId: identity.tenantId,
              userId: identity.userId,
              workspaceId: identity.workspaceId ?? null,
              sessionId: turn.sessionId,
              conversationId: turn.conversationId,
              traceId: turn.traceId ?? null,
              turnSeq,
              sourceType: 'user',
              status: 'completed',
              inputText: turn.userMessage,
              outputText: turn.assistantMessage,
              modelJson: jsonInput(turn.model),
              completedAt: toDate(turn.createdAt),
              createdAt: toDate(turn.createdAt),
              updatedAt: toDate(turn.createdAt),
            },
          });
          await tx.piAgentMessage.createMany({
            data: [
              messageCreateInput(
                identity,
                turn,
                `${turn.id}:user`,
                'user',
                turn.userMessage,
                messageSeq,
              ),
              messageCreateInput(
                identity,
                turn,
                `${turn.id}:assistant`,
                'assistant',
                turn.assistantMessage,
                messageSeq + 1n,
              ),
            ],
          });
          await tx.piAgentSession.updateMany({
            where: { tenantId: identity.tenantId, sessionId: turn.sessionId, deletedAt: null },
            data: {
              turnCount: { increment: 1 },
              title: firstLine(turn.userMessage),
              firstUserMessage: turn.userMessage,
              lastUserMessage: turn.userMessage,
              lastAssistantMessage: turn.assistantMessage,
              lastMessageAt: toDate(turn.createdAt),
              updatedAt: toDate(turn.createdAt),
              lastActiveAt: toDate(turn.createdAt),
            },
          });
        });
      },
    });
  }

  async listTurns(scope: RuntimeScope, sessionId?: string): Promise<ConversationTurn[]> {
    const rows = await this.db.prisma.piAgentTurn.findMany({
      where: { ...(sessionId ? { sessionId } : {}), ...sessionScopeWhere(scope) },
      orderBy: [{ createdAt: 'asc' }, { turnSeq: 'asc' }],
    });
    return rows.map(turnFromPrisma);
  }

  async listMessages(scope: RuntimeScope, sessionId: string): Promise<ConversationMessage[]> {
    const [rows, turns] = await Promise.all([
      this.db.prisma.piAgentMessage.findMany({
        where: { sessionId, deletedAt: null, ...sessionScopeWhere(scope) },
        orderBy: { messageSeq: 'asc' },
      }),
      this.db.prisma.piAgentTurn.findMany({
        where: { sessionId, ...sessionScopeWhere(scope) },
        select: { id: true, traceId: true },
      }),
    ]);
    const traceIdsByTurnId = new Map(
      turns.filter((turn) => Boolean(turn.traceId)).map((turn) => [turn.id, turn.traceId] as const),
    );
    return rows.map((row) => messageFromPrisma(row, traceIdsByTurnId));
  }

  async listSessionSummaries(
    scope: RuntimeScope,
    sessions: RuntimeSession[],
  ): Promise<RuntimeSessionSummary[]> {
    if (sessions.length === 0) {
      return [];
    }
    const ids = sessions.map((session) => session.sessionId);
    const rows = await this.db.prisma.piAgentSession.findMany({
      where: { sessionId: { in: ids }, deletedAt: null, ...sessionScopeWhere(scope) },
    });
    const bySessionId = new Map(rows.map((row) => [row.sessionId, row]));
    return sessions.map((session) =>
      summaryFromPrismaSession(session, bySessionId.get(session.sessionId)),
    );
  }

  async updateSessionTitle(scope: RuntimeScope, sessionId: string, title: string): Promise<void> {
    await this.db.prisma.piAgentSession.updateMany({
      where: { sessionId, deletedAt: null, ...sessionScopeWhere(scope) },
      data: { title, updatedAt: new Date() },
    });
  }
}

class DbRuntimeTimelineEventStore implements RuntimeTimelineEventStore {
  constructor(private readonly db: DbRuntimeContext) {}

  async append(event: RuntimeTimelineEventInput): Promise<void> {
    const identity = await this.db.resolveIdentity(event.sessionId);
    await this.db.locks.withLock({
      key: `pi:events:${identity.tenantId}:${event.sessionId}`,
      ttlMs: 10_000,
      timeoutMs: 5_000,
      task: async () => {
        await this.db.prisma.$transaction(async (tx) => {
          const existing = await tx.piAgentEvent.findUnique({
            where: { id: event.eventId },
            select: { id: true },
          });
          if (existing) {
            return;
          }
          const aggregate = await tx.piAgentEvent.aggregate({
            where: { tenantId: identity.tenantId, sessionId: event.sessionId },
            _max: { eventSeq: true },
          });
          await tx.piAgentEvent.create({
            data: {
              id: event.eventId,
              tenantId: identity.tenantId,
              userId: identity.userId,
              workspaceId: identity.workspaceId ?? null,
              sessionId: event.sessionId,
              turnId: event.turnId ?? null,
              traceId: event.traceId ?? null,
              eventSeq: (aggregate._max.eventSeq ?? 0n) + 1n,
              eventSource: event.eventSource,
              eventType: event.eventType,
              eventName: event.eventName,
              severity: 'info',
              payloadJson: jsonInput(event.payload),
              createdAt: toDate(event.createdAt),
            },
          });
        });
      },
    });
  }

  async list(
    input: RuntimeScope & {
      sessionId?: string;
      traceId?: string;
      afterSeq?: number;
      beforeSeq?: number;
      cursor?: RuntimeTimelineCursor;
      limit?: number;
    },
  ): Promise<RuntimeTimelineEvent[]> {
    const limit = positiveLimit(input.limit);
    const cursorEventSeq = input.cursor
      ? input.cursor.eventSeq !== undefined
        ? BigInt(input.cursor.eventSeq)
        : await this.findCursorEventSeq(input.cursor.eventId)
      : undefined;
    const rows = await this.db.prisma.piAgentEvent.findMany({
      where: timelineWhere(input, cursorEventSeq),
      orderBy: [{ createdAt: 'desc' }, { eventSeq: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(timelineEventFromPrisma).reverse();
  }

  private async findCursorEventSeq(eventId: string): Promise<bigint | undefined> {
    const row = await this.db.prisma.piAgentEvent.findUnique({
      where: { id: eventId },
      select: { eventSeq: true },
    });
    return row?.eventSeq;
  }

  async listBySource(
    eventSource: RuntimeTimelineEventSource,
    input: Partial<RuntimeScope> & {
      sessionId?: string;
      traceId?: string;
      eventType?: string;
      limit?: number;
    } = {},
  ): Promise<RuntimeTimelineEvent[]> {
    const rows = await this.db.prisma.piAgentEvent.findMany({
      where: {
        eventSource,
        ...timelineWhere(input),
        ...(input.eventType ? { eventType: input.eventType } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { eventSeq: 'desc' }, { id: 'desc' }],
      take: positiveLimit(input.limit),
    });
    return rows.map(timelineEventFromPrisma).reverse();
  }
}

class DbRuntimeEventStore implements RuntimeEventStore {
  constructor(private readonly timeline: DbRuntimeTimelineEventStore) {}

  async append(event: RuntimeLifecycleEvent): Promise<void> {
    await this.timeline.append(runtimeEventToTimeline(event));
  }

  async list(
    input: { sessionId?: string; traceId?: string; type?: string; limit?: number } = {},
  ): Promise<RuntimeLifecycleEvent[]> {
    const events = await this.timeline.listBySource('runtime', runtimeListInput(input));
    return events.map((event) => event.payload as RuntimeLifecycleEvent);
  }
}

class DbToolEventStore implements ToolEventStore {
  constructor(private readonly timeline: DbRuntimeTimelineEventStore) {}

  async append(event: RuntimeToolEvent): Promise<void> {
    await this.timeline.append(toolEventToTimeline(event));
  }

  async list(
    input: { sessionId?: string; traceId?: string; limit?: number } = {},
  ): Promise<RuntimeToolEvent[]> {
    const events = await this.timeline.listBySource('tool', timelineListInput(input));
    return events.map((event) => event.payload as RuntimeToolEvent);
  }
}

class DbLlmGenerationEventStore implements LlmGenerationEventStore {
  constructor(private readonly timeline: DbRuntimeTimelineEventStore) {}

  async append(event: RuntimeLlmGenerationEvent): Promise<void> {
    await this.timeline.append(llmEventToTimeline(event));
  }

  async list(
    input: { sessionId?: string; traceId?: string; limit?: number } = {},
  ): Promise<RuntimeLlmGenerationEvent[]> {
    const events = await this.timeline.listBySource('llm', timelineListInput(input));
    return events.map((event) => event.payload as RuntimeLlmGenerationEvent);
  }
}

class DbMemoryStore implements CopilotMemoryStore {
  constructor(private readonly db: DbRuntimeContext) {}

  async write(input: {
    sessionId: string;
    text: string;
    tags?: string[];
    metadata?: JsonObject;
  }): Promise<MemoryRecord> {
    const identity = await this.db.resolveIdentity(input.sessionId);
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: randomUUID(),
      text: input.text,
      ...(input.tags ? { tags: input.tags } : {}),
      createdAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await this.db.prisma.piAgentMemory.create({
      data: {
        id: record.id,
        tenantId: identity.tenantId,
        userId: identity.userId,
        workspaceId: identity.workspaceId ?? null,
        sessionId: input.sessionId,
        scope: 'session',
        text: input.text,
        tagsJson: jsonInput(input.tags ?? []),
        metadataJson: jsonInput(input.metadata ?? {}),
        createdAt: toDate(now),
        updatedAt: toDate(now),
      },
    });
    return record;
  }

  async search(input: {
    sessionId: string;
    query: string;
    limit: number;
  }): Promise<MemoryRecord[]> {
    const identity = await this.db.resolveIdentity(input.sessionId);
    const query = input.query.trim();
    const rows = await this.db.prisma.piAgentMemory.findMany({
      where: {
        tenantId: identity.tenantId,
        sessionId: input.sessionId,
        deletedAt: null,
        ...(query ? { text: { contains: query } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: positiveLimit(input.limit),
    });
    return rows.map(memoryFromPrisma);
  }
}

class DbSubagentRunStore implements SubagentRunStore {
  constructor(private readonly db: DbRuntimeContext) {}

  async create(
    input: RuntimeScope & {
      traceId?: string;
      taskRunId?: string;
      spawnBatchId?: string;
      parentSessionId: string;
      childSessionId: string;
      parentToolCallId?: string;
      task: string;
      agent?: string;
      label?: string;
      depth: number;
      model: RuntimeModelConfig;
      toolPolicyProfile: string;
      context: 'isolated';
    },
  ): Promise<SubagentRun> {
    const parentIdentity = await this.db.resolveIdentity(input.parentSessionId);
    const identity: Identity = {
      tenantId: input.tenantId,
      userId: input.userId ?? parentIdentity.userId,
      ...(parentIdentity.workspaceId ? { workspaceId: parentIdentity.workspaceId } : {}),
    };
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: SubagentRun = {
      runId,
      taskRunId: input.taskRunId ?? runId,
      ...(input.spawnBatchId ? { spawnBatchId: input.spawnBatchId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
      task: input.task,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.label ? { label: input.label } : {}),
      status: 'pending',
      depth: input.depth,
      model: input.model,
      toolPolicyProfile: input.toolPolicyProfile,
      context: input.context,
      createdAt: now,
      updatedAt: now,
      events: [
        { type: 'subagent_spawning', at: now },
        { type: 'subagent_spawned', at: now },
      ],
    };
    await this.db.prisma.piAgentSubagentRun.create({
      data: {
        id: stableRowId('subagent', identity.tenantId, runId),
        tenantId: identity.tenantId,
        userId: identity.userId,
        workspaceId: identity.workspaceId ?? null,
        runId: run.runId,
        taskRunId: run.taskRunId ?? null,
        spawnBatchId: run.spawnBatchId ?? null,
        traceId: run.traceId ?? null,
        parentSessionId: run.parentSessionId,
        childSessionId: run.childSessionId,
        parentToolCallId: run.parentToolCallId ?? null,
        agentName: run.agent ?? null,
        label: run.label ?? null,
        taskText: run.task,
        status: run.status,
        depth: run.depth,
        modelJson: jsonInput(run.model),
        toolPolicyProfile: run.toolPolicyProfile,
        createdAt: toDate(run.createdAt),
        updatedAt: toDate(run.updatedAt),
      },
    });
    return run;
  }

  async list(scope: RuntimeScope, parentSessionId?: string): Promise<SubagentRun[]> {
    const rows = await this.db.prisma.piAgentSubagentRun.findMany({
      where: { ...sessionScopeWhere(scope), ...(parentSessionId ? { parentSessionId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(subagentFromPrisma);
  }

  async get(scope: RuntimeScope, runId: string): Promise<SubagentRun | undefined> {
    const row = await this.db.prisma.piAgentSubagentRun.findFirst({
      where: { runId, ...sessionScopeWhere(scope) },
      orderBy: { updatedAt: 'desc' },
    });
    return row ? subagentFromPrisma(row) : undefined;
  }

  async getDepthForSession(scope: RuntimeScope, sessionId: string): Promise<number> {
    const row = await this.db.prisma.piAgentSubagentRun.findFirst({
      where: { childSessionId: sessionId, ...sessionScopeWhere(scope) },
      orderBy: { updatedAt: 'desc' },
      select: { depth: true },
    });
    return row?.depth ?? 0;
  }

  async countActiveChildren(scope: RuntimeScope, parentSessionId: string): Promise<number> {
    return await this.db.prisma.piAgentSubagentRun.count({
      where: {
        parentSessionId,
        status: { in: ['pending', 'running'] },
        ...sessionScopeWhere(scope),
      },
    });
  }

  async markRunning(scope: RuntimeScope, runId: string): Promise<SubagentRun | undefined> {
    return await this.patch(scope, runId, (run, now) => ({
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? now,
      updatedAt: now,
      events: [...run.events, { type: 'subagent_started', at: now }],
    }));
  }

  async markCompleted(
    scope: RuntimeScope,
    runId: string,
    result: string,
  ): Promise<SubagentRun | undefined> {
    return await this.patch(scope, runId, (run, now) => {
      if (run.status === 'cancelled') {
        return run;
      }
      return {
        ...omitSubagentError(run),
        status: 'completed',
        result,
        endedAt: now,
        updatedAt: now,
        events: [...run.events, { type: 'subagent_ended', at: now, reason: 'completed' }],
      };
    });
  }

  async markFailed(
    scope: RuntimeScope,
    runId: string,
    error: string,
  ): Promise<SubagentRun | undefined> {
    return await this.patch(scope, runId, (run, now) => {
      if (run.status === 'cancelled') {
        return run;
      }
      return {
        ...run,
        status: 'failed',
        error,
        endedAt: now,
        updatedAt: now,
        events: [...run.events, { type: 'subagent_ended', at: now, reason: 'failed' }],
      };
    });
  }

  async markCancelled(
    scope: RuntimeScope,
    runId: string,
    reason = 'cancelled',
  ): Promise<SubagentRun | undefined> {
    return await this.patch(scope, runId, (run, now) => {
      if (isTerminalSubagentStatus(run.status)) {
        return run;
      }
      return {
        ...run,
        status: 'cancelled',
        error: reason,
        endedAt: now,
        updatedAt: now,
        events: [...run.events, { type: 'subagent_ended', at: now, reason: 'cancelled' }],
      };
    });
  }

  private async patch(
    scope: RuntimeScope,
    runId: string,
    mutator: (run: SubagentRun, now: string) => SubagentRun,
  ): Promise<SubagentRun | undefined> {
    const existing = await this.get(scope, runId);
    if (!existing) {
      return undefined;
    }
    const next = mutator(existing, new Date().toISOString());
    await this.db.prisma.piAgentSubagentRun.updateMany({
      where: { runId: next.runId, ...sessionScopeWhere(scope) },
      data: {
        status: next.status,
        resultText: next.result ?? null,
        errorJson: next.error ? jsonInput({ message: next.error }) : Prisma.JsonNull,
        startedAt: next.startedAt ? toDate(next.startedAt) : null,
        endedAt: next.endedAt ? toDate(next.endedAt) : null,
        updatedAt: toDate(next.updatedAt),
      },
    });
    return next;
  }
}

class DbArtifactStore implements RuntimeArtifactStore {
  constructor(private readonly db: DbRuntimeContext) {}

  async create(input: RuntimeArtifactCreateInput): Promise<RuntimeArtifact> {
    const identity = await this.db.resolveIdentity(input.sessionId);
    const artifact: RuntimeArtifact = {
      id: input.id ?? randomUUID(),
      tenantId: input.tenantId ?? identity.tenantId,
      userId: input.userId ?? identity.userId,
      ...((input.workspaceId ?? identity.workspaceId)
        ? { workspaceId: input.workspaceId ?? identity.workspaceId }
        : {}),
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      artifactType: input.artifactType,
      ...(input.name ? { name: input.name } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      storageUri: input.storageUri,
      ...(input.previewUri ? { previewUri: input.previewUri } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await this.db.prisma.piAgentArtifact.create({
      data: {
        id: artifact.id,
        tenantId: artifact.tenantId ?? 'default',
        userId: artifact.userId ?? 'system',
        workspaceId: artifact.workspaceId ?? null,
        sessionId: artifact.sessionId,
        turnId: artifact.turnId ?? null,
        toolCallId: artifact.toolCallId ?? null,
        artifactType: artifact.artifactType,
        name: artifact.name ?? null,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes !== undefined ? BigInt(artifact.sizeBytes) : null,
        sha256: artifact.sha256 ?? null,
        storageUri: artifact.storageUri,
        previewUri: artifact.previewUri ?? null,
        metadataJson: jsonInput(artifact.metadata ?? {}),
        createdAt: toDate(artifact.createdAt),
      },
    });
    return artifact;
  }

  async get(scope: RuntimeScope, id: string): Promise<RuntimeArtifact | undefined> {
    const row = await this.db.prisma.piAgentArtifact.findFirst({
      where: { id, deletedAt: null, ...artifactScopeWhere(scope) },
    });
    return row ? artifactFromPrisma(row) : undefined;
  }

  async list(input: RuntimeArtifactListInput): Promise<RuntimeArtifact[]> {
    const rows = await this.db.prisma.piAgentArtifact.findMany({
      where: {
        deletedAt: null,
        ...artifactScopeWhere(input),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: positiveLimit(input.limit),
    });
    return rows.map(artifactFromPrisma).reverse();
  }

  async delete(scope: RuntimeScope, id: string): Promise<boolean> {
    const result = await this.db.prisma.piAgentArtifact.updateMany({
      where: { id, deletedAt: null, ...artifactScopeWhere(scope) },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma record shape is dynamic
type PrismaRecord = Record<string, any>;

async function nextBigIntSeq(aggregatePromise: Promise<unknown>, key: string): Promise<bigint> {
  const aggregate = (await aggregatePromise) as { _max?: Record<string, bigint | null> };
  return (aggregate._max?.[key] ?? 0n) + 1n;
}

function messageCreateInput(
  identity: Identity,
  turn: ConversationTurn,
  id: string,
  role: ConversationMessage['role'],
  text: string,
  messageSeq: bigint,
): Prisma.PiAgentMessageCreateManyInput {
  return {
    id,
    tenantId: identity.tenantId,
    userId: identity.userId,
    workspaceId: identity.workspaceId ?? null,
    sessionId: turn.sessionId,
    conversationId: turn.conversationId,
    turnId: turn.id,
    role,
    contentText: text,
    modelProvider: turn.model.provider,
    modelName: turn.model.model,
    messageSeq,
    createdAt: toDate(turn.createdAt),
  };
}

function timelineWhere(
  input: {
    tenantId?: string;
    sessionId?: string;
    traceId?: string;
    afterSeq?: number;
    beforeSeq?: number;
    cursor?: RuntimeTimelineCursor;
  },
  cursorEventSeq?: bigint,
): Prisma.PiAgentEventWhereInput {
  const clauses: Prisma.PiAgentEventWhereInput[] = [];
  if (input.tenantId) clauses.push({ tenantId: input.tenantId });
  if (input.sessionId) {
    clauses.push({
      OR: [
        { sessionId: input.sessionId },
        { payloadJson: { path: '$.parentSessionId', equals: input.sessionId } },
        { payloadJson: { path: '$.childSessionId', equals: input.sessionId } },
      ],
    });
  }
  if (input.traceId) clauses.push({ traceId: input.traceId });
  if (input.afterSeq !== undefined || input.beforeSeq !== undefined) {
    clauses.push({
      eventSeq: {
        ...(input.afterSeq !== undefined ? { gt: BigInt(input.afterSeq) } : {}),
        ...(input.beforeSeq !== undefined ? { lt: BigInt(input.beforeSeq) } : {}),
      },
    });
  }
  if (input.cursor) {
    const cursorCreatedAt = toDate(input.cursor.createdAt);
    clauses.push(
      cursorEventSeq === undefined
        ? {
            OR: [
              { createdAt: { lt: cursorCreatedAt } },
              { createdAt: cursorCreatedAt, id: { lt: input.cursor.eventId } },
            ],
          }
        : {
            OR: [
              { createdAt: { lt: cursorCreatedAt } },
              { createdAt: cursorCreatedAt, eventSeq: { lt: cursorEventSeq } },
              {
                createdAt: cursorCreatedAt,
                eventSeq: cursorEventSeq,
                id: { lt: input.cursor.eventId },
              },
            ],
          },
    );
  }
  return clauses.length > 0 ? { AND: clauses } : {};
}

function sessionScopeWhere(scope: RuntimeScope): { tenantId: string; userId?: string } {
  return {
    tenantId: scope.tenantId,
    ...(scope.userId ? { userId: scope.userId } : {}),
  };
}

function artifactScopeWhere(scope: RuntimeScope): { tenantId: string; userId?: string } {
  return {
    tenantId: scope.tenantId,
    ...(scope.userId ? { userId: scope.userId } : {}),
  };
}

function sessionFromPrisma(row: PrismaRecord): RuntimeSession {
  const metadata = parseJsonObject(row.metadataJson);
  const metadataModel = isJsonObject(metadata.model) ? metadata.model : {};
  const metadataSession = isJsonObject(metadata.session) ? metadata.session : {};
  const piSessionFilesByModel = parseStringRecord(metadataSession.piSessionFilesByModel);
  return {
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    tenantId: row.tenantId,
    userId: row.userId,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
    ...(row.childSessionId ? { childSessionId: row.childSessionId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.spawnBatchId ? { spawnBatchId: row.spawnBatchId } : {}),
    ...(row.taskRunId ? { taskRunId: row.taskRunId } : {}),
    ...(row.sandboxSessionId ? { sandboxSessionId: row.sandboxSessionId } : {}),
    sandboxStatus: row.sandboxStatus as RuntimeSession['sandboxStatus'],
    model: {
      provider: row.modelProvider,
      model: row.modelName,
      ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
      ...(typeof metadataModel.authProfileId === 'string'
        ? { authProfileId: metadataModel.authProfileId }
        : {}),
      ...(metadataModel.reasoning === true ? { reasoning: true } : {}),
    },
    ...(row.piSessionRef ? { piSessionFile: row.piSessionRef } : {}),
    ...(Object.keys(piSessionFilesByModel).length > 0 ? { piSessionFilesByModel } : {}),
    toolPolicyProfile: row.toolPolicyProfile,
    ...(isJsonObject(metadataSession.metadata) ? { metadata: metadataSession.metadata } : {}),
  };
}

function summaryFromPrismaSession(
  session: RuntimeSession,
  row: PrismaRecord | undefined,
): RuntimeSessionSummary {
  return {
    ...session,
    turnCount: Number(row?.turnCount ?? 0),
    ...(row?.title ? { title: row.title } : {}),
    ...(row ? { updatedAt: toIso(row.updatedAt) } : {}),
    ...(row?.firstUserMessage ? { firstUserMessage: row.firstUserMessage } : {}),
    ...(row?.lastUserMessage ? { lastUserMessage: row.lastUserMessage } : {}),
    ...(row?.lastAssistantMessage ? { lastAssistantMessage: row.lastAssistantMessage } : {}),
    ...(row?.lastMessageAt ? { lastMessageAt: toIso(row.lastMessageAt) } : {}),
  };
}

function turnFromPrisma(row: PrismaRecord): ConversationTurn {
  return {
    id: row.id,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    userMessage: row.inputText ?? '',
    assistantMessage: row.outputText ?? '',
    model: parseModel(row.modelJson),
    ...(row.traceId ? { traceId: row.traceId } : {}),
    createdAt: toIso(row.createdAt),
  };
}

function messageFromPrisma(
  row: PrismaRecord,
  traceIdsByTurnId = new Map<string, string | null>(),
): ConversationMessage {
  const metadata = parseJsonObject(row.contentJson);
  const model =
    row.modelProvider && row.modelName
      ? { provider: row.modelProvider, model: row.modelName }
      : undefined;
  const traceId = row.turnId ? traceIdsByTurnId.get(row.turnId) : undefined;
  return {
    id: row.id,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    role: row.role,
    text: row.contentText ?? '',
    ...(model ? { model } : {}),
    ...(traceId ? { traceId } : {}),
    createdAt: toIso(row.createdAt),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function timelineEventFromPrisma(row: PrismaRecord): RuntimeTimelineEvent {
  const payload = parseJsonValue(row.payloadJson);
  const payloadObject = isJsonObject(payload) ? payload : {};
  return {
    eventId: row.id,
    eventSeq: Number(row.eventSeq),
    eventName: row.eventName,
    eventType: row.eventType,
    eventSource: row.eventSource,
    sessionId: row.sessionId,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.traceId ? { traceId: row.traceId } : {}),
    ...(typeof payloadObject.conversationId === 'string'
      ? { conversationId: payloadObject.conversationId }
      : {}),
    ...(typeof payloadObject.toolCallId === 'string'
      ? { toolCallId: payloadObject.toolCallId }
      : {}),
    ...(typeof payloadObject.parentSessionId === 'string'
      ? { parentSessionId: payloadObject.parentSessionId }
      : {}),
    ...(typeof payloadObject.childSessionId === 'string'
      ? { childSessionId: payloadObject.childSessionId }
      : {}),
    ...(typeof payloadObject.runId === 'string' ? { runId: payloadObject.runId } : {}),
    ...(typeof payloadObject.spawnBatchId === 'string'
      ? { spawnBatchId: payloadObject.spawnBatchId }
      : {}),
    ...(typeof payloadObject.taskRunId === 'string' ? { taskRunId: payloadObject.taskRunId } : {}),
    createdAt: toIso(row.createdAt),
    payload,
  };
}

function memoryFromPrisma(row: PrismaRecord): MemoryRecord {
  const tags = parseStringArray(row.tagsJson);
  const metadata = parseJsonObject(row.metadataJson);
  return {
    id: row.id,
    text: row.text,
    ...(tags.length > 0 ? { tags } : {}),
    createdAt: toIso(row.createdAt),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function subagentFromPrisma(row: PrismaRecord): SubagentRun {
  const error = parseJsonObject(row.errorJson);
  return {
    runId: row.runId,
    taskRunId: row.taskRunId ?? row.runId,
    ...(row.spawnBatchId ? { spawnBatchId: row.spawnBatchId } : {}),
    ...(row.traceId ? { traceId: row.traceId } : {}),
    parentSessionId: row.parentSessionId,
    childSessionId: row.childSessionId,
    ...(row.parentToolCallId ? { parentToolCallId: row.parentToolCallId } : {}),
    task: row.taskText,
    ...(row.agentName ? { agent: row.agentName } : {}),
    ...(row.label ? { label: row.label } : {}),
    status: row.status,
    depth: row.depth,
    model: parseModel(row.modelJson),
    toolPolicyProfile: row.toolPolicyProfile ?? 'default',
    context: 'isolated',
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.endedAt ? { endedAt: toIso(row.endedAt) } : {}),
    ...(row.resultText ? { result: row.resultText } : {}),
    ...(typeof error.message === 'string' ? { error: error.message } : {}),
    events: subagentLifecycleEvents(row.status, row.createdAt, row.startedAt, row.endedAt),
  };
}

function artifactFromPrisma(row: PrismaRecord): RuntimeArtifact {
  const metadata = parseJsonObject(row.metadataJson);
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    sessionId: row.sessionId,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    artifactType: row.artifactType,
    ...(row.name ? { name: row.name } : {}),
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    ...(row.sizeBytes !== null && row.sizeBytes !== undefined
      ? { sizeBytes: Number(row.sizeBytes) }
      : {}),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    storageUri: row.storageUri,
    ...(row.previewUri ? { previewUri: row.previewUri } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    createdAt: toIso(row.createdAt),
  };
}

function subagentLifecycleEvents(
  status: SubagentRunStatus,
  createdAt: Date | string,
  startedAt: Date | string | null,
  endedAt: Date | string | null,
): SubagentLifecycleEvent[] {
  const created = toIso(createdAt);
  const events: SubagentLifecycleEvent[] = [
    { type: 'subagent_spawning', at: created },
    { type: 'subagent_spawned', at: created },
  ];
  if (startedAt) {
    events.push({ type: 'subagent_started', at: toIso(startedAt) });
  }
  if (endedAt) {
    const reason = isTerminalSubagentStatus(status) ? status : 'completed';
    events.push({ type: 'subagent_ended', at: toIso(endedAt), reason });
  }
  return events;
}

function runtimeEventToTimeline(event: RuntimeLifecycleEvent): RuntimeTimelineEventInput {
  return {
    eventId: event.id,
    eventName: 'runtime_event',
    eventType: event.type,
    eventSource: 'runtime',
    sessionId: event.sessionId,
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
    ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.spawnBatchId ? { spawnBatchId: event.spawnBatchId } : {}),
    ...(event.taskRunId ? { taskRunId: event.taskRunId } : {}),
    createdAt: event.createdAt,
    payload: event as JsonValue,
  };
}

function toolEventToTimeline(event: RuntimeToolEvent): RuntimeTimelineEventInput {
  return {
    eventId: event.id,
    eventName: `tool_call_${event.status}`,
    eventType: event.status,
    eventSource: 'tool',
    sessionId: event.sessionId,
    conversationId: event.conversationId,
    ...(event.traceId ? { traceId: event.traceId } : {}),
    toolCallId: event.toolCallId,
    ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
    ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.spawnBatchId ? { spawnBatchId: event.spawnBatchId } : {}),
    ...(event.taskRunId ? { taskRunId: event.taskRunId } : {}),
    createdAt: event.createdAt,
    payload: event as JsonValue,
  };
}

function llmEventToTimeline(event: RuntimeLlmGenerationEvent): RuntimeTimelineEventInput {
  return {
    eventId: event.id,
    eventName: `llm_generation_${event.status}`,
    eventType: event.status,
    eventSource: 'llm',
    sessionId: event.sessionId,
    conversationId: event.conversationId,
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
    ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.spawnBatchId ? { spawnBatchId: event.spawnBatchId } : {}),
    ...(event.taskRunId ? { taskRunId: event.taskRunId } : {}),
    createdAt: event.createdAt,
    payload: event as JsonValue,
  };
}

function timelineListInput(input: { sessionId?: string; traceId?: string; limit?: number }): {
  sessionId?: string;
  traceId?: string;
  limit?: number;
} {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

function runtimeListInput(input: {
  sessionId?: string;
  traceId?: string;
  type?: string;
  limit?: number;
}): {
  sessionId?: string;
  traceId?: string;
  eventType?: string;
  limit?: number;
} {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.type ? { eventType: input.type } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

function parseModel(value: unknown): RuntimeModelConfig {
  const model = parseJsonObject(value);
  return {
    provider: typeof model.provider === 'string' ? model.provider : 'unknown',
    model: typeof model.model === 'string' ? model.model : 'unknown',
    ...(isThinkingLevel(model.thinkingLevel) ? { thinkingLevel: model.thinkingLevel } : {}),
    ...(typeof model.authProfileId === 'string' ? { authProfileId: model.authProfileId } : {}),
    ...(model.reasoning === true ? { reasoning: true } : {}),
  };
}

function isThinkingLevel(
  value: unknown,
): value is NonNullable<RuntimeModelConfig['thinkingLevel']> {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  );
}

function parseJsonObject(value: unknown): JsonObject {
  const parsed = parseJsonValue(value);
  return isJsonObject(parsed) ? parsed : {};
}

function parseJsonValue(value: unknown): JsonValue {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  return isJsonValue(value) ? value : null;
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function parseStringRecord(value: unknown): Record<string, string> {
  const parsed = parseJsonValue(value);
  if (!isJsonObject(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
  }
  return false;
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
}

function stableRowId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48);
  return `${prefix}_${hash}`.slice(0, 64);
}

function positiveLimit(limit: number | undefined): number {
  return limit && limit > 0 ? limit : 200;
}

function omitSubagentError(run: SubagentRun): Omit<SubagentRun, 'error'> {
  const { error: _error, ...rest } = run;
  return rest;
}
