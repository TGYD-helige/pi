import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const { ensureDws, initDws } = await import('../cli.js');
const file = join(tmpdir(), 'dws.exe');

describe('initDws', () => {
  it('rejects when clientId is missing', async () => {
    await expect(initDws(file, { clientSecret: 'secret' })).rejects.toThrow(
      'clientId and clientSecret are required',
    );
  });

  it('rejects when clientSecret is missing', async () => {
    await expect(initDws(file, { clientId: 'dingabc' })).rejects.toThrow(
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

    await initDws(file, { clientId: 'id; touch /tmp/pwned', clientSecret: 'secret$(id)' });

    expect(mockExecFile).toHaveBeenCalledWith(
      file,
      ['auth', 'login', '--yes'],
      expect.objectContaining({
        env: expect.objectContaining({
          DWS_CLIENT_ID: 'id; touch /tmp/pwned',
          DWS_CLIENT_SECRET: 'secret$(id)',
        }),
      }),
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

    const result = initDws(file, { clientId: 'client-id', clientSecret: 'client-secret' });

    await expect(result).rejects.toThrow('dws auth login failed');
    await expect(result).rejects.not.toThrow('client-secret');
  });

  it('uses the npm shim from Windows Path and keeps login credentials out of the shell', async () => {
    const pathDir = mkdtempSync(join(tmpdir(), 'pi-dingtalk-cli-'));
    const executable = join(pathDir, 'dws.cmd');
    const shell = join(pathDir, 'cmd.exe');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      writeFileSync(executable, '');
      vi.stubEnv('PATH', undefined);
      vi.stubEnv('Path', pathDir);
      vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
      vi.stubEnv('ComSpec', shell);
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => callback(null, '', ''),
      );

      const selected = await ensureDws();
      expect(selected).toBe(executable);
      await initDws(selected, { clientId: 'client-id', clientSecret: 'client-secret' });

      expect(mockExecFile).toHaveBeenLastCalledWith(
        shell,
        [
          '/d',
          '/s',
          '/v:off',
          '/c',
          '""%PI_OFFICE_COMMAND_0%" "%PI_OFFICE_COMMAND_1%" "%PI_OFFICE_COMMAND_2%" "%PI_OFFICE_COMMAND_3%""',
        ],
        expect.objectContaining({
          windowsVerbatimArguments: true,
          env: expect.objectContaining({
            NoDefaultCurrentDirectoryInExePath: '1',
            DWS_CLIENT_ID: 'client-id',
            DWS_CLIENT_SECRET: 'client-secret',
            PI_OFFICE_COMMAND_0: executable,
            PI_OFFICE_COMMAND_1: 'auth',
            PI_OFFICE_COMMAND_2: 'login',
            PI_OFFICE_COMMAND_3: '--yes',
          }),
        }),
        expect.any(Function),
      );
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.unstubAllEnvs();
      rmSync(pathDir, { recursive: true, force: true });
    }
  });
});
