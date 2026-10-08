import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => {
  throw new Error('Optional Pi runtime is unavailable');
});

import telemetryExtension, { NoopRuntimeEventExporter } from '../index.js';
import { createOtelExporter } from '../otel.js';

describe('optional runtime peer', () => {
  it('allows programmatic exporters to load without Pi installed', () => {
    expect(telemetryExtension).toBeTypeOf('function');
    expect(createOtelExporter({})).toBeInstanceOf(NoopRuntimeEventExporter);
  });
});
