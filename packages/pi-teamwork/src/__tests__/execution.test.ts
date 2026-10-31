import { afterEach, describe, expect, it, vi } from 'vitest';
import piTeamworkExtension from '../index.js';

vi.mock('@amaster.ai/pi-shared/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@amaster.ai/pi-shared/settings')>()),
  loadPiSettings: () => ({ provider: 'multica', multica: { token: 'test-only' } }),
}));
type Tool = {
  name: string;
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ isError?: boolean }>;
};
function setup(exec: ReturnType<typeof vi.fn>) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const tools = new Map<string, Tool>();
  piTeamworkExtension({
    on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    exec,
  } as never);
  const start = () =>
    handlers.get('session_start')!(
      {},
      { cwd: '/repo', ui: { setStatus: vi.fn(), notify: vi.fn() } },
    );
  return { tools, handlers, start };
}
describe('piTeamworkExtension execution', () => {
  afterEach(() => vi.restoreAllMocks());
  it('stops the issue write sequence on caller cancellation without cancelling other calls', async () => {
    const controller = new AbortController();
    const exec = vi.fn(
      async (_command: string, args: string[], options: { signal: AbortSignal }) => {
        if (args[0] === 'issue' && args[1] === 'status') {
          expect(options.signal.aborted).toBe(false);
          controller.abort();
        }
        return { stdout: '{"id":"other","title":"Other","status":"todo"}', stderr: '', code: 0 };
      },
    );
    const { tools, handlers, start } = setup(exec);
    await start();
    await new Promise((resolve) => setImmediate(resolve));
    const result = await tools
      .get('issue_update')!
      .execute('call', { id: 'one', status: 'done', title: 'New' }, controller.signal);
    expect(result.isError).toBe(true);
    expect(
      exec.mock.calls.filter(([, args]) => args[0] === 'issue').map(([, args]) => args[1]),
    ).toEqual(['status']);
    expect((await tools.get('issue_get')!.execute('other-call', { id: 'other' })).isError).not.toBe(
      true,
    );
    await handlers.get('session_shutdown')!({}, {});
  });

  it('gives all commands in one update the remaining absolute budget', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budgets: number[] = [];
    const exec = vi.fn(async (_command: string, args: string[], options: { timeout: number }) => {
      if (args[0] === 'issue') {
        budgets.push(options.timeout);
        now += 1000;
      }
      return { stdout: '{"id":"one","title":"New","status":"done"}', stderr: '', code: 0 };
    });
    const { tools, handlers, start } = setup(exec);
    await start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (
        await tools
          .get('issue_update')!
          .execute('call', { id: 'one', status: 'done', title: 'New' })
      ).isError,
    ).not.toBe(true);
    expect(budgets).toEqual([30_000, 29_000, 28_000]);
    await handlers.get('session_shutdown')!({}, {});
  });

  it('cancels a tool waiting for initialization without starting an issue command', async () => {
    const exec = vi.fn(() => new Promise(() => {}));
    const { tools, handlers, start } = setup(exec);
    await start();
    const controller = new AbortController();
    const pending = tools
      .get('issue_update')!
      .execute('call', { id: 'one', title: 'New' }, controller.signal);
    controller.abort();
    expect((await pending).isError).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    await handlers.get('session_shutdown')!({}, {});
  });
});
