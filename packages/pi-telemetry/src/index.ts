import type {
  JsonValue,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';

export type RuntimeLlmStreamEvent = Omit<
  RuntimeLlmGenerationEvent,
  'status' | 'model' | 'input' | 'output' | 'usage' | 'responseId' | 'stopReason' | 'error'
> & {
  streamEvents: JsonValue[];
  error?: string;
};

export type RuntimeTelemetryEvent =
  | RuntimeLifecycleEvent
  | RuntimeToolEvent
  | RuntimeLlmGenerationEvent
  | RuntimeLlmStreamEvent;

export interface RuntimeEventExporter {
  publish(event: RuntimeTelemetryEvent): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export type TelemetryEnvironment = Record<string, string | undefined>;

export type TelemetryRedactor = (event: RuntimeTelemetryEvent) => RuntimeTelemetryEvent | undefined;

export type RuntimeTelemetryOptions = {
  serviceName?: string | undefined;
  serviceVersion?: string | undefined;
  includePayloads?: boolean;
  redactEvent?: TelemetryRedactor | undefined;
};

// The concrete exporters live in a leaf module so that sibling modules (extension.ts,
// otel.ts, langfuse/config.ts) can import them as runtime values WITHOUT importing back into
// this entry module. index.ts re-exports the extension factory (`export { default }` below),
// so a value import from here would make index.ts a circular-import target — and a
// static/bundling loader (Pi's extension loader, jiti) then evaluates the entry before the
// cycle resolves and reads the re-exported default as `undefined`. Re-exporting keeps the
// public `@amaster.ai/pi-telemetry` entry point unchanged.
export { CompositeRuntimeEventExporter, NoopRuntimeEventExporter } from './exporters.js';

export { default } from './extension.js';
