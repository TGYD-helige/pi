import type { JsonObject, JsonValue } from '@amaster.ai/pi-shared';

const MODEL_PARAMETER_KEYS = new Set([
  'temperature',
  'top_p',
  'topP',
  'top_k',
  'topK',
  'max_tokens',
  'maxTokens',
  'max_output_tokens',
  'maxOutputTokens',
  'max_completion_tokens',
  'reasoning_effort',
  'reasoningEffort',
  'effort',
  'budget_tokens',
  'thinking_budget',
  'thinkingBudget',
  'thinkingLevel',
  'includeThoughts',
  'cache_ttl',
  'service_tier',
  'tool_choice',
  'frequency_penalty',
  'presence_penalty',
]);

export function modelParameters(payload: unknown, thinkingLevel?: string): JsonObject {
  const parameters: JsonObject = thinkingLevel ? { thinkingLevel } : {};
  function visit(value: unknown, depth: number): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return;
    for (const [key, item] of Object.entries(value)) {
      if (
        MODEL_PARAMETER_KEYS.has(key) &&
        ((typeof item === 'number' && Number.isFinite(item)) ||
          typeof item === 'boolean' ||
          (typeof item === 'string' && item.length <= 200))
      ) {
        parameters[key] = item;
      } else if (
        [
          'config',
          'generationConfig',
          'thinkingConfig',
          'reasoning',
          'thinking',
          'samplingParams',
        ].includes(key)
      ) {
        visit(item, depth + 1);
      }
    }
  }
  visit(payload, 0);
  return parameters;
}

export function hasFirstToken(update: Record<string, unknown>, message: unknown): boolean {
  if (
    ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(String(update.type)) &&
    typeof update.delta === 'string' &&
    update.delta.length > 0
  )
    return true;
  if (!message || typeof message !== 'object') return false;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.length > 0;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part &&
        ((part.type === 'text' && part.text?.length > 0) ||
          (part.type === 'thinking' && part.thinking?.length > 0) ||
          (part.type === 'toolCall' && part.name?.length > 0)),
    )
  );
}

export function toTelemetryValue(
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  )
    return value;
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => toTelemetryValue(item, ancestors)).filter((item) => item !== undefined)
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, toTelemetryValue(item, ancestors)]),
      );
  ancestors.delete(value);
  return result;
}

export function isInlineImage(mime: string, data: string): boolean {
  return (
    /^image\/(png|jpeg|webp|gif)$/.test(mime) &&
    data.length > 0 &&
    data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data)
  );
}

export function displayContent(content: unknown, mediaEnabled = false): JsonValue {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: JsonObject[] = [];
  let mediaBytes = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string')
      parts.push({ type: 'text', text: part.text });
    if (part.type === 'image') {
      const mime = typeof part.mimeType === 'string' ? part.mimeType : 'unknown';
      const data = typeof part.data === 'string' ? part.data.replace(/\s+/g, '') : '';
      // ponytail: inline media stays below the attribute cap; larger images use markers.
      if (mediaEnabled && mediaBytes + data.length <= 600_000 && isInlineImage(mime, data)) {
        mediaBytes += data.length;
        parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
      } else {
        parts.push({ type: 'text', text: `[image ${mime}, binary omitted]` });
      }
    }
  }
  return parts.every((part) => part.type === 'text')
    ? parts.map((part) => part.text).join('\n')
    : parts;
}

export function displayMessage(message: unknown, systemUpdate = false): JsonObject | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const msg = message as Record<string, unknown>;
  const role = msg.role === 'toolResult' ? 'tool' : msg.role;
  if (!['user', 'assistant', 'system', 'tool'].includes(String(role))) return undefined;
  const content = displayContent(msg.content);
  const result: JsonObject = { role: String(role), content };
  if (role === 'system') {
    const sections =
      msg.sections && typeof msg.sections === 'object' && !Array.isArray(msg.sections)
        ? Object.entries(msg.sections).flatMap(([name, text]) =>
            text === null && systemUpdate
              ? [`Removed system prompt section "${name}".`]
              : typeof text === 'string'
                ? [systemUpdate ? `Updated system prompt section "${name}":\n\n${text}` : text]
                : [],
          )
        : [];
    result.content = [typeof content === 'string' ? content : '', ...sections]
      .filter(Boolean)
      .join('\n\n');
    if (Array.isArray(msg.toolsAdded)) result.tools = toTelemetryValue(msg.toolsAdded);
  }
  if (typeof msg.toolCallId === 'string') result.tool_call_id = msg.toolCallId;
  if (typeof msg.toolName === 'string') result.name = msg.toolName;
  if (Array.isArray(msg.content)) {
    const thinking = msg.content
      .filter(
        (part) => part?.type === 'thinking' && !part.redacted && typeof part.thinking === 'string',
      )
      .map((part) => ({
        type: 'thinking',
        content: part.thinking,
        ...(typeof part.thinkingSignature === 'string'
          ? { signature: part.thinkingSignature }
          : {}),
      }));
    if (thinking.length) result.thinking = thinking;
    const redacted = msg.content
      .filter(
        (part) =>
          part?.type === 'thinking' && part.redacted && typeof part.thinkingSignature === 'string',
      )
      .map((part) => ({ type: 'redacted_thinking', data: part.thinkingSignature }));
    if (redacted.length) result.redacted_thinking = redacted;
    const calls = msg.content
      .filter((part) => part?.type === 'toolCall')
      .map((part) => ({
        id: String(part.id),
        type: 'function',
        function: {
          name: String(part.name),
          arguments: JSON.stringify(toTelemetryValue(part.arguments) ?? {}),
        },
      }));
    if (calls.length) result.tool_calls = calls;
  }
  return result;
}
