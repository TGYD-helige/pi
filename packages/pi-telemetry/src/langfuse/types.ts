import type { RuntimeTelemetryOptions } from '../index.js';

export type LangfuseExporterConfig = {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  flushAt: number;
  flushIntervalMs: number;
} & RuntimeTelemetryOptions;

export const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
// SDK-path metadata keys promoted to langfuse.observation.metadata.* so they
// stay filterable on the OTEL write path (everything else sinks into
// Langfuse's metadata.attributes catch-all). Scalars only — object payloads
// like details/usage/error are never useful as filters and would duplicate
// the largest values in the trace onto every span.
export const FILTERABLE_METADATA_KEYS = [
  'eventType',
  'promptNumber',
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
  'requestedModel',
  'api',
  'source',
  'costSource',
  'reasoning',
  'cacheWrite1h',
  'responseId',
  'durationMs',
  'toolPolicyProfile',
] as const;

// Compatibility re-export for existing callers of the shared OTel types.
export {
  DEFAULT_FLUSH_AT,
  DEFAULT_FLUSH_INTERVAL_MS,
  MAX_ATTRIBUTE_VALUE_BYTES,
  MAX_CLOSE_MS,
  MAX_STATUS_MESSAGE_CHARS,
  type OtelExporterConfig,
} from '../otel/types.js';
