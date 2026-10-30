import { describe, expect, it, vi } from 'vitest';

const { runtimeLoads } = vi.hoisted(() => ({ runtimeLoads: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent', () => {
  runtimeLoads();
  return { VERSION: '1.4.0' };
});
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfigFromFile: () => ({}),
}));
vi.mock('../otel.js', () => ({
  createTelemetryExporter: () => ({
    getStatus: () => ({ enabled: false, state: 'disabled' }),
    publish: async () => {},
  }),
}));

import telemetryExtension from '../extension.js';

describe('telemetry disabled startup', () => {
  it('leaves the runtime unloaded and the session history unread', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    telemetryExtension({
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      registerCommand() {},
    } as any);
    const getEntries = vi.fn(() => []);
    await handlers.get('session_start')!(
      {},
      { sessionManager: { getSessionId: () => 'resumed', getEntries } },
    );
    expect(runtimeLoads.mock.calls.length).toBe(0);
    expect(getEntries.mock.calls.length).toBe(0);
  });
});
