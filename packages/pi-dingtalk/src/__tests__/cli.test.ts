import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { ensureDws, initDws } = await import('../cli.js');
const file = join(tmpdir(), 'dws.exe');

function commandResult(code = 0, stderr = '') {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  child.stderr.once('end', () => child.emit('close', code, null));
  child.stdout.end();
  child.stderr.end(stderr);
  return child;
}

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
    mockSpawn.mockImplementationOnce(() => commandResult());

    await initDws(file, { clientId: 'id; touch /tmp/pwned', clientSecret: 'secret$(id)' });

    expect(mockSpawn).toHaveBeenLastCalledWith(
      file,
      ['auth', 'login', '--yes'],
      expect.objectContaining({
        env: expect.objectContaining({
          DWS_CLIENT_ID: 'id; touch /tmp/pwned',
          DWS_CLIENT_SECRET: 'secret$(id)',
        }),
      }),
    );
  });

  it('does not expose credentials when login fails', async () => {
    mockSpawn.mockImplementationOnce(() => commandResult(1, 'Failed to log in with client-secret'));

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
      mockSpawn.mockImplementation(() => commandResult());

      const selected = await ensureDws();
      expect(selected).toBe(executable);
      await initDws(selected, { clientId: 'client-id', clientSecret: 'client-secret' });

      expect(mockSpawn).toHaveBeenLastCalledWith(
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
      );
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.unstubAllEnvs();
      rmSync(pathDir, { recursive: true, force: true });
    }
  });
});
