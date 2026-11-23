import { ChildProcess, execFile, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createOfficeCli, runOfficeCommand } from '../office-cli.js';

const spawn = vi.hoisted(() =>
  vi.fn<(file: string, args: readonly string[], options: SpawnOptions) => ChildProcess>(),
);
const slowStat = vi.hoisted(() => vi.fn<(file: string) => Promise<Stats> | undefined>());
const realpathError = vi.hoisted(() => vi.fn<(file: string) => Error | undefined>());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const { accessSync, statSync } = await import('node:fs');
  // Keep executable discovery in the promise queue so the subprocess controls when installation finishes.
  return {
    ...original,
    access: async (file: string, mode: number) => accessSync(file, mode),
    realpath: async (file: string) => {
      const error = realpathError(file);
      if (error) throw error;
      return original.realpath(file);
    },
    stat: async (file: string) => slowStat(file) ?? statSync(file),
  };
});

describe('runOfficeCommand', () => {
  it.each([
    { stop: 'abort', error: 'AbortError', lifecycle: 'attached' },
    { stop: 'timeout', error: 'TimeoutError', lifecycle: 'attached' },
    ...(process.platform === 'win32'
      ? []
      : [{ stop: 'abort', error: 'AbortError', lifecycle: 'detached' }]),
  ])('stops an $lifecycle npm lifecycle worker on $stop', async ({ stop, error, lifecycle }) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-office-cli-npm-'));
    const controller = new AbortController();
    const marker = join(directory, 'late-write');
    const server = createServer();
    let socket: Socket | undefined;
    const connected = new Promise<Socket>((resolve) => {
      server.once('connection', (connection: Socket) => {
        socket = connection;
        connection.on('error', () => connection.destroy());
        connection.setTimeout(6500, () => connection.destroy());
        resolve(connection);
      });
    });
    let command: ReturnType<typeof runOfficeCommand> | undefined;

    try {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process');
      spawn.mockImplementation(actual.spawn);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

      const script = lifecycle === 'detached' ? 'node launcher.cjs' : 'node fixture.cjs';
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'office-fixture', scripts: { fixture: script } }),
      );
      if (lifecycle === 'detached') {
        writeFileSync(
          join(directory, 'launcher.cjs'),
          `require('node:child_process').spawn(process.execPath, ['fixture.cjs'], {
  detached: true, stdio: 'inherit',
});`,
        );
      }
      writeFileSync(
        join(directory, 'fixture.cjs'),
        `process.on('SIGTERM', () => {});
const socket = require('node:net').connect(${address.port}, '127.0.0.1');
socket.once('data', () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'));
`,
      );
      const started = performance.now();
      command = runOfficeCommand(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['--prefix', directory, 'run', 'fixture'],
        {
          env: {
            npm_config_cache: join(directory, 'npm-cache'),
            npm_config_globalconfig: join(directory, 'npm-globalrc'),
            npm_config_offline: 'true',
            npm_config_userconfig: join(directory, 'npm-user-rc'),
          },
          signal: controller.signal,
          timeout: 3000,
        },
      );
      const worker = await Promise.race([
        connected,
        command.then(() => {
          throw new Error('npm exited before the lifecycle script connected');
        }),
      ]);
      if (stop === 'abort') controller.abort();
      await expect(command).rejects.toMatchObject({ name: error });
      expect(performance.now() - started).toBeLessThan(5000);

      // Release the write only after the command has rejected.
      if (!worker.closed) {
        const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
        worker.end('write');
        await closed;
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      controller.abort();
      socket?.destroy();
      await command?.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      spawn.mockReset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 8000);

  it('waits for the Windows command to close after stopping its process tree', async () => {
    const controller = new AbortController();
    const releaseTaskkill = deferred();
    const releaseChild = deferred();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const child = Object.assign(completeCommand(releaseChild.promise), { pid: 4321 });
    let command: ReturnType<typeof runOfficeCommand> | undefined;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.stubEnv('SYSTEMROOT', 'D:\\Windows');
      spawn.mockReturnValueOnce(child);
      vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
        void releaseTaskkill.promise.then(() => callback?.(null, '', ''));
        return new ChildProcess();
      });

      command = runOfficeCommand('office-fixture.exe', [], { signal: controller.signal });
      const rejected = vi.fn();
      void command.catch(rejected);
      controller.abort();
      expect(execFile).toHaveBeenCalledWith(
        'D:\\Windows\\System32\\taskkill.exe',
        ['/PID', '4321', '/T', '/F'],
        { timeout: 2000, windowsHide: true },
        expect.any(Function),
      );
      releaseTaskkill.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejected).not.toHaveBeenCalled();
      releaseChild.resolve();
      await expect(command).rejects.toBe(controller.signal.reason);
    } finally {
      releaseTaskkill.resolve();
      releaseChild.resolve();
      await command?.catch(() => undefined);
      Object.defineProperty(process, 'platform', platform);
      vi.unstubAllEnvs();
      vi.mocked(execFile).mockReset();
      spawn.mockReset();
    }
  });

  it.each([
    'exits before cancellation',
    'exits during taskkill',
    'stays running',
  ])('reports unconfirmed Windows process tree cleanup when the launcher %s', async (outcome) => {
    const controller = new AbortController();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new ChildProcess(), {
      pid: 4321,
      stdout,
      stderr,
      kill: vi.fn(() => false),
    });
    const pipesClosed = Promise.all([once(stdout, 'close'), once(stderr, 'close')]).then(() => {
      if (child.exitCode !== null) child.emit('close', child.exitCode, null);
    });
    const exitLauncher = () => {
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
    };
    let command: ReturnType<typeof runOfficeCommand> | undefined;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      spawn.mockReturnValueOnce(child);
      vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
        if (outcome === 'exits during taskkill') exitLauncher();
        callback?.(new Error('fixture taskkill failure'), '', '');
        return new ChildProcess();
      });

      command = runOfficeCommand('office-fixture.exe', [], { signal: controller.signal });
      const rejected = vi.fn();
      void command.catch(rejected);
      if (outcome === 'exits before cancellation') exitLauncher();
      controller.abort();

      await vi.waitFor(
        () =>
          expect(rejected).toHaveBeenCalledWith(
            expect.objectContaining({
              message: 'Office CLI process tree shutdown could not be verified.',
            }),
          ),
        { timeout: 500 },
      );
      expect(stdout.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
      if (outcome === 'stays running') expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      stdout.destroy();
      stderr.destroy();
      await pipesClosed;
      if (outcome === 'stays running') child.emit('close', 1, null);
      await command?.catch(() => undefined);
      Object.defineProperty(process, 'platform', platform);
      vi.mocked(execFile).mockReset();
      spawn.mockReset();
    }
  });

  it('stops a command when its stdout exceeds the output limit', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    spawn.mockImplementation(actual.spawn);
    try {
      const command = runOfficeCommand(
        process.execPath,
        ['-e', 'process.stdout.write(Buffer.alloc(1024 * 1024 + 1)); setTimeout(() => {}, 4000);'],
        { timeout: 3000 },
      );

      await expect(command).rejects.toThrow('Office CLI output exceeded its limit.');
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.results[0]?.value).not.toMatchObject({ exitCode: null, signalCode: null });
    } finally {
      spawn.mockReset();
    }
  });

  it('recognizes a Darwin group with only zombies when its liveness probe reports EPERM', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const controller = new AbortController();
    const releaseChild = deferred();
    const child = Object.assign(completeCommand(releaseChild.promise), { pid: 4321 });
    const realKill = process.kill;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -4321) return realKill(pid, signal);
      if (signal === 0 || signal === 'SIGKILL') {
        throw Object.assign(new Error('fixture process group permission error'), { code: 'EPERM' });
      }
      if (signal === 'SIGTERM') releaseChild.resolve();
      return true;
    });
    let command: ReturnType<typeof runOfficeCommand> | undefined;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      spawn.mockReturnValueOnce(child);
      vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
        callback?.(null, '4322 1 4321 Z\n', '');
        return new ChildProcess();
      });

      command = runOfficeCommand('office-fixture', [], { signal: controller.signal });
      controller.abort();

      await expect(command).rejects.toBe(controller.signal.reason);
      expect(kill).toHaveBeenCalledWith(-4321, 0);
      expect(kill).not.toHaveBeenCalledWith(-4321, 'SIGKILL');
    } finally {
      releaseChild.resolve();
      await command?.catch(() => undefined);
      Object.defineProperty(process, 'platform', platform);
      kill.mockRestore();
      vi.mocked(execFile).mockReset();
      spawn.mockReset();
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function completeCommand(until = Promise.resolve(), code = 0) {
  const child = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  void until.then(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
  });
  return child;
}

