import { type ExecFileOptions, execFile } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';

function officeDeadline(timeout: number, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function waitForResult<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let listener: ReturnType<typeof addAbortListener> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason));
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    listener?.[Symbol.dispose]();
  }
}

function metadataOperation<T>(read: (path: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (path: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    let operation = pending.get(path);
    if (!operation) {
      if (pending.size >= 32) throw new Error('Office CLI filesystem lookup capacity reached.');
      // These filesystem calls cannot be cancelled. Keep sharing the work until it settles.
      operation = read(path).finally(() => pending.delete(path));
      pending.set(path, operation);
    }
    return waitForResult(operation, signal);
  };
}

const fileInfo = metadataOperation((path) => stat(path));
const executableAccess = metadataOperation((path) => access(path, constants.X_OK));
const executableTarget = metadataOperation((path) => realpath(path));
const makeInstallDirectory = metadataOperation((path) => mkdir(path, { recursive: true }));

function envValue(name: string) {
  const exact = process.env[name];
  if (exact !== undefined || process.platform !== 'win32') return exact;
  const key = Object.keys(process.env).find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : process.env[key];
}

function pathDirectories(): string[] {
  const path = envValue('PATH');
  if (path === undefined) return process.platform === 'win32' ? [] : ['/usr/bin', '/bin'];
  const directories = path.split(delimiter);
  if (process.platform !== 'win32') return directories;
  return directories.map((directory) => directory.replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

async function findExecutable(name: string, directories: string[], signal: AbortSignal) {
  const windows = process.platform === 'win32';
  const extensions = windows
    ? (envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .toLowerCase()
        .split(';')
        .filter((suffix) => ['.com', '.exe', '.bat', '.cmd'].includes(suffix))
    : [''];
  for (const directory of directories) {
    for (const suffix of extensions) {
      signal.throwIfAborted();
      const path = resolve(directory, `${name}${suffix}`);
      try {
        if (!(await fileInfo(path, signal)).isFile()) continue;
        if (!windows) await executableAccess(path, signal);
        signal.throwIfAborted();
        return path;
      } catch (err) {
        if (
          !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(
            (err as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          throw err;
        }
      }
    }
  }
}

type OfficeCommandOptions = Pick<ExecFileOptions, 'env' | 'signal' | 'timeout'>;

export function runOfficeCommand(file: string, args: string[], options: OfficeCommandOptions = {}) {
  const { env: extraEnv, signal, timeout = 30_000 } = options;
  signal?.throwIfAborted();
  const deadline = officeDeadline(timeout, signal);
  const env = { ...process.env, ...extraEnv };
  const windows = process.platform === 'win32';
  if (windows) env.NoDefaultCurrentDirectoryInExePath = '1';
  const execOptions: ExecFileOptions = {
    env,
    killSignal: 'SIGKILL',
  };

  if (windows && /\.(cmd|bat)$/i.test(file)) {
    const shell =
      envValue('COMSPEC') ??
      win32.join(envValue('SYSTEMROOT') ?? 'C:\\Windows', 'System32', 'cmd.exe');
    if (!isAbsolute(shell) || [file, ...args].some((value) => /["\r\n]/.test(value))) {
      return Promise.reject(new Error('Invalid Windows command path or argument.'));
    }
    // The shell only parses literal variable names. Disable delayed expansion for paths with '!'.
    const command = [file, ...args]
      .map((value, index) => {
        const key = `PI_OFFICE_COMMAND_${index}`;
        env[key] = value;
        return `"%${key}%"`;
      })
      .join(' ');
    file = shell;
    args = ['/d', '/s', '/v:off', '/c', `"${command}"`];
    execOptions.windowsVerbatimArguments = true;
  }

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const child = execFile(
      file,
      args,
      { ...execOptions, encoding: 'utf8' },
      (error, stdout, stderr) => {
        closed = true;
        listener?.[Symbol.dispose]();
        clearTimeout(escalation);
        if (deadline.aborted) reject(deadline.reason);
        else if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    if (!closed) {
      function forceTermination() {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      listener = addAbortListener(deadline, () => {
        if (windows) {
          forceTermination();
          return;
        }
        // Let npm launchers forward SIGTERM to their CLI before killing an unresponsive child.
        escalation = setTimeout(forceTermination, 500);
        child.kill('SIGTERM');
      });
    }
  });
}

export function createOfficeCli(name: string, packageName: string, installDir: string) {
  const localBin = join(installDir, 'node_modules', '.bin');
  const hint = `自装目录为 ${installDir}。可运行 npm install -g ${packageName} 并将 ${name} 加入 PATH。`;
  let installation: Promise<void> | undefined;
  let installing = false;

  async function install() {
    const deadline = AbortSignal.timeout(120_000);
    try {
      const npm = await findExecutable('npm', pathDirectories(), deadline);
      if (!npm) throw new Error('npm not found.');
      await makeInstallDirectory(installDir, deadline);
      await runOfficeCommand(npm, ['install', '--prefix', installDir, `${packageName}@latest`], {
        timeout: 120_000,
        signal: deadline,
      });
    } catch {
      throw new Error(`${name} 自动安装失败。${hint}`);
    }
  }

  return async (signal?: AbortSignal): Promise<string> => {
    async function locate(directories: string[], deadline: AbortSignal) {
      try {
        return await findExecutable(name, directories, deadline);
      } catch {
        signal?.throwIfAborted();
        throw new Error(`无法检查 ${name} 的可执行文件。${hint}`);
      }
    }

    async function works(file: string, deadline: AbortSignal) {
      try {
        await runOfficeCommand(file, ['--version'], { signal: deadline, timeout: 15_000 });
        return true;
      } catch {
        signal?.throwIfAborted();
        return false;
      }
    }

    const probe = officeDeadline(15_000, signal);
    const preinstalled = await locate(pathDirectories(), probe);
    if (preinstalled) {
      if (await works(preinstalled, probe)) return preinstalled;
      throw new Error(`PATH 上的 ${name} 无法运行。请检查 ${preinstalled}。${hint}`);
    }

    if (!installing) {
      const local = await locate([localBin], probe);
      if (local && (await works(local, probe)) && !installing) return local;
    }
    signal?.throwIfAborted();
    if (probe.aborted) throw new Error(`检查 ${name} 超时。${hint}`);
    if (!installation) {
      installing = true;
      installation = install().finally(() => {
        installing = false;
      });
    }
    await waitForResult(installation, signal);

    const recheck = officeDeadline(15_000, signal);
    const installed = await locate([localBin], recheck);
    if (installed && (await works(installed, recheck))) return installed;
    throw new Error(`尝试安装后 ${name} 仍无法运行。${hint}`);
  };
}

export async function getOfficeCliSkillsDir(
  file: string,
  packageName: string,
  subdirectory: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = officeDeadline(15_000, signal);
  const binDir = dirname(file);
  async function skillDirectory(path: string) {
    const info = await fileInfo(path, deadline).catch(() => undefined);
    signal?.throwIfAborted();
    return info?.isDirectory() ? path : undefined;
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const modules = basename(binDir) === '.bin' ? dirname(binDir) : join(binDir, 'node_modules');
    return skillDirectory(join(modules, packageName, subdirectory));
  }

  const target = await executableTarget(file, deadline).catch(() => file);
  signal?.throwIfAborted();
  const packageSuffix = `${sep}${join('node_modules', packageName)}`;
  for (let dir = dirname(target); dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir.endsWith(packageSuffix)) {
      return skillDirectory(join(dir, subdirectory));
    }
  }
}
