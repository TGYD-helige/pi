import type { RuntimeLlmGenerationEvent, RuntimeToolEvent } from '@amaster.ai/pi-shared';
import type { RuntimeTelemetryEvent } from '../index.js';
import { type LangfuseExporterConfig, MAX_ATTRIBUTE_VALUE_BYTES } from './types.js';

export function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
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
  return 'llmGenerationId' in event;
}

export function applyTelemetryRedaction(
  config: Pick<LangfuseExporterConfig, 'includePayloads' | 'redactEvent'>,
  event: RuntimeTelemetryEvent,
): RuntimeTelemetryEvent | undefined {
  const redacted = config.redactEvent ? config.redactEvent(event) : event;
  if (!redacted) {
    return undefined;
  }
  const sanitized = redacted.error
    ? ({ ...redacted, error: 'Telemetry operation failed' } as RuntimeTelemetryEvent)
    : redacted;
  return config.includePayloads === false ? stripTelemetryPayloads(sanitized) : sanitized;
}

export function stripTelemetryPayloads(event: RuntimeTelemetryEvent): RuntimeTelemetryEvent {
  if (isLlmGenerationEvent(event)) {
    const { input: _input, output: _output, error: _error, ...rest } = event;
    return rest as RuntimeTelemetryEvent;
  }
  if (isToolEvent(event)) {
    const { args: _args, details: _details, error: _error, ...rest } = event;
    return rest as RuntimeTelemetryEvent;
  }
  const { details: _details, error: _error, ...rest } = event;
  return rest as RuntimeTelemetryEvent;
}
