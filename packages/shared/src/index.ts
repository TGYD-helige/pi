export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type RuntimeTrigger = 'user' | 'cron' | 'webhook' | 'memory' | 'system';
export type SenderTrust = 'owner' | 'member' | 'anonymous' | 'service';
export type ToolSource =
  | 'builtin'
  | 'mcp'
  | 'skill'
  | 'memory'
  | 'scheduler'
  | 'sandbox'
  | 'runtime';

export type RuntimeModelConfig = {
  provider: string;
  model: string;
  reasoning?: boolean;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  authProfileId?: string;
};

export type SandboxStatus = 'creating' | 'running' | 'paused' | 'destroyed' | 'failed';

export type RuntimeSession = {
  sessionId: string;
  conversationId: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  sandboxSessionId?: string;
  sandboxStatus: SandboxStatus;
  model: RuntimeModelConfig;
  piSessionFile?: string;
  piSessionFilesByModel?: Record<string, string>;
  toolPolicyProfile: string;
};

export type RuntimeScope = {
  tenantId: string;
  userId?: string;
};

export type ConversationStoreScope = RuntimeScope;

export interface ConversationStore {
  getRuntimeSession(
    scope: ConversationStoreScope,
    sessionId: string,
  ): Promise<RuntimeSession | undefined>;
  saveRuntimeSession(session: RuntimeSession): Promise<void>;
}

export type ConversationTurn = {
  id: string;
  sessionId: string;
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  model: RuntimeModelConfig;
  traceId?: string;
  createdAt: string;
};

export type ConversationMessage = {
  id: string;
  sessionId: string;
  conversationId: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  model?: RuntimeModelConfig;
  traceId?: string;
  createdAt: string;
  metadata?: JsonObject;
};

export type RuntimeSessionSummary = RuntimeSession & {
  title?: string;
  updatedAt?: string;
  turnCount: number;
  firstUserMessage?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  lastMessageAt?: string;
};

export type ConversationHistoryStore = {
  appendTurn(turn: ConversationTurn): Promise<void>;
  listTurns(scope: RuntimeScope, sessionId?: string): Promise<ConversationTurn[]>;
  listMessages(scope: RuntimeScope, sessionId: string): Promise<ConversationMessage[]>;
  listSessionSummaries(
    scope: RuntimeScope,
    sessions: RuntimeSession[],
  ): Promise<RuntimeSessionSummary[]>;
  updateSessionTitle?(scope: RuntimeScope, sessionId: string, title: string): Promise<void>;
};

export type RuntimeSessionStore = Omit<ConversationStore, 'getRuntimeSession'> & {
  getRuntimeSession(scope: RuntimeScope, sessionId: string): Promise<RuntimeSession | undefined>;
  listRuntimeSessions(
    scope: RuntimeScope,
    options?: { limit?: number; offset?: number },
  ): Promise<RuntimeSession[]>;
};

export type TranscriptStore = ConversationHistoryStore;

export type MemoryRecord = {
  id: string;
  text: string;
  tags?: string[];
  createdAt: string;
  metadata?: JsonObject;
};

export interface MemoryStore {
  write(input: {
    sessionId: string;
    text: string;
    tags?: string[];
    metadata?: JsonObject;
  }): Promise<MemoryRecord>;
  search(input: { sessionId: string; query: string; limit: number }): Promise<MemoryRecord[]>;
}

export type CopilotMemoryStore = MemoryStore;

export type AppendOnlyEventStore<T> = {
  append(event: T): Promise<void>;
};

export type ToolEventStore = AppendOnlyEventStore<RuntimeToolEvent> & {
  list(input?: {
    sessionId?: string;
    traceId?: string;
    limit?: number;
  }): Promise<RuntimeToolEvent[]>;
};

export type RuntimeEventStore = AppendOnlyEventStore<RuntimeLifecycleEvent> & {
  list(input?: {
    sessionId?: string;
    traceId?: string;
    type?: string;
    limit?: number;
  }): Promise<RuntimeLifecycleEvent[]>;
};

export type LlmGenerationEventStore = AppendOnlyEventStore<RuntimeLlmGenerationEvent> & {
  list(input?: {
    sessionId?: string;
    traceId?: string;
    limit?: number;
  }): Promise<RuntimeLlmGenerationEvent[]>;
};

export type RuntimeTimelineEventSource = 'runtime' | 'tool' | 'llm';

export type RuntimeTimelineEvent = {
  eventId: string;
  eventSeq: number;
  eventName: string;
  eventType: string;
  eventSource: RuntimeTimelineEventSource;
  sessionId: string;
  conversationId?: string;
  turnId?: string;
  traceId?: string;
  toolCallId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  createdAt: string;
  payload: JsonValue;
};

export type RuntimeTimelineEventInput = Omit<RuntimeTimelineEvent, 'eventSeq'>;

export type RuntimeTimelineCursor = {
  createdAt: string;
  eventId: string;
  eventSeq?: number;
};

export type RuntimeTimelineEventStore = AppendOnlyEventStore<RuntimeTimelineEventInput> & {
  list(
    input: RuntimeScope & {
      sessionId?: string;
      traceId?: string;
      afterSeq?: number;
      beforeSeq?: number;
      cursor?: RuntimeTimelineCursor;
      limit?: number;
    },
  ): Promise<RuntimeTimelineEvent[]>;
};

