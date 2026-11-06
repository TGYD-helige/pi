import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';

export function projectPhoenixSpan(
  span: ReadableSpan,
  includePayloads: boolean,
  resource = span.resource,
): ReadableSpan {
  const source = span.attributes;
  const attributes: Attributes = Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.startsWith('langfuse.')),
  );
  const observationType = source['langfuse.observation.type'];
  const kind =
    observationType === 'generation'
      ? 'LLM'
      : observationType === 'tool'
        ? 'TOOL'
        : span.name === 'chat-turn' || span.name.startsWith('subagent')
          ? 'AGENT'
          : 'CHAIN';
  attributes['openinference.span.kind'] = kind;

  const sessionId = source['langfuse.session.id'];
  if (typeof sessionId === 'string') attributes['session.id'] = sessionId;
  mapPayload(attributes, 'input', includePayloads);
  mapPayload(attributes, 'output', includePayloads);

  if (kind === 'LLM') {
    mapLlmAttributes(attributes, source);
  } else if (kind === 'TOOL') {
    if (typeof source.toolName === 'string') attributes['tool.name'] = source.toolName;
    if (typeof source.toolCallId === 'string') attributes['tool.id'] = source.toolCallId;
  }

  const events = [...span.events];
  const completionStartTime = source['langfuse.observation.completion_start_time'];
  if (kind === 'LLM' && typeof completionStartTime === 'string') {
    const timestamp = Date.parse(completionStartTime);
    if (Number.isFinite(timestamp)) {
      events.push({
        name: 'first_token',
        time: millisecondsToHrTime(timestamp),
        droppedAttributesCount: 0,
      } satisfies TimedEvent);
    }
  }
  return Object.assign(Object.create(Object.getPrototypeOf(span)), span, {
    attributes,
    events,
    resource,
  }) as ReadableSpan;
}

function mapLlmAttributes(attributes: Attributes, source: Attributes): void {
  const modelName = source['langfuse.observation.model.name'];
  if (typeof modelName === 'string') attributes['llm.model_name'] = modelName;
  const modelParameters = jsonRecord(source['langfuse.observation.model.parameters']);
  if (typeof modelParameters?.provider === 'string') {
    attributes['llm.system'] = modelParameters.provider;
    attributes['llm.provider'] = modelParameters.provider;
  }

  const usage = jsonRecord(source.usage);
  if (!usage) return;
  const prompt = isNonNegativeFiniteNumber(usage.input)
    ? sumReported(usage.input, usage.cacheRead, usage.cacheWrite)
    : undefined;
  if (prompt !== undefined) attributes['llm.token_count.prompt'] = prompt;
  if (isNonNegativeFiniteNumber(usage.output))
    attributes['llm.token_count.completion'] = usage.output;
  const total = isNonNegativeFiniteNumber(usage.totalTokens)
    ? usage.totalTokens
    : isNonNegativeFiniteNumber(usage.input) && isNonNegativeFiniteNumber(usage.output)
      ? sumReported(usage.input, usage.output, usage.cacheRead, usage.cacheWrite)
      : undefined;
  if (total !== undefined) attributes['llm.token_count.total'] = total;
  if (isNonNegativeFiniteNumber(usage.cacheRead)) {
    attributes['llm.token_count.prompt_details.cache_read'] = usage.cacheRead;
  }
  if (isNonNegativeFiniteNumber(usage.cacheWrite)) {
    attributes['llm.token_count.prompt_details.cache_write'] = usage.cacheWrite;
  }
  if (
    isNonNegativeFiniteNumber(usage.reasoning) &&
    isNonNegativeFiniteNumber(usage.output) &&
    usage.reasoning <= usage.output
  ) {
    attributes['llm.token_count.completion_details.reasoning'] = usage.reasoning;
  }
  if (usage.costSource === 'unknown') return;
  const cost = jsonRecord(usage.cost);
  if (!cost) return;
  const promptCost = isNonNegativeFiniteNumber(cost.input)
    ? sumReported(cost.input, cost.cacheRead, cost.cacheWrite)
    : undefined;
  if (promptCost !== undefined) attributes['llm.cost.prompt'] = promptCost;
  if (isNonNegativeFiniteNumber(cost.output)) {
    attributes['llm.cost.completion'] = cost.output;
  }
  if (isNonNegativeFiniteNumber(cost.total)) attributes['llm.cost.total'] = cost.total;
  for (const [sourceKey, targetKey] of [
    ['input', 'llm.cost.prompt_details.input'],
    ['cacheRead', 'llm.cost.prompt_details.cache_read'],
    ['cacheWrite', 'llm.cost.prompt_details.cache_write'],
  ] as const) {
    const value = cost[sourceKey];
    if (isNonNegativeFiniteNumber(value)) attributes[targetKey] = value;
  }
}

function mapPayload(attributes: Attributes, direction: 'input' | 'output', include: boolean): void {
  const valueKey = `${direction}.value`;
  const mimeKey = `${direction}.mime_type`;
  if (!include) {
    delete attributes[valueKey];
    delete attributes[mimeKey];
    return;
  }
  const value = attributes[valueKey];
  if (typeof value !== 'string') return;
  const parsed = parseJson(value);
  if (typeof parsed === 'string') attributes[valueKey] = parsed;
  attributes[mimeKey] =
    typeof parsed === 'string' || parsed === undefined ? 'text/plain' : 'application/json';
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sumReported(...values: unknown[]): number | undefined {
  const reported = values.filter(isNonNegativeFiniteNumber);
  return reported.length > 0 ? reported.reduce((sum, value) => sum + value, 0) : undefined;
}

function millisecondsToHrTime(milliseconds: number): [number, number] {
  const seconds = Math.floor(milliseconds / 1000);
  return [seconds, Math.round((milliseconds - seconds * 1000) * 1_000_000)];
}
