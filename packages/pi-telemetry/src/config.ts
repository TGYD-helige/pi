import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';
import type { RuntimeTelemetryOptions } from './index.js';

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
  mediaUploadEnabled?: boolean;
  userId?: string;
  environment?: string;
  release?: string;

  langfuse?: LangfuseConfig;
  otel?: OtelConfig;
}

const DEFAULTS: TelemetryConfig = {
  serviceName: 'pi-server',
  includePayloads: false,
};

export function resolveConfig(config?: TelemetryConfig): TelemetryConfig {
  return {
    ...DEFAULTS,
    ...config,
    mediaUploadEnabled: config?.includePayloads === true && config.mediaUploadEnabled === true,
  };
}

export function loadConfigFromFile(options?: PiSettingsOptions): TelemetryConfig {
  return loadPiSettings<TelemetryConfig>('pi-telemetry', { ...options });
}

export function credentialMaskValues(config: {
  maskingSecrets?: readonly string[];
  langfuse?: Pick<LangfuseConfig, 'publicKey' | 'secretKey'>;
  otel?: OtelConfig;
  headers?: Record<string, string>;
}): string[] {
  const values = [
    ...(config.maskingSecrets ?? []),
    config.langfuse?.publicKey,
    config.langfuse?.secretKey,
    ...(config.langfuse?.publicKey && config.langfuse.secretKey
      ? [
          Buffer.from(`${config.langfuse.publicKey}:${config.langfuse.secretKey}`).toString(
            'base64',
          ),
        ]
      : []),
    ...[...Object.entries(config.otel?.headers ?? {}), ...Object.entries(config.headers ?? {})]
      .filter(([key]) => /authorization|api.?key|token|cookie/i.test(key))
      .flatMap(([, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]),
  ];
  return [...new Set(values)].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

export function runtimeTelemetryOptions(
  config: Pick<
    TelemetryConfig,
    'includePayloads' | 'mediaUploadEnabled' | 'userId' | 'environment' | 'release'
  > & { maskingSecrets?: readonly string[]; langfuse?: LangfuseConfig; otel?: OtelConfig },
): RuntimeTelemetryOptions {
  return {
    maskingSecrets: credentialMaskValues(config),
    includePayloads: config.includePayloads === true,
    mediaUploadEnabled: config.includePayloads === true && config.mediaUploadEnabled === true,
    ...(config.userId ? { userId: config.userId } : {}),
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.release ? { release: config.release } : {}),
  };
}

export function configurationWarnings(config: TelemetryConfig): string[] {
  const warnings: string[] = [];
  if (config.langfuse?.enabled && !(config.langfuse.publicKey && config.langfuse.secretKey))
    warnings.push('Langfuse credentials are missing');
  if (config.otel?.enabled && !config.otel.endpoint) warnings.push('OTLP endpoint is missing');
  return warnings;
}