export type RuntimeArtifact = {
  id: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  artifactType: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  storageUri: string;
  previewUri?: string;
  metadata?: JsonObject;
  createdAt: string;
};

export type RuntimeArtifactCreateInput = Omit<RuntimeArtifact, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: string;
};

export type RuntimeArtifactListInput = RuntimeScope & {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  limit?: number;
};

export interface RuntimeArtifactStore {
  create(input: RuntimeArtifactCreateInput): Promise<RuntimeArtifact>;
  get(scope: RuntimeScope, id: string): Promise<RuntimeArtifact | undefined>;
  list(input: RuntimeArtifactListInput): Promise<RuntimeArtifact[]>;
  delete(scope: RuntimeScope, id: string): Promise<boolean>;
}

export type SubagentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type SubagentLifecycleEvent = {
  type: 'subagent_spawning' | 'subagent_spawned' | 'subagent_started' | 'subagent_ended';
  at: string;
  reason?: string;
};

export type SubagentRun = {
  runId: string;
  taskRunId?: string;
  spawnBatchId?: string;
  traceId?: string;
  parentSessionId: string;
  childSessionId: string;
  parentToolCallId?: string;
  task: string;
  agent?: string;
  label?: string;
  status: SubagentRunStatus;
  depth: number;
  model: RuntimeModelConfig;
  toolPolicyProfile: string;
  context: 'isolated';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  result?: string;
  error?: string;
  events: SubagentLifecycleEvent[];
};

export interface SubagentRunStore {
  create(
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
  ): Promise<SubagentRun>;
  list(scope: RuntimeScope, parentSessionId?: string): Promise<SubagentRun[]>;
  get(scope: RuntimeScope, runId: string): Promise<SubagentRun | undefined>;
  getDepthForSession(scope: RuntimeScope, sessionId: string): Promise<number>;
  countActiveChildren(scope: RuntimeScope, parentSessionId: string): Promise<number>;
  markRunning(scope: RuntimeScope, runId: string): Promise<SubagentRun | undefined>;
  markCompleted(
    scope: RuntimeScope,
    runId: string,
    result: string,
  ): Promise<SubagentRun | undefined>;
  markFailed(scope: RuntimeScope, runId: string, error: string): Promise<SubagentRun | undefined>;
  markCancelled(
    scope: RuntimeScope,
    runId: string,
    reason?: string,
  ): Promise<SubagentRun | undefined>;
}

export type ToolCallRequest = {
  id: string;
  name: string;
  source: ToolSource;
  args: JsonObject;
};

export type ToolCallResult = {
  id: string;
  name: string;
  content: JsonValue;
  isError?: boolean;
  metadata?: JsonObject;
};

export type RuntimeToolEventStatus = 'started' | 'completed' | 'failed';

export type RuntimeToolEvent = {
  id: string;
  traceId?: string;
  sessionId: string;
  conversationId: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  parentToolCallId?: string;
  childIndex?: number;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  toolCallId: string;
  toolName: string;
  status: RuntimeToolEventStatus;
  createdAt: string;
  durationMs?: number;
  args?: JsonObject;
  details?: JsonObject;
  error?: string;
};

export type RuntimeLlmGenerationEventStatus = 'started' | 'completed' | 'failed';

export type RuntimeLlmUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type RuntimeLlmGenerationEvent = {
  id: string;
  traceId?: string;
  sessionId: string;
  conversationId: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  llmGenerationId: string;
  status: RuntimeLlmGenerationEventStatus;
  createdAt: string;
  durationMs?: number;
  model: RuntimeModelConfig;
  input?: JsonValue;
  output?: JsonValue;
  usage?: RuntimeLlmUsage;
  responseId?: string;
  stopReason?: string;
  error?: string;
};

export type RuntimeLifecycleEventType =
  | 'chat_turn_started'
  | 'chat_turn_steered'
  | 'chat_turn_steer_delivered'
  | 'chat_turn_followup_queued'
  | 'chat_turn_followup_delivered'
  | 'chat_turn_completed'
  | 'chat_turn_failed'
  | 'subagent_spawned'
  | 'subagent_started'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'subagent_cancelled';

export type RuntimeLifecycleEvent = {
  id: string;
  traceId?: string;
  type: RuntimeLifecycleEventType;
  sessionId: string;
  conversationId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  parentToolCallId?: string;
  childIndex?: number;
  createdAt: string;
  durationMs?: number;
  model?: RuntimeModelConfig;
  toolPolicyProfile?: string;
  details?: JsonObject;
  error?: string;
};

export type RuntimeRequestContext = {
  traceId?: string;
  tenantId?: string;
  userId?: string;
  sessionId: string;
  conversationId: string;
  workspaceId?: string;
  trigger: RuntimeTrigger;
  senderTrust: SenderTrust;
  interactive: boolean;
  model: RuntimeModelConfig;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
};

export type ExecEvent =
  | { type: 'start'; pid?: number }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null; signal?: string };

export type SandboxExecRequest = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type SandboxRunCodeRequest = {
  language: string;
  code: string;
  cwd?: string;
  timeoutMs?: number;
};

export type SandboxFileEntry = {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  modifiedAt?: string;
};

export {
  assertPublicHttpUrl,
  type DnsLookup,
  readResponseBytes,
  resolvePublicHttpUrl,
  safeFetch,
} from './network.js';
export {
  createSourceObservationReceipt,
  type SourceObservationInput,
  type SourceObservationReceiptV1,
  sanitizeObservationLocator,
} from './source-observation.js';
