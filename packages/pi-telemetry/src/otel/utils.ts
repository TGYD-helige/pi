import type { RuntimeLlmGenerationEvent, RuntimeToolEvent } from '@amaster.ai/pi-shared';
import { credentialMaskValues } from '../config.js';
import type {
  RuntimeLlmStreamEvent,
  RuntimeTelemetryEvent,
  RuntimeTelemetryOptions,
} from '../index.js';
import { isInlineImage } from '../observations.js';
import { MAX_ATTRIBUTE_VALUE_BYTES } from './types.js';

export function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value.slice(0, maxBytes + 1), 'utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

export function truncateAttributePayload(value: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_ATTRIBUTE_VALUE_BYTES) {
    return value;
  }
  value = value.replace(
    /data:[^;,]{1,100};base64,[A-Za-z0-9+/]+=*/g,
    '[image binary omitted before truncation]',
  );
  if (Buffer.byteLength(value, 'utf8') <= MAX_ATTRIBUTE_VALUE_BYTES) return value;
  if (isStructuredJson(value)) {
    return JSON.stringify({
      truncated: true,
      originalBytes: bytes,
      preview: utf8Prefix(value, 64_000),
    });
  }
  // Byte-accurate: the cap is UTF-8 bytes, and slicing by UTF-16 code units
  // would let multibyte-heavy payloads slip past it.
  const marker = `... [truncated ${bytes - MAX_ATTRIBUTE_VALUE_BYTES} bytes]`;
  return `${utf8Prefix(value, MAX_ATTRIBUTE_VALUE_BYTES - Buffer.byteLength(marker))}${marker}`;
}

export function isStructuredJson(value: string): boolean {
  const first = value.trimStart()[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeOtelTracesEndpoint(endpoint: string): string {
  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

export function shortCorrelationId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.startsWith('trace:') ? value.slice('trace:'.length) : value;
  const uuid = normalized.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];
  if (uuid) {
    return uuid.slice(0, 8);
  }
  if (/^[0-9a-f]{32}$/i.test(normalized)) {
    return normalized.slice(0, 8);
  }
  return normalized.length > 24 ? normalized.slice(0, 12) : normalized;
}

export function compactSessionId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [root, ...subagents] = value.split(':subagent:');
  if (subagents.length === 0) {
    return value;
  }
  return [
    root,
    ...subagents.map((sessionId) => `sub:${shortCorrelationId(sessionId) ?? sessionId}`),
  ].join('/');
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected telemetry event type: ${String(value)}`);
}

export function requireTraceId(traceId: string | undefined): string {
  if (!traceId) {
    throw new Error('Telemetry event is missing traceId');
  }
  return traceId;
}

export function isToolEvent(event: RuntimeTelemetryEvent): event is RuntimeToolEvent {
  return 'toolCallId' in event;
}

export function isLlmGenerationEvent(
  event: RuntimeTelemetryEvent,
): event is RuntimeLlmGenerationEvent {
  return 'llmGenerationId' in event && !('streamEvents' in event);
}

export function isLlmStreamEvent(event: RuntimeTelemetryEvent): event is RuntimeLlmStreamEvent {
  return 'streamEvents' in event;
}

export function applyTelemetryRedaction(
  config: Pick<
    RuntimeTelemetryOptions,
    'includePayloads' | 'redactEvent' | 'mediaUploadEnabled' | 'maskingSecrets' | 'redactFields'
  > & {
    langfuse?: { publicKey: string; secretKey: string };
    phoenix?: { apiKey?: string };
    headers?: Record<string, string>;
  },
  event: RuntimeTelemetryEvent,
): RuntimeTelemetryEvent | undefined {
  const redacted = config.redactEvent ? config.redactEvent(event) : event;
  if (!redacted) {
    return undefined;
  }
  const stripped = config.includePayloads === false ? stripTelemetryPayloads(redacted) : redacted;
  const payloadKeys = [
    'input',
    'output',
    'displayInput',
    'displayOutput',
    'args',
    'details',
    'streamEvents',
    'error',
    'contextMetadata',
  ];
  const fieldsRedacted = config.redactFields?.length
    ? Object.fromEntries(
        Object.entries(stripped).map(([key, value]) => [
          key,
          payloadKeys.includes(key) ? redactTelemetryValue(config, value) : value,
        ]),
      )
    : stripped;
  return redactTelemetryValue(
    { ...config, redactFields: [] },
    fieldsRedacted,
  ) as RuntimeTelemetryEvent;
}

export function redactTelemetryValue(
  config: RuntimeTelemetryOptions & {
    langfuse?: { publicKey: string; secretKey: string };
    phoenix?: { apiKey?: string };
    headers?: Record<string, string>;
  },
  value: unknown,
): unknown {
  const secrets = credentialMaskValues(config);
  const fields = new Set((config.redactFields ?? []).map((field) => field.toLowerCase()));
  let mediaBytes = 0;
  function clean(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
    if (depth > 64) return '[nested value omitted]';
    if (typeof value === 'string') {
      if (fields.size && /^[\s]*[[{]/.test(value)) {
        if (Buffer.byteLength(value) > MAX_ATTRIBUTE_VALUE_BYTES)
          return '[oversized JSON omitted for field redaction]';
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          /* Plain text still receives credential masking. */
        }
        if (parsed !== undefined) return JSON.stringify(clean(parsed, ancestors, depth + 1));
      }
      let text = value;
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      text = text.replace(/\b[sp]k-lf-[\w-]+\b/g, '[redacted]');
      return text.replace(
        /data:([^;,]{1,100});base64,([^\s"'<>)\]}]*)/g,
        (uri, mime: string, data: string) => {
          const bytes = Buffer.byteLength(uri);
          if (
            config.includePayloads === true &&
            config.mediaUploadEnabled === true &&
            mediaBytes + bytes <= 750_000 &&
            isInlineImage(mime, data)
          ) {
            mediaBytes += bytes;
            return uri;
          }
          return `[image ${mime}, binary omitted]`;
        },
      );
    }
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[circular]';
    ancestors.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => clean(item, ancestors, depth + 1))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            clean(key, ancestors),
            fields.has(key.toLowerCase())
              ? '[redacted]'
              : key === 'data' &&
                  typeof item === 'string' &&
                  ('mimeType' in value ||
                    'media_type' in value ||
                    (value as { type?: string }).type === 'base64')
                ? '[image binary omitted]'
                : clean(item, ancestors, depth + 1),
          ]),
        );
    ancestors.delete(value);
    return result;
  }
  return clean(value);
}

export function stripTelemetryPayloads(event: RuntimeTelemetryEvent): RuntimeTelemetryEvent {
  const { contextMetadata: _contextMetadata, ...withoutContext } = event;
  event = withoutContext;
  if (isLlmStreamEvent(event)) {
    const {
      input: _input,
      streamEvents: _streamEvents,
      displayInput: _displayInput,
      displayOutput: _displayOutput,
      ...rest
    } = event;
    return { ...rest, streamEvents: [] };
  }
  if (isLlmGenerationEvent(event)) {
    const {
      input: _input,
      output: _output,
      displayInput: _displayInput,
      displayOutput: _displayOutput,
      ...rest
    } = event;
    return rest as RuntimeTelemetryEvent;
  }
  if (isToolEvent(event)) {
    const { args: _args, details: _details, ...rest } = event;
    return rest as RuntimeTelemetryEvent;
  }
  const { details: _details, ...rest } = event;
  return rest as RuntimeTelemetryEvent;
}
