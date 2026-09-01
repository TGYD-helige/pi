import type { RuntimeEventExporter, RuntimeTelemetryEvent } from './index.js';

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
