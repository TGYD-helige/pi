import type { RuntimeTelemetryOptions } from '../index.js';

export type LangfuseExporterConfig = {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  flushAt: number;
  flushIntervalMs: number;
} & RuntimeTelemetryOptions;

export type OtelExporterConfig = {
  enabled: boolean;
  endpoint: string;
  headers?: Record<string, string>;
  flushAt: number;
  flushIntervalMs: number;
  // Langfuse credentials: when present, the provider gets a
  // LangfuseSpanProcessor alongside (or instead of) the generic OTLP one.
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl: string;
    flushAt: number;
    flushIntervalMs: number;
  };
} & RuntimeTelemetryOptions;

export const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
export const DEFAULT_FLUSH_AT = 20;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
// Lifecycle shutdown must not wait forever on the SDK.
export const MAX_CLOSE_MS = 30_000;
// SDK-path metadata keys promoted to langfuse.observation.metadata.* so they
// stay filterable on the OTEL write path (everything else sinks into
// Langfuse's metadata.attributes catch-all). Scalars only — object payloads
// like details/usage/error are never useful as filters and would duplicate
// the largest values in the trace onto every span.
export const FILTERABLE_METADATA_KEYS = [
  'eventType',
  'sessionId',
  'conversationId',
  'parentSessionId',
  'childSessionId',
  'taskRunId',
  'spawnBatchId',
  'toolName',
  'toolCallId',
  'status',
  'llmGenerationId',
  'model',
  'thinkingLevel',
  'stopReason',
  'responseId',
  'durationMs',
  'toolPolicyProfile',
] as const;
// Big LLM inputs/outputs otherwise multiply through the duplicated
// observation/input.value keys into requests over Langfuse Cloud's ~5MB
// limit; 1MB per attribute keeps a single span deliverable.
export const MAX_ATTRIBUTE_VALUE_BYTES = 1_000_000;
// status.message carries raw error text; cap it like any other payload.
export const MAX_STATUS_MESSAGE_CHARS = 4_096;