describe('createOfficeCli', () => {
  it('cancels one lookup without dropping the shared pending file check', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-office-cli-lookup-'));
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const cli = join(directory, `office-fixture${suffix}`);
    const statStarted = deferred();
    const releaseStat = deferred();
    const controller = new AbortController();
    try {
      writeFileSync(cli, '', { mode: 0o755 });
      vi.stubEnv('PATH', directory);
      vi.stubEnv('PATHEXT', '.EXE');
      slowStat.mockImplementation((file) => {
        if (file !== cli) return;
        statStarted.resolve();
        return releaseStat.promise.then(() => statSync(file));
      });
      spawn.mockImplementation(() => completeCommand());

      const ensure = createOfficeCli(
        'office-fixture',
        '@fixture/office',
        join(directory, 'install'),
      );
      const first = ensure(controller.signal);
      await Promise.race([statStarted.promise, first]);
      let firstError: unknown;
      void first.catch((error: unknown) => {
        firstError = error;
      });
      controller.abort();
      const second = ensure();
      const results = Promise.allSettled([first, second]);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(firstError).toBe(controller.signal.reason);
        expect(slowStat.mock.calls.filter(([file]) => file === cli)).toHaveLength(1);
      } finally {
        releaseStat.resolve();
        await results;
      }

      expect(await results).toEqual([
        { status: 'rejected', reason: controller.signal.reason },
        { status: 'fulfilled', value: cli },
      ]);
      await expect(ensure()).resolves.toBe(cli);
      expect(slowStat.mock.calls.filter(([file]) => file === cli)).toHaveLength(2);
    } finally {
      slowStat.mockReset();
      spawn.mockReset();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { behavior: 'waits for the same installer across concurrent startups', cancel: false },
    { behavior: 'lets one startup cancel during a shared install', cancel: true },
  ])('$behavior', async ({ cancel }) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-office-cli-concurrent-'));
    const pathBin = join(directory, 'path');
    const installDir = join(directory, 'install');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const npm = join(pathBin, `npm${suffix}`);
    const cli = join(installDir, 'node_modules', '.bin', `office-fixture${suffix}`);
    const installStarted = deferred();
    const releaseInstaller = deferred();
    const controller = new AbortController();
    try {
      mkdirSync(pathBin);
      writeFileSync(npm, '', { mode: 0o755 });
      vi.stubEnv('PATH', pathBin);
      vi.stubEnv('PATHEXT', '.EXE');
      spawn.mockImplementation((file) => {
        if (file === npm) {
          installStarted.resolve();
          return completeCommand(releaseInstaller.promise);
        }
        return completeCommand();
      });

      const ensure = createOfficeCli('office-fixture', '@fixture/office', installDir);
      const first = ensure();
      await Promise.race([installStarted.promise, first]);
      let secondRejected = false;
      const second = ensure(controller.signal);
      void second.catch(() => {
        secondRejected = true;
      });
      const results = Promise.allSettled([first, second]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      try {
        if (cancel) {
          controller.abort();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(secondRejected).toBe(cancel);
        mkdirSync(dirname(cli), { recursive: true });
        writeFileSync(cli, '', { mode: 0o755 });
      } finally {
        releaseInstaller.resolve();
        await results;
      }

      expect(await results).toEqual([
        { status: 'fulfilled', value: cli },
        cancel
          ? { status: 'rejected', reason: controller.signal.reason }
          : { status: 'fulfilled', value: cli },
      ]);
      expect(spawn.mock.calls.filter(([file]) => file === npm)).toHaveLength(1);
    } finally {
      spawn.mockReset();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'timeout',
    'exit code 1',
  ])('blocks a failed installer’s local CLI while allowing the PATH copy (%s)', async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-office-cli-install-failure-'));
    const pathBin = join(directory, 'path');
    const aliasBin = join(directory, 'alias');
    const installDir = join(directory, 'install');
    const localBin = join(installDir, 'node_modules', '.bin');
    const windows = failure === 'timeout' || process.platform === 'win32';
    const suffix = windows ? '.exe' : '';
    const npm = join(pathBin, `npm${suffix}`);
    const pinned = join(pathBin, `office-fixture${suffix}`);
    const local = join(localBin, `office-fixture${suffix}`);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const installStarted = deferred();
    const releaseInstaller = deferred();
    const installTimeout = new AbortController();
    const realTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      return delay === 120_000 ? installTimeout.signal : realTimeout(delay);
    });
    let first: Promise<string> | undefined;
    try {
      if (windows) Object.defineProperty(process, 'platform', { value: 'win32' });
      mkdirSync(pathBin);
      writeFileSync(npm, '', { mode: 0o755 });
      vi.stubEnv(
        'PATH',
        (windows ? [localBin, pathBin] : [localBin, aliasBin, pathBin]).join(delimiter),
      );
      vi.stubEnv('PATHEXT', '.EXE');
      spawn.mockImplementation((file) => {
        if (file !== npm) return completeCommand();
        installStarted.resolve();
        return Object.assign(
          completeCommand(releaseInstaller.promise, failure === 'timeout' ? 0 : 1),
          {
            pid: 4321,
          },
        );
      });
      vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
        callback?.(null, '', '');
        releaseInstaller.resolve();
        return new ChildProcess();
      });

      const ensure = createOfficeCli('office-fixture', '@fixture/office', installDir);
      first = ensure();
      await Promise.race([installStarted.promise, first]);
      mkdirSync(localBin, { recursive: true });
      writeFileSync(local, '', { mode: 0o755 });
      if (!windows) {
        mkdirSync(aliasBin);
        symlinkSync(local, join(aliasBin, 'office-fixture'));
      }
      if (failure === 'timeout') {
        installTimeout.abort(new DOMException('Installer deadline expired', 'TimeoutError'));
      } else {
        releaseInstaller.resolve();
      }

      await expect(first).rejects.toThrow('自动安装');
      await expect(ensure()).rejects.toThrow('自动安装');
      writeFileSync(pinned, '', { mode: 0o755 });
      realpathError.mockImplementation((file) =>
        file === localBin
          ? Object.assign(new Error('fixture cannot resolve managed bin'), { code: 'EACCES' })
          : undefined,
      );
      await expect(ensure()).resolves.toBe(pinned);
      expect(spawn.mock.calls.map(([file]) => file)).toEqual([npm, pinned]);
    } finally {
      releaseInstaller.resolve();
      await first?.catch(() => undefined);
      timeout.mockRestore();
      Object.defineProperty(process, 'platform', platform);
      realpathError.mockReset();
      vi.mocked(execFile).mockReset();
      spawn.mockReset();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
