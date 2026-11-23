import type { ExecFileException } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, type Stats, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOfficeCli } from '../office-cli.js';

const execFile = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => void
  >(),
);
const slowStat = vi.hoisted(() => vi.fn<(file: string) => Promise<Stats> | undefined>());
vi.mock('node:child_process', () => ({ execFile }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const { accessSync, statSync } = await import('node:fs');
  // Keep executable discovery in the promise queue so the subprocess controls when installation finishes.
  return {
    ...original,
    access: async (file: string, mode: number) => accessSync(file, mode),
    stat: async (file: string) => slowStat(file) ?? statSync(file),
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
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
      execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));

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
      execFile.mockReset();
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
      execFile.mockImplementation((file, _args, _options, callback) => {
        if (file === npm) {
          installStarted.resolve();
          void releaseInstaller.promise.then(() => callback(null, '', ''));
        } else {
          callback(null, '', '');
        }
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
      expect(execFile.mock.calls.filter(([file]) => file === npm)).toHaveLength(1);
    } finally {
      execFile.mockReset();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
