import type { TelemetryConfig } from './config.js';
import {
  NoopRuntimeEventExporter,
  type RuntimeEventExporter,
  type TelemetryEnvironment,
} from './index.js';
import {
  type OtelExporterConfig,
  OtelRuntimeEventExporter,
  resolveLangfuseExporterConfig,
} from './langfuse.js';
import { parseBoolean, parsePositiveInteger, trim } from './parse.js';

const DEFAULT_OTEL_FLUSH_AT = 20;
const DEFAULT_OTEL_FLUSH_INTERVAL_MS = 5000;

export { type OtelExporterConfig, OtelRuntimeEventExporter };

// Combined factory for the extension: when BOTH langfuse and a generic otel
// endpoint are configured, both span processors must ride on ONE provider —
// two providers would mint different span ids for the same logical span and
// cross-wire the PI_TELEMETRY_TRACEPARENT written for child processes.
export function createTelemetryExporter(telemetryConfig: TelemetryConfig): RuntimeEventExporter {
  const langfuse = resolveLangfuseExporterConfig(telemetryConfig);
  const otel = resolveOtelExporterConfig(telemetryConfig);
  if (!langfuse.enabled && !otel.enabled) {
    return new NoopRuntimeEventExporter();
  }
  const primary = langfuse.enabled ? langfuse : otel;
  return new OtelRuntimeEventExporter({
    enabled: true,
    endpoint: otel.enabled ? otel.endpoint : '',
    ...(otel.headers ? { headers: otel.headers } : {}),
    ...(langfuse.enabled
      ? {
          langfuse: {
            publicKey: langfuse.publicKey,
            secretKey: langfuse.secretKey,
            baseUrl: langfuse.baseUrl,
            flushAt: langfuse.flushAt,
            flushIntervalMs: langfuse.flushIntervalMs,
          },
        }
      : {}),
    flushAt: otel.flushAt,
    flushIntervalMs: otel.flushIntervalMs,
    ...(primary.serviceName !== undefined ? { serviceName: primary.serviceName } : {}),
    ...(primary.serviceVersion !== undefined ? { serviceVersion: primary.serviceVersion } : {}),
    ...(primary.includePayloads ? { includePayloads: true } : {}),
  });
}

export function createOtelExporter(telemetryConfig: TelemetryConfig): RuntimeEventExporter {
  const config = resolveOtelExporterConfig(telemetryConfig);
  return config.enabled ? new OtelRuntimeEventExporter(config) : new NoopRuntimeEventExporter();
}

export function resolveOtelExporterConfig(telemetryConfig: TelemetryConfig): OtelExporterConfig {
  const otel = telemetryConfig.otel;
  const endpoint = otel?.endpoint ?? '';
  return {
    enabled: Boolean(otel?.enabled && endpoint),
    endpoint,
    ...(otel?.headers ? { headers: otel.headers } : {}),
    flushAt: parsePositiveInteger(otel?.flushAt, DEFAULT_OTEL_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(otel?.flushIntervalMs, DEFAULT_OTEL_FLUSH_INTERVAL_MS),
    serviceName: telemetryConfig.serviceName ?? 'pi',
    ...(telemetryConfig.serviceVersion ? { serviceVersion: telemetryConfig.serviceVersion } : {}),
    includePayloads: telemetryConfig.includePayloads ?? false,
  };
}

export function createOtelRuntimeEventExporterFromEnv(
  env: TelemetryEnvironment,
): RuntimeEventExporter {
  const config = resolveOtelConfig(env);
  return config.enabled ? new OtelRuntimeEventExporter(config) : new NoopRuntimeEventExporter();
}

export function resolveOtelConfig(env: TelemetryEnvironment): OtelExporterConfig {
  const sdkDisabled = parseBoolean(env.OTEL_SDK_DISABLED);
  const endpoint = trim(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const headers = parseHeaderList(
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  const resourceAttributes = parseHeaderList(env.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName = trim(env.OTEL_SERVICE_NAME ?? resourceAttributes?.['service.name']) ?? 'pi';
  const serviceVersion = trim(
    env.TELEMETRY_SERVICE_VERSION ?? resourceAttributes?.['service.version'],
  );
  return {
    enabled: Boolean(!sdkDisabled && endpoint),
    endpoint: endpoint ?? '',
    ...(headers ? { headers } : {}),
    flushAt: parsePositiveInteger(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, DEFAULT_OTEL_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(
      env.OTEL_BSP_SCHEDULE_DELAY,
      DEFAULT_OTEL_FLUSH_INTERVAL_MS,
    ),
    serviceName,
    ...(serviceVersion ? { serviceVersion } : {}),
    includePayloads: parseBoolean(env.TELEMETRY_INCLUDE_PAYLOADS),
  };
}

function parseHeaderList(value: string | undefined): Record<string, string> | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const item of trimmed.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = decodeURIComponent(item.slice(0, separator).trim());
    const headerValue = decodeURIComponent(item.slice(separator + 1).trim());
    if (key) {
      headers[key] = headerValue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
