import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';
import type { RuntimeTelemetryOptions } from './index.js';
import { parseBoolean, trim } from './parse.js';

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

export interface PhoenixConfig {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  projectName?: string;
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
  tags?: string[];
  traceName?: string;
  redactFields?: string[];

  langfuse?: LangfuseConfig;
  otel?: OtelConfig;
  phoenix?: PhoenixConfig;
}

const DEFAULTS: TelemetryConfig = {
  serviceName: 'pi-server',
  includePayloads: false,
};

export function resolveConfig(config?: TelemetryConfig): TelemetryConfig {
  return {
    ...DEFAULTS,
    ...config,
    includePayloads: parseBoolean(config?.includePayloads),
    mediaUploadEnabled:
      parseBoolean(config?.includePayloads) && parseBoolean(config?.mediaUploadEnabled),
  };
}

export function loadConfigFromFile(options?: PiSettingsOptions): TelemetryConfig {
  return loadPiSettings<TelemetryConfig>('pi-telemetry', { ...options });
}

export function credentialMaskValues(config: {
  maskingSecrets?: readonly string[];
  langfuse?: Pick<LangfuseConfig, 'publicKey' | 'secretKey'>;
  otel?: OtelConfig;
  phoenix?: Pick<PhoenixConfig, 'apiKey'>;
  headers?: Record<string, string>;
}): string[] {
  const publicKey = trim(config.langfuse?.publicKey);
  const secretKey = trim(config.langfuse?.secretKey);
  const values = [
    config.phoenix?.apiKey,
    trim(config.phoenix?.apiKey),
    ...(config.maskingSecrets ?? []),
    config.langfuse?.publicKey,
    config.langfuse?.secretKey,
    publicKey,
    secretKey,
    ...(publicKey && secretKey
      ? [Buffer.from(`${publicKey}:${secretKey}`).toString('base64')]
      : []),
    ...[...Object.entries(config.otel?.headers ?? {}), ...Object.entries(config.headers ?? {})]
      .filter(([key]) => /authorization|api.?key|token|cookie/i.test(key))
      .flatMap(([, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]),
  ];
  return [...new Set(values)].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

export function runtimeTelemetryOptions(
  config: Pick<
    TelemetryConfig,
    | 'includePayloads'
    | 'mediaUploadEnabled'
    | 'userId'
    | 'environment'
    | 'release'
    | 'tags'
    | 'traceName'
    | 'redactFields'
  > & {
    maskingSecrets?: readonly string[];
    langfuse?: LangfuseConfig;
    otel?: OtelConfig;
    phoenix?: PhoenixConfig;
  },
): RuntimeTelemetryOptions {
  return {
    tags: stringList(config.tags),
    redactFields: stringList(config.redactFields),
    ...(typeof config.traceName === 'string' && config.traceName.trim()
      ? { traceName: config.traceName.trim().slice(0, 90) }
      : {}),
    maskingSecrets: credentialMaskValues(config),
    includePayloads: parseBoolean(config.includePayloads),
    mediaUploadEnabled:
      parseBoolean(config.includePayloads) && parseBoolean(config.mediaUploadEnabled),
    ...(config.userId ? { userId: config.userId } : {}),
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.release ? { release: config.release } : {}),
  };
}

export function configurationWarnings(config: TelemetryConfig): string[] {
  const warnings: string[] = [];
  if (
    parseBoolean(config.langfuse?.enabled) &&
    !(trim(config.langfuse?.publicKey) && trim(config.langfuse?.secretKey))
  )
    warnings.push('Langfuse credentials are missing');
  if (
    parseBoolean(config.langfuse?.enabled) &&
    config.langfuse?.baseUrl !== undefined &&
    !trim(config.langfuse.baseUrl)
  )
    warnings.push('Langfuse base URL is blank');
  if (parseBoolean(config.otel?.enabled) && !config.otel?.endpoint)
    warnings.push('OTLP endpoint is missing');
  if (
    parseBoolean(config.phoenix?.enabled) &&
    config.phoenix?.endpoint !== undefined &&
    !trim(config.phoenix.endpoint)
  )
    warnings.push('Phoenix endpoint is blank');
  return warnings;
}

export function stringList(value: unknown): string[] {
  const result = new Set<string>();
  if (!Array.isArray(value)) return [];
  for (let index = 0; index < Math.min(value.length, 256) && result.size < 32; index++) {
    const item = value[index];
    if (typeof item !== 'string' || item.length > 4096) continue;
    const text = item.trim().slice(0, 128);
    if (text) result.add(text);
  }
  return [...result];
}
