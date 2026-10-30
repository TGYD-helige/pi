import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  concatVideos,
  probeVideoDuration,
  resolveFfmpeg,
  resolveFfprobe,
  resolveGplFfmpeg,
  runFfmpegCommand,
} from '../ffmpeg.js';
import { CancelledError } from '../providers/task.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-ffmpeg');

describe('resolveFfmpeg', () => {
  beforeEach(() => {
    vi.stubEnv('FFMPEG_PATH', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('keeps the event loop responsive during binary detection', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const binary = join(suiteDir, 'slow-ffmpeg');
    writeFileSync(binary, '#!/bin/sh\nsleep 0.1\nexit 0\n');
    chmodSync(binary, 0o755);
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);
    try {
      const result = await resolveFfmpeg(binary);
      expect(result.runnable).toBe(true);
      expect(timerFired).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('reuses successful detections without spawning the same binary again', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const binary = join(suiteDir, 'cached-ffmpeg');
    const counter = join(suiteDir, 'calls');
    writeFileSync(binary, `#!/bin/sh\necho probe >> "${counter}"\nexit 0\n`);
    chmodSync(binary, 0o755);
    expect((await resolveFfmpeg(binary)).runnable).toBe(true);
    expect((await resolveFfmpeg(binary)).runnable).toBe(true);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['probe']);
  });

  it('cancels an in-progress binary detection', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const binary = join(suiteDir, 'cancel-ffmpeg');
    writeFileSync(binary, '#!/bin/sh\nexec sleep 10\n');
    chmodSync(binary, 0o755);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(resolveFfmpeg(binary, controller.signal)).rejects.toBeInstanceOf(CancelledError);
    } finally {
      clearTimeout(timer);
    }
  });

  it('settings path wins and reports source', async () => {
    const res = await resolveFfmpeg('/custom/ffmpeg');
    expect(res.path).toBe('/custom/ffmpeg');
    expect(res.source).toBe('settings');
  });

  it('env FFMPEG_PATH is second', async () => {
    vi.stubEnv('FFMPEG_PATH', '/env/ffmpeg');
    const res = await resolveFfmpeg();
    expect(res.path).toBe('/env/ffmpeg');
    expect(res.source).toBe('env');
  });

  it('falls back to a bundled platform package or the development ffmpeg-static', async () => {
    const res = await resolveFfmpeg();
    expect(res.source).toBe('bundled');
    expect(res.path.includes('ffmpeg')).toBe(true);
    expect(res.runnable).toBe(true);
  });

  it('only reports a custom ffmpeg as H.264-capable when libx264 is available', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const ffmpeg = join(suiteDir, 'custom-ffmpeg');
    writeFileSync(
      ffmpeg,
      [
        '#!/bin/sh',
        'if [ "$1" = "-version" ]; then exit 0; fi',
        'echo " V..... mpeg4"',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(ffmpeg, 0o755);

    expect(await resolveGplFfmpeg(ffmpeg)).toMatchObject({
      path: ffmpeg,
      source: 'settings',
      runnable: false,
    });

    writeFileSync(
      ffmpeg,
      [
        '#!/bin/sh',
        'if [ "$1" = "-version" ]; then exit 0; fi',
        'echo " V....D libx264"',
        'exit 0',
      ].join('\n'),
    );
    expect(await resolveGplFfmpeg(ffmpeg)).toMatchObject({
      path: ffmpeg,
      source: 'settings',
      runnable: true,
    });
  });

  it('does not mix an explicitly configured ffmpeg with ffprobe from PATH', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const ffmpeg = join(suiteDir, 'ffmpeg');
    writeFileSync(ffmpeg, '#!/bin/sh\nexit 0\n');
    chmodSync(ffmpeg, 0o755);

    expect(await resolveFfprobe(ffmpeg)).toMatchObject({
      path: join(suiteDir, 'ffprobe'),
      source: 'settings',
      runnable: false,
    });

    vi.stubEnv('FFMPEG_PATH', ffmpeg);
    expect(await resolveFfprobe()).toMatchObject({
      path: join(suiteDir, 'ffprobe'),
      source: 'env',
      runnable: false,
    });
  });
});

