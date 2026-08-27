import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';

export interface LangfuseConfig {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  flushAt?: number;
  flushIntervalMs?: number;
}

export interface OtelConfig {
  enabled?: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  flushAt?: number;
  flushIntervalMs?: number;
}

export interface TelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  includePayloads?: boolean;

  langfuse?: LangfuseConfig;
  otel?: OtelConfig;
}

const DEFAULTS: TelemetryConfig = {
  serviceName: 'pi-server',
  includePayloads: false,
};

export function resolveConfig(config?: TelemetryConfig): TelemetryConfig {
  return { ...DEFAULTS, ...config };
}

export function loadConfigFromFile(options?: PiSettingsOptions): TelemetryConfig {
  return loadPiSettings<TelemetryConfig>('pi-telemetry', { ...options });
}
