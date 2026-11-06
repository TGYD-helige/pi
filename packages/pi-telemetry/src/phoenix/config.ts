import { configurationWarnings, runtimeTelemetryOptions, type TelemetryConfig } from '../config.js';
import { NoopRuntimeEventExporter } from '../exporters.js';
import type { RuntimeEventExporter, TelemetryEnvironment } from '../index.js';
import { OtelRuntimeEventExporter } from '../otel/exporters.js';
import {
  DEFAULT_FLUSH_AT,
  DEFAULT_FLUSH_INTERVAL_MS,
  type OtelExporterConfig,
} from '../otel/types.js';
import { parseBoolean, parsePositiveInteger, trim } from '../parse.js';
import type { PhoenixDestinationConfig, PhoenixExporterConfig } from './types.js';

export const DEFAULT_PHOENIX_ENDPOINT = 'http://localhost:6006';

export function createPhoenixExporter(telemetryConfig: TelemetryConfig): RuntimeEventExporter {
  const config = resolvePhoenixExporterConfig(telemetryConfig);
  if (!config.enabled) {
    return new NoopRuntimeEventExporter(config.configurationWarnings?.join('; ') || undefined);
  }
  const otelConfig: OtelExporterConfig = {
    ...config,
    endpoint: '',
    phoenix: toPhoenixDestinationConfig(config),
  };
  return new OtelRuntimeEventExporter(otelConfig);
}

export function toPhoenixDestinationConfig(
  config: PhoenixExporterConfig,
): PhoenixDestinationConfig {
  return {
    endpoint: config.endpoint,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.projectName ? { projectName: config.projectName } : {}),
    flushAt: config.flushAt,
    flushIntervalMs: config.flushIntervalMs,
  };
}

export function resolvePhoenixExporterConfig(
  telemetryConfig: TelemetryConfig,
  env: TelemetryEnvironment = process.env,
): PhoenixExporterConfig {
  const phoenix = telemetryConfig.phoenix;
  const endpoint = (
    phoenix?.endpoint === undefined ? DEFAULT_PHOENIX_ENDPOINT : (trim(phoenix.endpoint) ?? '')
  ).replace(/\/+$/, '');
  const apiKey = trim(phoenix?.apiKey);
  const projectName = trim(phoenix?.projectName ?? env.PHOENIX_PROJECT_NAME);
  return {
    enabled: Boolean(parseBoolean(phoenix?.enabled) && endpoint),
    configurationWarnings: configurationWarnings({ ...(phoenix ? { phoenix } : {}) }),
    endpoint,
    ...(apiKey ? { apiKey } : {}),
    ...(projectName ? { projectName } : {}),
    flushAt: parsePositiveInteger(phoenix?.flushAt, DEFAULT_FLUSH_AT),
    flushIntervalMs: parsePositiveInteger(phoenix?.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    serviceName: telemetryConfig.serviceName ?? 'pi-server',
    ...(telemetryConfig.serviceVersion ? { serviceVersion: telemetryConfig.serviceVersion } : {}),
    ...runtimeTelemetryOptions(telemetryConfig),
  };
}