describe('probeVideoDuration', () => {
  afterEach(() => {
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('uses a per-stream DURATION tag when numeric stream duration is absent', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const ffprobe = join(suiteDir, 'ffprobe');
    writeFileSync(
      ffprobe,
      '#!/bin/sh\nprintf \'{"streams":[{"tags":{"DURATION":"00:00:01.250000000"}}]}\'\n',
    );
    chmodSync(ffprobe, 0o755);

    await expect(probeVideoDuration(ffprobe, join(suiteDir, 'sample.webm'))).resolves.toBe(1.25);
  });
});

describe('concatVideos', () => {
  let dir: string;
  let logPath: string;
  let fakeFfmpeg: string;

  beforeEach(() => {
    dir = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'args.log');
  });

  function writeFakeFfmpeg(copyFails: boolean): string {
    fakeFfmpeg = join(dir, 'fake-ffmpeg.sh');
    writeFileSync(
      fakeFfmpeg,
      [
        '#!/bin/sh',
        `echo "$@" >> "${logPath}"`,
        'for last; do :; done',
        copyFails ? 'echo "$@" | grep -q -- "-c copy" && exit 1' : ':',
        'printf "FAKEMP4" > "$last"',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(fakeFfmpeg, 0o755);
    return fakeFfmpeg;
  }

  it('concatenates losslessly when -c copy works', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    writeFileSync(a, 'x');
    writeFileSync(b, 'x');
    const out = join(dir, 'final.mp4');

    await concatVideos({ inputs: [a, b], outputPath: out, ffmpegPath: ffmpeg });

    const log = readFileSync(logPath, 'utf-8');
    expect((log.match(/-f concat/g) ?? []).length).toBe(1);
    expect(log).toContain('-c copy');
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4');
  });

  it('falls back to libx264 re-encode when -c copy fails', async () => {
    const ffmpeg = writeFakeFfmpeg(true);
    const a = join(dir, 'a.mp4');
    const out = join(dir, 'final.mp4');
    writeFileSync(a, 'x');

    await concatVideos({ inputs: [a], outputPath: out, ffmpegPath: ffmpeg });

    const log = readFileSync(logPath, 'utf-8');
    expect((log.match(/-f concat/g) ?? []).length).toBe(2);
    expect(log).toContain('mpeg4'); // LGPL-clean fallback codec, never libx264
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4');
  });

  it('a pre-placed final_video symlink is replaced, never followed', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const a = join(dir, 'a.mp4');
    writeFileSync(a, 'x');
    const victim = join(dir, 'victim.bin');
    writeFileSync(victim, 'precious');
    const out = join(dir, 'final.mp4');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(victim, out, 'file');

    await concatVideos({ inputs: [a], outputPath: out, ffmpegPath: ffmpeg });

    expect(readFileSync(victim, 'utf-8')).toBe('precious'); // untouched
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4'); // real output in place
    // list file and temp output are cleaned up
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it('does not follow a pre-placed concat temp-output symlink', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const input = join(dir, 'a.mp4');
    const out = join(dir, 'final.mp4');
    const victim = join(dir, 'victim.bin');
    writeFileSync(input, 'x');
    writeFileSync(victim, 'precious');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      for (let counter = 0; counter < 20; counter += 1) {
        symlinkSync(victim, `${out}.tmp-${process.pid}-${counter}-.mp4`);
      }
      await concatVideos({ inputs: [input], outputPath: out, ffmpegPath: ffmpeg });
    } finally {
      random.mockRestore();
    }

    expect(readFileSync(victim, 'utf-8')).toBe('precious');
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4');
  });

  it('leaves no private concat work directory behind', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const a = join(dir, 'a.mp4');
    writeFileSync(a, 'x');
    await concatVideos({ inputs: [a], outputPath: join(dir, 'final.mp4'), ffmpegPath: ffmpeg });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((name) => name.startsWith('.concat-'))).toHaveLength(0);
  });

  it('cleans its private work directory when the concat list cannot be written', async () => {
    if (process.platform === 'win32') return;
    const previousUmask = process.umask(0o777);
    try {
      await expect(
        concatVideos({
          inputs: [join(dir, 'a.mp4')],
          outputPath: join(dir, 'final.mp4'),
          ffmpegPath: writeFakeFfmpeg(false),
        }),
      ).rejects.toThrow();
    } finally {
      process.umask(previousUmask);
    }
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((name) => name.startsWith('.concat-'))).toEqual([]);
  });

  it('rejects empty input', async () => {
    await expect(
      concatVideos({ inputs: [], outputPath: join(dir, 'x.mp4'), ffmpegPath: 'ffmpeg' }),
    ).rejects.toThrow(/No clips/);
  });

  it('does not expose ffmpeg stderr paths or URLs to the caller', async () => {
    const ffmpeg = join(dir, 'failing-ffmpeg.sh');
    writeFileSync(
      ffmpeg,
      [
        '#!/bin/sh',
        'echo "failed reading /Users/alice/private.mov from https://example.test/video?token=secret" >&2',
        'exit 1',
      ].join('\n'),
    );
    chmodSync(ffmpeg, 0o755);

    let error: unknown;
    try {
      await runFfmpegCommand(ffmpeg, []);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected ffmpeg to fail');
    expect(error.message).not.toContain('/Users/alice');
    expect(error.message).not.toContain('token=secret');
    expect(error).toMatchObject({ logSummary: 'ffmpeg: exit 1' });
  });

  it('preserves cancellation instead of reporting ffmpeg as broken', async () => {
    const controller = new AbortController();
    const running = runFfmpegCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);

    await expect(running).rejects.toBeInstanceOf(CancelledError);
  });
});
