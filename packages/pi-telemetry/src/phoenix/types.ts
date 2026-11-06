import type { RuntimeTelemetryOptions } from '../index.js';

export type PhoenixDestinationConfig = {
  endpoint: string;
  apiKey?: string;
  projectName?: string;
  flushAt: number;
  flushIntervalMs: number;
};

export type PhoenixExporterConfig = {
  enabled: boolean;
  configurationWarnings?: string[];
} & PhoenixDestinationConfig &
  RuntimeTelemetryOptions;
