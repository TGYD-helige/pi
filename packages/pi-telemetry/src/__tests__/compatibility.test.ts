import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runtime, events } = vi.hoisted(() => ({
  runtime: { version: '0.79.1' },
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  get VERSION() {
    return runtime.version;
  },
  convertToLlm: (messages: unknown[]) => messages,
}));
vi.mock('../config.js', () => ({ loadConfigFromFile: () => ({}), resolveConfig: () => ({}) }));
vi.mock('../otel.js', () => ({
  createTelemetryExporter: () => ({
    publish: async (event: Record<string, unknown>) => {
      events.push(event);
    },
    flush: async () => {},
    close: async () => {},
  }),
}));

import telemetryExtension from '../extension.js';

describe('runtime compatibility', () => {
  beforeEach(() => {
    events.length = 0;
  });

  it.each([
    '0.79.1',
    '0.84.1',
    '0.84.2',
    '1.0.4',
  ])('finishes prompts on the supported boundary for Pi %s', async (version) => {
    runtime.version = version;
    const handlers = new Map<string, (...args: any[]) => unknown>();
    telemetryExtension({
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      registerCommand() {},
    } as any);
    await handlers.get('session_start')!({}, {});
    await handlers.get('input')!({ text: 'hello' }, {});
    await handlers.get('turn_start')!({ timestamp: Date.now() }, {});
    await handlers.get('agent_end')!({ messages: [] }, {});
    const supportsSettlement = version === '0.84.2' || version === '1.0.4';
    expect(events.filter((event) => event.type === 'chat_turn_completed')).toHaveLength(
      supportsSettlement ? 0 : 1,
    );
    if (supportsSettlement) await handlers.get('agent_settled')!({}, {});
    expect(events.filter((event) => event.type === 'chat_turn_completed')).toHaveLength(1);
    expect(process.env.PI_TELEMETRY_OWNER_PID).not.toBe(String(process.pid));
  });
});
