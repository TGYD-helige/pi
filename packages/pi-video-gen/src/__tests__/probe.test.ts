import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: vi.fn(async () => ({ ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 })),
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: run }),
}));

beforeEach(() => {
  vi.resetModules();
  run.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('probeCommand', () => {
  it('shares overlapping identical probes while cancelling each caller independently', async () => {
    let finish: (value: { stdout: string }) => void = () => {};
    run.mockImplementation(
      () =>
        new Promise<{ stdout: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const { probeCommand } = await import('../probe.js');
    const first = new AbortController();
    const cancelled = probeCommand(process.execPath, ['-version'], first.signal);
    const cancelledResult = expect(cancelled).rejects.toThrow(/cancelled/i);
    const second = probeCommand(process.execPath, ['-version']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.mock.calls.length).toBe(1);
    first.abort();
    await cancelledResult;
    expect(run.mock.calls[0]![2].signal.aborted).toBe(false);
    finish({ stdout: 'ok' });
    expect(await second).toBe('ok');
    expect(await probeCommand(process.execPath, ['-version'])).toBe('ok');
    expect(run.mock.calls.length).toBe(1);
  });
  it('aborts abandoned probes and ignores their late completion when a replacement is active', async () => {
    const finishes: Array<(value: { stdout: string }) => void> = [];
    run.mockImplementation(
      () => new Promise<{ stdout: string }>((resolve) => finishes.push(resolve)),
    );
    const { probeCommand } = await import('../probe.js');
    const first = new AbortController();
    const second = new AbortController();
    const left = probeCommand(process.execPath, ['-version'], first.signal);
    const right = probeCommand(process.execPath, ['-version'], second.signal);
    const cancelled = Promise.all([
      expect(left).rejects.toThrow(/cancelled/i),
      expect(right).rejects.toThrow(/cancelled/i),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.mock.calls.length).toBe(1);
    first.abort();
    second.abort();
    await cancelled;
    expect(run.mock.calls[0]![2].signal.aborted).toBe(true);
    const replacement = probeCommand(process.execPath, ['-version']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.mock.calls.length).toBe(2);
    finishes[0]!({ stdout: 'stale' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const joined = probeCommand(process.execPath, ['-version']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.mock.calls.length).toBe(2);
    finishes[1]!({ stdout: 'fresh' });
    expect(await replacement).toBe('fresh');
    expect(await joined).toBe('fresh');
    expect(await probeCommand(process.execPath, ['-version'])).toBe('fresh');
  });

  it('keeps distinct argument and timeout budgets separate and retries failures', async () => {
    const finishes: Array<(value: { stdout: string }) => void> = [];
    run.mockImplementation(
      () => new Promise<{ stdout: string }>((resolve) => finishes.push(resolve)),
    );
    const { probeCommand } = await import('../probe.js');
    const probes = [
      probeCommand(process.execPath, ['a']),
      probeCommand(process.execPath, ['b']),
      probeCommand(process.execPath, ['a'], undefined, 2000),
    ];
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.mock.calls.length).toBe(3);
    for (const finish of finishes) finish({ stdout: 'ok' });
    await Promise.all(probes);
    run.mockRejectedValueOnce(Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
    expect(await probeCommand(process.execPath, ['missing'])).toBeUndefined();
    run.mockResolvedValueOnce({ stdout: 'installed' });
    expect(await probeCommand(process.execPath, ['missing'])).toBe('installed');
  });

  it('logs only a fixed diagnostic for unexpected failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    run.mockRejectedValue(
      Object.assign(new Error('secret stderr payload'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
      }),
    );
    const { probeCommand } = await import('../probe.js');
    expect(await probeCommand(process.execPath, ['-version'])).toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith('[pi-video-gen] command probe failed');
  });
});
