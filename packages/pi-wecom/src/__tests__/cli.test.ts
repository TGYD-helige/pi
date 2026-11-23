import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { isWeComCliAuthenticated } = await import('../cli.js');

function statusResult(stdout: string) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  child.stdout.once('end', () => child.emit('close', 0, null));
  child.stdout.end(stdout);
  child.stderr.end();
  return child;
}

describe('isWeComCliAuthenticated', () => {
  const file = 'wecom-cli.exe';
  it('uses the CLI 1.2 status command and accepts authorized', async () => {
    const signal = new AbortController().signal;
    mockSpawn.mockImplementationOnce(() => statusResult('authorized\n'));

    await expect(isWeComCliAuthenticated(file, signal)).resolves.toBe(true);
    expect(mockSpawn).toHaveBeenLastCalledWith(
      file,
      ['auth', 'show', '--status'],
      expect.any(Object),
    );
  });

  it('rejects unauthorized', async () => {
    mockSpawn.mockImplementationOnce(() => statusResult('unauthorized\n'));

    await expect(isWeComCliAuthenticated(file)).resolves.toBe(false);
  });
});
