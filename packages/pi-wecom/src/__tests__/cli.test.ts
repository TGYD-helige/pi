import { describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const { isWeComCliAuthenticated } = await import('../cli.js');

describe('isWeComCliAuthenticated', () => {
  const file = 'wecom-cli.exe';
  it('uses the CLI 1.2 status command and accepts authorized', async () => {
    const signal = new AbortController().signal;
    mockExecFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (command === file && args.join(' ') === 'auth show --status')
          callback(null, 'authorized\n', '');
        else callback(new Error('unrecognized subcommand'), '', '');
      },
    );

    await expect(isWeComCliAuthenticated(file, signal)).resolves.toBe(true);
  });

  it('rejects unauthorized', async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { signal?: AbortSignal },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, 'unauthorized\n', ''),
    );

    await expect(isWeComCliAuthenticated(file)).resolves.toBe(false);
  });
});
