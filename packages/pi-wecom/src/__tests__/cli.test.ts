import { describe, expect, it, vi } from 'vitest';

const mockExec = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

const { isWeComCliAuthenticated } = await import('../cli.js');

describe('isWeComCliAuthenticated', () => {
  it('uses the CLI 1.2 status command and accepts authorized', async () => {
    const signal = new AbortController().signal;
    mockExec.mockImplementation(
      (
        command: string,
        options: { signal?: AbortSignal },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        expect(options.signal).toBe(signal);
        if (command.endsWith('auth show --status')) callback(null, 'authorized\n', '');
        else callback(new Error('unrecognized subcommand'), '', '');
      },
    );

    await expect(isWeComCliAuthenticated(signal)).resolves.toBe(true);
  });

  it('rejects unauthorized', async () => {
    mockExec.mockImplementation(
      (
        _command: string,
        _options: { signal?: AbortSignal },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, 'unauthorized\n', ''),
    );

    await expect(isWeComCliAuthenticated()).resolves.toBe(false);
  });
});
