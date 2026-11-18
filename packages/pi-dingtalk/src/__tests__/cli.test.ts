import { describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const { initDws } = await import('../cli.js');

describe('initDws', () => {
  it('rejects when clientId is missing', async () => {
    await expect(initDws({ clientSecret: 'secret' })).rejects.toThrow(
      'clientId and clientSecret are required',
    );
  });

  it('rejects when clientSecret is missing', async () => {
    await expect(initDws({ clientId: 'dingabc' })).rejects.toThrow(
      'clientId and clientSecret are required',
    );
  });

  it('passes credentials through the environment instead of process arguments', async () => {
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, '', ''),
    );

    await initDws({ clientId: 'id; touch /tmp/pwned', clientSecret: 'secret$(id)' });

    expect(mockExecFile).toHaveBeenCalledWith(
      'dws',
      ['auth', 'login', '--yes'],
      {
        env: expect.objectContaining({
          DWS_CLIENT_ID: 'id; touch /tmp/pwned',
          DWS_CLIENT_SECRET: 'secret$(id)',
        }),
      },
      expect.any(Function),
    );
  });

  it('does not expose credentials when login fails', async () => {
    mockExecFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(new Error(`Command failed: dws ${args.join(' ')}`), '', ''),
    );

    const result = initDws({ clientId: 'client-id', clientSecret: 'client-secret' });

    await expect(result).rejects.toThrow('dws auth login failed');
    await expect(result).rejects.not.toThrow('client-secret');
  });
});
