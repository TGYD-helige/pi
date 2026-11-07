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
    !value
      .slice(-100)
      .every(
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
  for (const message of value.slice(0, 100)) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !Array.isArray(message.tools)
    )
      continue;
    if (message.tools.length > 100) omittedTools = true;
    for (const raw of message.tools.slice(0, 100)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        omittedTools = true;
        continue;
      }
      const declarations = Array.isArray(raw.functionDeclarations)
        ? raw.functionDeclarations
        : [raw.function ?? raw];
      if (declarations.length > 100) omittedTools = true;
      for (const declaration of declarations.slice(0, 100)) {
        if (
          !declaration ||
          typeof declaration !== 'object' ||
          Array.isArray(declaration) ||
          typeof declaration.name !== 'string'
        ) {
          omittedTools = true;
          continue;
        }
        const tool: JsonObject = {
          name: declaration.name,
          ...(typeof declaration.description === 'string'
            ? { description: declaration.description }
            : {}),
          ...((declaration.parameters ?? declaration.input_schema)
            ? { parameters: declaration.parameters ?? declaration.input_schema }
            : {}),
        };
        const encoded = boundedJson(tool, 100_000 - toolBytes);
        const size = encoded === undefined ? 100_001 : Buffer.byteLength(encoded) + 1;
        if (tools.length >= 100 || toolBytes + size > 100_000) {
          omittedTools = true;
          break;
        }
        tools.push(tool);
        toolBytes += size;
      }
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
    const message = value[index] as JsonObject;
    const encoded = boundedJson(message, 500_000 - bytes - 1, true);
    let item: JsonObject = encoded === undefined ? {} : JSON.parse(encoded);
    let size = encoded === undefined ? 500_001 : Buffer.byteLength(encoded) + 1;
    if (bytes + size > 500_000) {
      if (selected.length) break;
      const content =
        typeof message.content === 'string'
          ? message.content
          : (boundedJson(message.content ?? null, Math.max(0, 500_000 - bytes)) ??
            '[structured content omitted]');
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

// Stop walking before allocating a serialized oversized message or tool schema.
function boundedJson(value: JsonValue, maxBytes: number, skipTools = false): string | undefined {
  const limit = new Error('Display budget exceeded');
  const ancestors = new Set<object>();
  let remaining = maxBytes;
  let nodes = 0;
  function token(value: JsonValue): string {
    if (typeof value === 'string' && value.length > remaining) throw limit;
    const encoded = JSON.stringify(value);
    remaining -= Buffer.byteLength(encoded);
    if (remaining < 0) throw limit;
    return encoded;
  }
  function encode(value: JsonValue | undefined, depth: number): string {
    if (++nodes > 10_000 || depth > 32) throw limit;
    if (!value || typeof value !== 'object') return token(value ?? null);
    if (ancestors.has(value)) throw limit;
    ancestors.add(value);
    remaining -= 2;
    if (remaining < 0) throw limit;
    try {
      const parts: string[] = [];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (parts.length) remaining--;
          parts.push(encode(item, depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      for (const key in value) {
        if (!Object.hasOwn(value, key) || (skipTools && depth === 0 && key === 'tools')) continue;
        const field = value[key];
        if (field === undefined) continue;
        if (parts.length) remaining--;
        const name = token(key);
        remaining--;
        parts.push(`${name}:${encode(field, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  try {
    return encode(value, 0);
  } catch (error) {
    if (error !== limit) throw error;
    return undefined;
  }
}
