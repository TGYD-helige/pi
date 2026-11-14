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
// Per-attribute defaults; duplicated payloads and batching also contribute to request size.
export const MAX_ATTRIBUTE_VALUE_BYTES = 1_000_000;
export const DEFAULT_PREVIEW_BYTES = 256_000;
// status.message carries raw error text; cap it like any other payload.
export const MAX_STATUS_MESSAGE_CHARS = 4_096;
