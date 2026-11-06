import type { RuntimeTelemetryOptions } from '../index.js';
import type { PhoenixDestinationConfig } from '../phoenix/types.js';

export type OtelExporterConfig = {
  enabled: boolean;
  endpoint: string;
  headers?: Record<string, string>;
  configurationWarnings?: string[];
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
  phoenix?: PhoenixDestinationConfig;
} & RuntimeTelemetryOptions;

export const DEFAULT_FLUSH_AT = 20;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
// Lifecycle shutdown must not wait forever on the SDK.
export const MAX_CLOSE_MS = 30_000;
// Big LLM inputs/outputs otherwise multiply through the duplicated
// observation/input.value keys into requests over Langfuse Cloud's ~5MB
// limit; 750KB per attribute also leaves room for raw and normalized payloads.
export const MAX_ATTRIBUTE_VALUE_BYTES = 750_000;
// status.message carries raw error text; cap it like any other payload.
export const MAX_STATUS_MESSAGE_CHARS = 4_096;
