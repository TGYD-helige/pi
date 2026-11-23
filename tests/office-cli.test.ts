import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOfficeCommand } from '../packages/shared/src/office-cli.js';

const extensions = [
  {
    name: 'pi-lark',
    cli: 'lark-cli',
    npmPackage: '@larksuite/cli',
    skillsSubdir: 'skills',
    config: { appId: 'app-id', appSecret: 'fixture-secret' },
    load: () => import('../packages/pi-lark/src/index.js'),
  },
  {
    name: 'pi-wecom',
    cli: 'wecom-cli',
    npmPackage: '@wecom/cli',
    skillsSubdir: 'skills',
    config: { botId: 'bot-id', botSecret: 'fixture-secret' },
    load: () => import('../packages/pi-wecom/src/index.js'),
  },
  {
    name: 'pi-dingtalk',
    cli: 'dws',
    npmPackage: 'dingtalk-workspace-cli',
    skillsSubdir: 'skills/multi',
    config: { clientId: 'client-id', clientSecret: 'fixture-secret' },
    load: () => import('../packages/pi-dingtalk/src/index.js'),
  },
];

describe.skipIf(process.platform === 'win32').each(extensions)('$name CLI startup', (extension) => {
  let root: string;
  let home: string;
  let pathBin: string;
  let installDir: string;
  const notify = vi.fn();
  const setStatus = vi.fn();

  function writeExecutable(file: string, script: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  function writeCli(directory: string, source: string, outcome = "printf 'authorized\\n'") {
    writeExecutable(
      join(directory, extension.cli),
      `printf '%s %s\\n' '${source}' "$*" >> "$PI_OFFICE_TEST_LOG"\n${outcome}`,
    );
  }

  async function start() {
    const { default: register } = await extension.load();
    const on = vi.fn();
    register({ on } as Parameters<typeof register>[0]);
    const startHandler = on.mock.calls.find(([event]) => event === 'session_start')?.[1];
    await startHandler(
      { type: 'session_start', reason: 'startup' },
      { cwd: home, ui: { notify, setStatus } },
    );
    return on.mock.calls.find(([event]) => event === 'resources_discover')?.[1]();
  }

  function setHome(directory: string) {
    home = directory;
    installDir = join(home, `.${extension.cli}`);
    mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PI_OFFICE_TEST_LOG', join(home, 'cli.log'));
    vi.stubEnv('PI_CODING_AGENT_DIR', home);
    vi.stubEnv('LARKSUITE_CLI_CONFIG_DIR', home);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ [extension.name]: extension.config }));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-office-cli-'));
    pathBin = join(root, 'user bin');
    mkdirSync(pathBin);
    vi.stubEnv('PATH', pathBin);
    setHome(join(root, 'user home'));
    notify.mockClear();
    setStatus.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { source: 'PATH', hasPathCli: true },
    { source: 'self-installed', hasPathCli: false },
  ])('uses $source for startup when a self-installed copy exists', async ({ source, hasPathCli }) => {
    writeCli(join(installDir, 'node_modules', '.bin'), 'self-installed');
    if (hasPathCli) writeCli(pathBin, 'PATH');

    await start();

    const commands = readFileSync(join(home, 'cli.log'), 'utf8').trim().split('\n');
    expect(commands[0]).toBe(`${source} --version`);
    expect(commands.length).toBeGreaterThan(1);
    expect(commands.every((command) => command.startsWith(`${source} `))).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(extension.name, `${extension.cli}: ready`);
  });

  it('skips a cyclic CLI symlink in an earlier PATH directory', async () => {
    const staleBin = join(root, 'stale bin');
    mkdirSync(staleBin);
    symlinkSync(extension.cli, join(staleBin, extension.cli));
    vi.stubEnv('PATH', `${staleBin}${delimiter}${pathBin}`);
    writeCli(pathBin, 'PATH');

    await start();

    expect(setStatus).toHaveBeenCalledWith(extension.name, `${extension.cli}: ready`);
    expect(readFileSync(join(home, 'cli.log'), 'utf8')).toContain('PATH --version\n');
  });

  it('resolves parent directories after following a PATH symlink', async () => {
    const actualBin = join(root, 'actual bin');
    const target = join(actualBin, 'nested');
    const link = join(root, 'linked bin');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
    vi.stubEnv('PATH', `${link}/..`);
    writeCli(actualBin, 'PATH');
    writeCli(root, 'lexical parent');

    await start();

    expect(setStatus).toHaveBeenCalledWith(extension.name, `${extension.cli}: ready`);
    expect(readFileSync(join(home, 'cli.log'), 'utf8')).toMatch(/^PATH --version\n/);
  });

  it('discovers skills shipped with the selected PATH copy', async () => {
    const pinnedPackage = join(root, 'node_modules', extension.npmPackage);
    const pinnedSkills = join(pinnedPackage, extension.skillsSubdir);
    const localModules = join(installDir, 'node_modules');
    const localSkills = join(localModules, extension.npmPackage, extension.skillsSubdir);
    const pinnedBin = join(pinnedPackage, 'bin');
    writeCli(pinnedBin, 'PATH');
    symlinkSync(join(pinnedBin, extension.cli), join(pathBin, extension.cli));
    writeCli(join(localModules, '.bin'), 'self-installed');
    mkdirSync(pinnedSkills, { recursive: true });
    mkdirSync(localSkills, { recursive: true });

    expect(await start()).toMatchObject({ skillPaths: [realpathSync(pinnedSkills)] });
  });

  it('uses the self-installed copy when the home directory contains a colon', async () => {
    setHome(join(root, 'home:work'));
    writeCli(join(installDir, 'node_modules', '.bin'), 'self-installed');

    await start();

    expect(setStatus).toHaveBeenCalledWith(extension.name, `${extension.cli}: ready`);
    expect(readFileSync(join(home, 'cli.log'), 'utf8')).toContain('self-installed --version\n');
  });

  it('installs @latest on first startup and uses the installed CLI', async () => {
    writeCli(join(home, 'fixture'), 'newly-installed');
    writeExecutable(
      join(pathBin, 'npm'),
      `[ "$1" = install ] || exit 0
printf '%s\\n' "$@" > "$HOME/npm.log"
/bin/mkdir -p "$3/node_modules/.bin"
/bin/cp "$HOME/fixture/${extension.cli}" "$3/node_modules/.bin/${extension.cli}"`,
    );

    await start();

    expect(readFileSync(join(home, 'npm.log'), 'utf8').trim().split('\n')).toEqual([
      'install',
      '--prefix',
      installDir,
      `${extension.npmPackage}@latest`,
    ]);
    expect(readFileSync(join(home, 'cli.log'), 'utf8')).toContain('newly-installed --version\n');
    expect(setStatus).toHaveBeenCalledWith(extension.name, `${extension.cli}: ready`);
  });

  it('reports an unusable PATH copy without falling back or reinstalling', async () => {
    writeCli(pathBin, 'PATH', "printf 'pinned CLI output' >&2\nexit 1");
    writeCli(join(installDir, 'node_modules', '.bin'), 'self-installed');
    writeExecutable(join(pathBin, 'npm'), `printf '%s\\n' "$@" > "$HOME/npm.log"`);

    await start();

    expect(existsSync(join(home, 'npm.log'))).toBe(false);
    const commands = readFileSync(join(home, 'cli.log'), 'utf8');
    expect(commands).toContain('PATH --version\n');
    expect(commands).not.toContain('self-installed ');
    expect(setStatus).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('PATH'), 'warning');
    expect(notify.mock.calls[0]?.[0]).toContain(extension.cli);
    expect(notify.mock.calls[0]?.[0]).not.toContain('pinned CLI output');
  });

  it.each([0, 1])('gives setup instructions when npm exits %i and the CLI is unavailable', async (exitCode) => {
    writeExecutable(join(pathBin, 'npm'), `printf 'installer output' >&2\nexit ${exitCode}`);

    await start();

    expect(setStatus).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(`npm install -g ${extension.npmPackage}`),
      'warning',
    );
    const message = notify.mock.calls[0]?.[0];
    expect(message).toContain(extension.cli);
    expect(message).toContain(installDir);
    expect(message).toContain('PATH');
    expect(message).not.toContain('installer output');
  });
});

describe.skipIf(process.platform === 'win32')('runOfficeCommand', () => {
  it('waits for an aborted command to exit even when it ignores SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-office-cli-signal-'));
    const pidFile = join(root, 'pid');
    const controller = new AbortController();
    const command = runOfficeCommand(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(process.argv[1], String(process.pid));
setInterval(() => {}, 1000);`,
        pidFile,
      ],
      { signal: controller.signal, timeout: 3000 },
    ).catch((error: unknown) => error);
    let pid: number | undefined;

    function exited(childPid: number) {
      try {
        process.kill(childPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    }

    try {
      pid = await vi.waitFor(() => {
        const childPid = Number(readFileSync(pidFile, 'utf8'));
        expect(childPid).toBeGreaterThan(1);
        return childPid;
      });
      controller.abort();

      expect(await command).toMatchObject({ name: 'AbortError' });
      expect(exited(pid)).toBe(true);
    } finally {
      controller.abort();
      const childPid = pid;
      if (childPid !== undefined && !exited(childPid)) {
        process.kill(childPid, 'SIGKILL');
        await vi.waitFor(() => expect(exited(childPid)).toBe(true));
      }
      await command;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
