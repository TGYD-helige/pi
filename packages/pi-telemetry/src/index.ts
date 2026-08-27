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

export class NoopRuntimeEventExporter implements RuntimeEventExporter {
  async publish(_event: RuntimeTelemetryEvent): Promise<void> {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class CompositeRuntimeEventExporter implements RuntimeEventExporter {
  constructor(private readonly exporters: RuntimeEventExporter[]) {}

  async publish(event: RuntimeTelemetryEvent): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.publish(event)));
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.flush?.()));
  }

  async close(): Promise<void> {
    // Preserve the public flush-before-close contract. Built-in close()
    // implementations may flush again, but an already-drained queue is a no-op.
    await this.flush();
    await Promise.allSettled(this.exporters.map((exporter) => exporter.close?.()));
  }
}

export { default } from './extension.js';
