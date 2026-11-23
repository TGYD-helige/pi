import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

function unavailablePath(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code);
}

async function findExecutable(
  name: string,
  directories: string[],
  signal: AbortSignal,
  skip?: (file: string) => Promise<boolean>,
) {
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
      const file = `${name}${suffix}`;
      // Preserve POSIX directory traversal so the filesystem follows symlinks before resolving `..`.
      const bin =
        windows || isAbsolute(directory)
          ? directory
          : `${process.cwd().replace(/\/$/, '')}/${directory}`;
      const path = windows ? resolve(bin, file) : `${bin.replace(/\/$/, '')}/${file}`;
      try {
        if (!(await fileInfo(path, signal)).isFile()) continue;
        if (!windows) await executableAccess(path, signal);
        if (skip && (await skip(path))) continue;
        signal.throwIfAborted();
        return path;
      } catch (error) {
        if (!unavailablePath(error)) throw error;
      }
    }
  }
}

type OfficeCommandOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  timeout?: number;
};

function systemCommand(file: string) {
  const root = envValue('SYSTEMROOT');
  return win32.join(root && win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', file);
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (signal === 0 && code === 'EPERM') return true;
    throw error;
  }
}

class OfficeProcessCleanupError extends Error {
  constructor(message = 'Office CLI process tree shutdown could not be verified.') {
    super(message);
  }
}

async function activeGroups(groups: number[]) {
  const deadline = performance.now() + 500;
  let active = groups.filter((group) => signalGroup(group, 0));
  while (active.length > 0 && performance.now() < deadline) {
    await delay(20);
    active = active.filter((group) => signalGroup(group, 0));
  }
  return active;
}

async function posixProcesses(timeout: number) {
  const rows = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  return rows
    .trim()
    .split('\n')
    .map((row) => {
      const [pid, parent, group, state] = row.trim().split(/\s+/);
      return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
    });
}

async function livePosixGroups(groups: number[]) {
  if (groups.length === 0) return groups;
  const processes = await posixProcesses(500);
  const running = new Set(
    processes.filter(({ state }) => !state?.startsWith('Z')).map(({ group }) => group),
  );
  return groups.filter((group) => running.has(group));
}

async function stopPosixTree(pid: number) {
  const groups = new Set([pid]);
  try {
    // Pause the launcher while tracing descendants that created separate process groups.
    // shortcut: already reparented workers can lose their ancestry, use OS containment if a supported CLI daemonizes.
    if (!signalGroup(pid, 'SIGSTOP')) throw new OfficeProcessCleanupError();
    const deadline = performance.now() + 2_000;
    while (true) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new OfficeProcessCleanupError();
      const children = new Map<number, Awaited<ReturnType<typeof posixProcesses>>>();
      for (const process of await posixProcesses(remaining)) {
        const siblings = children.get(process.parent);
        if (siblings) siblings.push(process);
        else children.set(process.parent, [process]);
      }
      const descendants = new Set([pid]);
      for (const members of children.values()) {
        for (const process of members) {
          if (groups.has(process.group)) descendants.add(process.pid);
        }
      }
      let discoveredGroup = false;
      for (const parent of descendants) {
        for (const child of children.get(parent) ?? []) {
          descendants.add(child.pid);
          if (child.group > 0 && !groups.has(child.group)) {
            groups.add(child.group);
            signalGroup(child.group, 'SIGSTOP');
            discoveredGroup = true;
          }
        }
      }
      if (!discoveredGroup) break;
    }

    for (const group of groups) {
      signalGroup(group, 'SIGTERM');
      signalGroup(group, 'SIGCONT');
    }
    // Darwin can return EPERM for a group containing only zombies.
    const lingering = await livePosixGroups(await activeGroups([...groups]));
    for (const group of groups) {
      if (!lingering.includes(group)) groups.delete(group);
    }
    for (const group of lingering) signalGroup(group, 'SIGKILL');
    const remaining = await livePosixGroups(await activeGroups(lingering));
    for (const group of groups) {
      if (!remaining.includes(group)) groups.delete(group);
    }
    if (remaining.length > 0) throw new OfficeProcessCleanupError();
  } catch (error) {
    for (const group of groups) {
      try {
        signalGroup(group, 'SIGKILL');
      } catch {
        // Continue terminating all known groups before reporting cleanup failure.
      }
    }
    throw error;
  }
}

