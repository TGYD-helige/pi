import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { normalizeOtelTracesEndpoint } from '../otel/utils.js';
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
    compression: 'gzip' as NonNullable<
      NonNullable<ConstructorParameters<typeof OTLPTraceExporter>[0]>['compression']
    >,
  });
  // OTLP groups spans by resource identity; reuse the projection across batches.
  const resources = new WeakMap<Resource, Resource>();
  const project = config.projectName
    ? resourceFromAttributes({ 'openinference.project.name': config.projectName })
    : undefined;
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (spans, callback) =>
    originalExport(
      spans.map((span) => {
        let resource = resources.get(span.resource);
        if (!resource) {
          resource = project ? span.resource.merge(project) : span.resource;
          resources.set(span.resource, resource);
        }
        return projectPhoenixSpan(span, config.includePayloads === true, resource);
      }),
      callback,
    );
  return exporter;
}
