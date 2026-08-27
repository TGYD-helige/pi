import type {
  JsonObject,
  JsonValue,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';

export function langfuseObservationAttributes(input: {
  input?: JsonValue | undefined;
  output?: JsonValue | undefined;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
  type?: 'span' | 'generation';
}): JsonObject {
  return {
    'langfuse.observation.type': input.type ?? 'span',
    ...(input.input !== undefined
      ? {
          'langfuse.observation.input': JSON.stringify(input.input),
          'input.value': JSON.stringify(input.input),
        }
      : {}),
    ...(input.output !== undefined
      ? {
          'langfuse.observation.output': JSON.stringify(input.output),
          'output.value': JSON.stringify(input.output),
        }
      : {}),
    ...(input.level ? { 'langfuse.observation.level': input.level } : {}),
  };
}

export function chatSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'sessionId' | 'conversationId' | 'parentSessionId'>,
): string {
  const sessionId = event.parentSessionId ?? event.sessionId;
  const conversationId = event.parentSessionId ?? event.conversationId ?? sessionId;
  return `chat:${sessionId}:${conversationId}`;
}

export function subagentSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'runId' | 'childSessionId' | 'id'>,
): string {
  return `subagent:${event.runId ?? event.childSessionId ?? event.id}`;
}

export function telemetryEventSubagentSpanKey(
  event: Pick<RuntimeToolEvent | RuntimeLlmGenerationEvent, 'runId' | 'childSessionId'>,
): string | undefined {
  return event.runId || event.childSessionId
    ? `subagent:${event.runId ?? event.childSessionId}`
    : undefined;
}

export function toolSpanKey(
  event: Pick<RuntimeToolEvent, 'sessionId' | 'toolCallId' | 'toolName'>,
): string {
  return `tool:${event.sessionId}:${event.toolCallId}:${event.toolName}`;
}

export function subagentSpawnToolSpanKey(
  event: Pick<RuntimeLifecycleEvent, 'parentSessionId' | 'parentToolCallId'>,
): string | undefined {
  return event.parentSessionId && event.parentToolCallId
    ? `tool:${event.parentSessionId}:${event.parentToolCallId}:sessions_spawn`
    : undefined;
}

export function llmGenerationKey(
  event: Pick<RuntimeLlmGenerationEvent, 'sessionId' | 'llmGenerationId'>,
): string {
  return `llm-generation:${event.sessionId}:${event.llmGenerationId}`;
}

export function toolObservationName(event: Pick<RuntimeToolEvent, 'toolName' | 'args'>): string {
  const summary = summarizeToolArgsForName(event.toolName, event.args);
  return summary ? `${event.toolName} [${summary}]` : event.toolName;
}

export function chatInputObservationName(event: RuntimeLifecycleEvent): string {
  const prefix = chatInputObservationPrefix(event.type);
  const input =
    typeof event.details?.input === 'string'
      ? truncateObservationSummary(event.details.input)
      : undefined;
  return input ? `${prefix} [${input}]` : prefix;
}

export function chatInputObservationPrefix(type: RuntimeLifecycleEvent['type']): string {
  if (type === 'chat_turn_steered') {
    return 'chat-steer';
  }
  if (type === 'chat_turn_steer_delivered') {
    return 'chat-steer-delivered';
  }
  if (type === 'chat_turn_followup_delivered') {
    return 'chat-followup-delivered';
  }
  return 'chat-followup';
}

export function chatInputLifecycleOutput(event: RuntimeLifecycleEvent): JsonObject {
  return event.type === 'chat_turn_steer_delivered' || event.type === 'chat_turn_followup_delivered'
    ? { delivered: true, turnMode: event.details?.turnMode }
    : { accepted: true, turnMode: event.details?.turnMode };
}

export function subagentObservationName(event: RuntimeLifecycleEvent): string {
  const agent = stringArg(event.details, 'agent');
  return agent ? `subagent [${truncateObservationSummary(agent)}]` : 'subagent';
}

export function summarizeToolArgsForName(
  toolName: string,
  args: JsonObject | undefined,
): string | undefined {
  if (!args) {
    return undefined;
  }
  const pathValue =
    stringArg(args, 'path') ?? stringArg(args, 'filePath') ?? stringArg(args, 'absolutePath');
  if (pathValue) {
    return truncateObservationSummary(pathValue);
  }
  const command = stringArg(args, 'command');
  if (command) {
    return truncateObservationSummary(command);
  }
  const query = stringArg(args, 'query');
  if (query) {
    return truncateObservationSummary(query);
  }
  const task = stringArg(args, 'task');
  if (task && toolName === 'sessions_spawn') {
    return truncateObservationSummary(task);
  }
  const code = stringArg(args, 'code');
  if (code) {
    return truncateObservationSummary(code);
  }
  const name = stringArg(args, 'name');
  if (name && toolName.startsWith('mcp_')) {
    return truncateObservationSummary(name);
  }
  return undefined;
}

export function llmGenerationObservationName(
  event: Pick<RuntimeLlmGenerationEvent, 'input' | 'runId' | 'childSessionId'>,
): string {
  return `llm-generation [${event.runId || event.childSessionId ? 'subagent' : 'main'}] [${summarizeLlmGenerationInputForName(event.input)}]`;
}

export function summarizeLlmGenerationInputForName(input: JsonValue | undefined): string {
  if (typeof input === 'string') {
    return truncateObservationSummary(input);
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const continuation = input.continuation === true;
    const index =
      typeof input.llmGenerationIndex === 'number' ? input.llmGenerationIndex : undefined;
    const toolResults =
      typeof input.previousToolResultCount === 'number' ? input.previousToolResultCount : undefined;
    if (continuation) {
      return truncateObservationSummary(
        `continuation${index !== undefined ? ` #${index}` : ''}${toolResults !== undefined ? ` after ${toolResults} tool result(s)` : ''}`,
      );
    }
  }
  return 'request';
}

export function stringArg(args: JsonObject | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function truncateObservationSummary(value: string, maxLength = 90): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
