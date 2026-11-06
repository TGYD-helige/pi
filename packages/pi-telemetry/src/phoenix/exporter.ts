import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { normalizeOtelTracesEndpoint } from '../langfuse/utils.js';
import { projectPhoenixSpan } from './mapping.js';
import type { PhoenixDestinationConfig } from './types.js';

export function createPhoenixSpanExporter(
  config: PhoenixDestinationConfig & { includePayloads: boolean | undefined },
  timeoutMillis: number,
): SpanExporter {
  const exporter = new OTLPTraceExporter({
    url: normalizeOtelTracesEndpoint(config.endpoint),
    ...(config.apiKey ? { headers: { Authorization: `Bearer ${config.apiKey}` } } : {}),
    timeoutMillis,
  });
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (spans, callback) =>
    originalExport(
      spans.map((span) =>
        projectPhoenixSpan(span, config.includePayloads === true, config.projectName),
      ),
      callback,
    );
  return exporter;
}
