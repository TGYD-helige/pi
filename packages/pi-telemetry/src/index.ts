import type {
  JsonValue,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';

export type RuntimeLlmStreamEvent = Omit<
  RuntimeLlmGenerationEvent,
  'status' | 'model' | 'output' | 'usage' | 'responseId' | 'stopReason' | 'error'
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
  getStatus?(): { enabled: boolean; state: string; error?: string };
  /** Telemetry-only environment overrides for one child launch; merge with the caller environment. */
  setContext?(context: TelemetryRequestContext): void;
  getToolContext?(sessionId: string, toolCallId: string): Record<string, string> | undefined;
}

export type TelemetryEnvironment = Record<string, string | undefined>;

export type TelemetryRedactor = (event: RuntimeTelemetryEvent) => RuntimeTelemetryEvent | undefined;

/** Producer events for model calls outside the main agent provider loop. */
export type TelemetryAuxiliaryEvent = Omit<
  RuntimeLlmGenerationEvent,
  'id' | 'traceId' | 'sessionId' | 'conversationId' | 'source'
> & {
  source: 'compaction' | 'branch_summary' | 'tool';
};

export type TelemetryRequestContext = {
  userId?: string;
  traceName?: string;
  tags?: string[];
  metadata?: Record<string, JsonValue>;
  traceparent?: string;
};

export type RuntimeTelemetryOptions = {
  serviceName?: string | undefined;
  serviceVersion?: string | undefined;
  includePayloads?: boolean;
  mediaUploadEnabled?: boolean;
  userId?: string;
  environment?: string;
  release?: string;
  tags?: string[];
  traceName?: string;
  redactFields?: string[];
  redactEvent?: TelemetryRedactor | undefined;
  maskingSecrets?: readonly string[];
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