async function stopOfficeProcess(child: ChildProcess, windows: boolean) {
  const pid = child.pid;
  if (!pid) return;

  if (windows) {
    if (child.exitCode !== null || child.signalCode !== null) throw new OfficeProcessCleanupError();
    await new Promise<void>((resolve, reject) => {
      execFile(
        systemCommand('taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { timeout: 2_000, windowsHide: true },
        (error) => {
          if (!error) resolve();
          else reject(error);
        },
      );
    });
    return;
  }

  await stopPosixTree(pid);
}

export function runOfficeCommand(file: string, args: string[], options: OfficeCommandOptions = {}) {
  const { env: extraEnv, signal, timeout = 30_000 } = options;
  signal?.throwIfAborted();
  const deadline = officeDeadline(timeout, signal);
  const env = { ...process.env, ...extraEnv };
  const windows = process.platform === 'win32';
  if (windows) env.NoDefaultCurrentDirectoryInExePath = '1';
  let windowsVerbatimArguments = false;

  if (windows && /\.(cmd|bat)$/i.test(file)) {
    const shell = envValue('COMSPEC') ?? systemCommand('cmd.exe');
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
    windowsVerbatimArguments = true;
  }

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments,
    });
    let failure: Error | undefined;
    let termination: Promise<void> | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const stop = () => {
      termination ??= stopOfficeProcess(child, windows)
        .catch(() => {
          failure = new OfficeProcessCleanupError();
          try {
            child.kill('SIGKILL');
          } catch {
            // The caller will receive the unverified-cleanup error.
          }
          child.unref();
        })
        .finally(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          if (failure instanceof OfficeProcessCleanupError) {
            listener?.[Symbol.dispose]();
            reject(failure);
          }
        });
    };
    listener = addAbortListener(deadline, stop);
    const collect = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        if (failure || termination) return;
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          failure = new Error('Office CLI output exceeded its limit.');
          stop();
        } else {
          chunks.push(chunk);
        }
      });
      return () => Buffer.concat(chunks).toString('utf8');
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code) => {
      listener?.[Symbol.dispose]();
      void (async () => {
        await termination;
        if (failure) throw failure;
        deadline.throwIfAborted();
        if (code !== 0) throw new Error(`Office CLI exited with status ${code}.`);
        resolve({ stdout: stdout(), stderr: stderr() });
      })().catch(reject);
    });
  });
}

export function createOfficeCli(name: string, packageName: string, installDir: string) {
  const localBin = join(installDir, 'node_modules', '.bin');
  const hint = `自装目录为 ${installDir}。可运行 npm install -g ${packageName} 并将 ${name} 加入 PATH。`;
  let installation: Promise<void> | undefined;
  let localInstallBlocked = false;

  async function isManagedExecutable(file: string, deadline: AbortSignal) {
    const resolveIfPresent = (directory: string) =>
      executableTarget(directory, deadline).catch((error: unknown) => {
        if (unavailablePath(error)) return undefined;
        throw error;
      });
    const [root, bin, target, directory] = await Promise.all([
      resolveIfPresent(installDir),
      resolveIfPresent(localBin),
      executableTarget(file, deadline),
      executableTarget(dirname(file), deadline),
    ]);
    return [root, bin].some(
      (managed) =>
        managed &&
        [target, directory].some((candidate) => {
          const path = relative(managed, candidate);
          return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
        }),
    );
  }

  async function install() {
    const deadline = AbortSignal.timeout(120_000);
    let npmStarted = false;
    try {
      const npm = await findExecutable('npm', pathDirectories(), deadline);
      if (!npm) throw new Error('npm not found.');
      await makeInstallDirectory(installDir, deadline);
      deadline.throwIfAborted();
      npmStarted = true;
      await runOfficeCommand(npm, ['install', '--prefix', installDir, `${packageName}@latest`], {
        timeout: 120_000,
        signal: deadline,
      });
    } catch (error) {
      if (!npmStarted) localInstallBlocked = false;
      if (error instanceof OfficeProcessCleanupError) {
        throw new OfficeProcessCleanupError(`${name} 自动安装中断。${error.message} ${hint}`);
      }
      if (
        npmStarted &&
        (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError'))
      ) {
        throw new Error(
          `${name} 自动安装超时。请检查剩余的安装进程，确认安装目录完整后再重启 Pi。${hint}`,
        );
      }
      if (npmStarted) {
        throw new Error(`${name} 自动安装失败。请确认自装副本完整后再重启 Pi。${hint}`);
      }
      throw new Error(`${name} 自动安装失败。${hint}`);
    }
  }

  return async (signal?: AbortSignal): Promise<string> => {
    async function locate(
      directories: string[],
      deadline: AbortSignal,
      skip?: (file: string) => Promise<boolean>,
    ) {
      try {
        return await findExecutable(name, directories, deadline, skip);
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
    const directories = pathDirectories();
    while (true) {
      const blocked = localInstallBlocked;
      const preinstalled = await locate(
        directories,
        probe,
        blocked ? (file) => isManagedExecutable(file, probe) : undefined,
      );
      if (localInstallBlocked !== blocked) continue;
      if (!preinstalled) break;
      const available = await works(preinstalled, probe);
      if (localInstallBlocked !== blocked) continue;
      if (available) return preinstalled;
      throw new Error(`PATH 上的 ${name} 无法运行。请检查 ${preinstalled}。${hint}`);
    }

    if (!localInstallBlocked) {
      const local = await locate([localBin], probe);
      if (local && (await works(local, probe)) && !localInstallBlocked) return local;
    }
    signal?.throwIfAborted();
    if (probe.aborted) throw new Error(`检查 ${name} 超时。${hint}`);
    if (!installation) {
      localInstallBlocked = true;
      // Keep the local copy blocked when npm fails after starting, since it can be incomplete.
      installation = install().then(() => {
        localInstallBlocked = false;
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
