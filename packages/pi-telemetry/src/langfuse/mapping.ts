import type {
  JsonObject,
  JsonValue,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';
import { utf8Prefix } from '../otel/utils.js';

export function langfuseObservationAttributes(input: {
  input?: JsonValue | undefined;
  output?: JsonValue | undefined;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
  type?: 'span' | 'generation' | 'tool';
}): JsonObject {
  const serializedInput = input.input === undefined ? undefined : serializeObservation(input.input);
  const serializedOutput =
    input.output === undefined ? undefined : serializeObservation(input.output);
  return {
    'langfuse.observation.type': input.type ?? 'span',
    ...(input.input !== undefined
      ? {
          'langfuse.observation.input': serializedInput,
          'input.value': serializedInput,
        }
      : {}),
    ...(input.output !== undefined
      ? {
          'langfuse.observation.output': serializedOutput,
          'output.value': serializedOutput,
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

// Reserve tool definitions and omission markers before retaining recent history.
function serializeObservation(value: JsonValue): string {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (typeof item.role === 'string' ||
          ['function_call', 'function_call_output', 'reasoning'].includes(String(item.type))),
    )
  )
    return JSON.stringify(value);
  const tools: JsonValue[] = [];
  let toolBytes = 0;
  let omittedTools = false;
  for (const message of value) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !Array.isArray(message.tools)
    )
      continue;
    for (const tool of message.tools) {
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1;
      if (tools.length >= 100 || toolBytes + size > 100_000) {
        omittedTools = true;
        break;
      }
      tools.push(tool);
      toolBytes += size;
    }
    break;
  }
  const marker: JsonObject = {
    role: 'system',
    content: '[Earlier messages or oversized content omitted by telemetry budget]',
    telemetryTruncated: true,
  };
  if (tools.length) marker.tools = tools;
  if (omittedTools) marker.content = `${marker.content} [Some tool definitions omitted]`;
  const selected: JsonValue[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(marker)) + 2;
  let truncated = omittedTools;
  for (let index = value.length - 1; index >= 0 && selected.length < 99; index--) {
    const { tools: _tools, ...message } = value[index] as JsonObject;
    let item: JsonObject = message;
    let size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > 500_000) {
      if (selected.length) break;
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? message);
      item = {
        role: typeof message.role === 'string' ? message.role : 'assistant',
        content: `${utf8Prefix(content, Math.max(0, Math.floor((500_000 - bytes) / 6) - 100))} [message preview truncated]`,
      };
      size = Buffer.byteLength(JSON.stringify(item)) + 1;
      truncated = true;
    }
    selected.unshift(item);
    bytes += size;
  }
  if (selected.length < value.length || truncated) selected.unshift(marker);
  else if (
    tools.length &&
    selected[0] &&
    typeof selected[0] === 'object' &&
    !Array.isArray(selected[0])
  )
    selected[0] = { ...selected[0], tools };
  return JSON.stringify(selected);
}
