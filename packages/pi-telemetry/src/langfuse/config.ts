import type { TelemetryConfig } from '../config.js';
import { NoopRuntimeEventExporter } from '../exporters.js';
import type { RuntimeEventExporter, TelemetryEnvironment } from '../index.js';
import { parseBoolean, parsePositiveInteger, trim } from '../parse.js';
import { OtelRuntimeEventExporter } from './exporters.js';
import {
  DEFAULT_FLUSH_AT,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_LANGFUSE_BASE_URL,
  type LangfuseExporterConfig,
  type OtelExporterConfig,
} from './types.js';

export function createRuntimeEventExporterFromEnv(env: TelemetryEnvironment): RuntimeEventExporter {
  const config = resolveLangfuseConfig(env);
  return config.enabled
    ? new OtelRuntimeEventExporter(langfuseOtelConfig(config))
    : new NoopRuntimeEventExporter();
}

export function createLangfuseExporter(telemetryConfig: TelemetryConfig): RuntimeEventExporter {
  const config = resolveLangfuseExporterConfig(telemetryConfig);
  return config.enabled
    ? new OtelRuntimeEventExporter(langfuseOtelConfig(config))
    : new NoopRuntimeEventExporter();
}

// Langfuse's write path is OTLP/HTTP via the official SDK: the exporter's
// provider carries a LangfuseSpanProcessor (@langfuse/otel), which wraps a
// BatchSpanProcessor + OTLPTraceExporter with Langfuse auth against
// `<baseUrl>/api/public/otel/v1/traces`. The legacy batch ingestion API the
// old Langfuse SDK v3 exporter talked to is removed from Langfuse Cloud on
// 2026-11-16 (and is already rejected by self-hosted v4 in events_only
// mode). x-langfuse-ingestion-version: 4 opts into real-time v4 ingestion
// (without it, data can lag the v2 read APIs by up to 15 minutes).
function langfuseOtelConfig(config: LangfuseExporterConfig): OtelExporterConfig {
  return {
    enabled: true,
    endpoint: '',
    langfuse: {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      flushAt: config.flushAt,
      flushIntervalMs: config.flushIntervalMs,
    },
    flushAt: config.flushAt,
    flushIntervalMs: config.flushIntervalMs,
    ...(config.serviceName ? { serviceName: config.serviceName } : {}),
    ...(config.serviceVersion ? { serviceVersion: config.serviceVersion } : {}),
    ...(config.includePayloads !== undefined ? { includePayloads: config.includePayloads } : {}),
  };
}

export function resolveLangfuseExporterConfig(
  telemetryConfig: TelemetryConfig,
): LangfuseExporterConfig {
  const lf = telemetryConfig.langfuse;
  const publicKey = lf?.publicKey ?? '';
  const secretKey = lf?.secretKey ?? '';
  const credentialsPresent = Boolean(publicKey && secretKey);
  return {
    enabled: Boolean(lf?.enabled && credentialsPresent),
    publicKey,
    secretKey,
    baseUrl: lf?.baseUrl || DEFAULT_LANGFUSE_BASE_URL,
    flushAt: parsePositiveInteger(lf?.flushAt, DEFAULT_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(lf?.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    serviceName: telemetryConfig.serviceName ?? 'pi-server',
    ...(telemetryConfig.serviceVersion ? { serviceVersion: telemetryConfig.serviceVersion } : {}),
    includePayloads: telemetryConfig.includePayloads ?? false,
  };
}

export function resolveLangfuseConfig(env: TelemetryEnvironment): LangfuseExporterConfig {
  const enabled = parseBoolean(env.LANGFUSE_ENABLED);
  const publicKey = trim(env.LANGFUSE_PUBLIC_KEY);
  const secretKey = trim(env.LANGFUSE_SECRET_KEY);
  const baseUrl = trim(env.LANGFUSE_BASE_URL) ?? DEFAULT_LANGFUSE_BASE_URL;
  const credentialsPresent = Boolean(publicKey && secretKey);
  const serviceVersion = trim(env.TELEMETRY_SERVICE_VERSION);
  return {
    enabled: Boolean(enabled && credentialsPresent),
    publicKey: publicKey ?? '',
    secretKey: secretKey ?? '',
    baseUrl,
    flushAt: parsePositiveInteger(env.LANGFUSE_FLUSH_AT, DEFAULT_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(
      env.LANGFUSE_FLUSH_INTERVAL_MS,
      DEFAULT_FLUSH_INTERVAL_MS,
    ),
    serviceName: trim(env.TELEMETRY_SERVICE_NAME ?? env.OTEL_SERVICE_NAME) ?? 'pi-server',
    ...(serviceVersion ? { serviceVersion } : {}),
    includePayloads: parseBoolean(env.TELEMETRY_INCLUDE_PAYLOADS ?? env.LANGFUSE_INCLUDE_PAYLOADS),
  };
}
