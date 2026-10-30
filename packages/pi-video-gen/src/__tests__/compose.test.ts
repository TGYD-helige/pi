import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ClipComposeSpec, runCompose } from '../compose.js';
import { probeStreams, resolveFfprobe } from '../ffmpeg.js';
import { ActiveJobs, loadComposeJob } from '../jobs/store.js';
import { CancelledError } from '../providers/task.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-compose');
const require = createRequire(import.meta.url);
const ffmpegBin = require('ffmpeg-static') as string;

function makeClip(
  dir: string,
  name: string,
  opts: { size?: string; seconds?: number } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  const size = opts.size ?? '64x64';
  const seconds = String(opts.seconds ?? 1);
  execFileSync(
    ffmpegBin,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=red:size=${size}`,
      '-t',
      seconds,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      p,
    ],
    {
      stdio: 'ignore',
    },
  );
  return p;
}

function makeJob(cwd: string, spec: ClipComposeSpec): string {
  const jobDir = join(cwd, '.video-gen', 'job-c0');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'compose-input.json'), JSON.stringify(spec));
  return jobDir;
}

function baseOpts(cwd: string) {
  return {
    cwd,
    settings: {},
    activeJobs: new ActiveJobs(),
  };
}

describe('runCompose (C0)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('concatenates compatible clips end-to-end with strict copy', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });

    const result = await runCompose({
      composeSpecPath: join(jobDir, 'compose-input.json'),
      ...baseOpts(cwd),
    });

    expect(result.clipCount).toBe(2);
    expect(result.resumed).toBe(false);
    expect(existsSync(result.finalVideoPath)).toBe(true);
    const manifest = loadComposeJob(jobDir)!;
    expect(manifest.state).toBe('done');
    expect(Object.keys(manifest.clipHashes)).toHaveLength(2);
    // final duration ≈ 2s (probe it with the real ffprobe resolution)
    const probe = await resolveFfprobe();
    const info = await probeStreams(probe.path, result.finalVideoPath);
    expect(info.videoCodec).toBe('h264');
  });

  it('requires the canonical compose spec to be named compose-input.json', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const targetDir = join(cwd, '.video-gen', 'target-job');
    const aliasDir = join(cwd, '.video-gen', 'alias-job');
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(aliasDir, { recursive: true });
    const target = join(targetDir, 'other.json');
    writeFileSync(
      target,
      JSON.stringify({
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
    );
    const alias = join(aliasDir, 'compose-input.json');
    symlinkSync(target, alias);

    await expect(runCompose({ composeSpecPath: alias, ...baseOpts(cwd) })).rejects.toThrow(
      /must be named compose-input\.json/,
    );
  });

  it('resume with identical input returns cached result without re-concat', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const specPath = join(
      makeJob(cwd, {
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
      'compose-input.json',
    );
    await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });

    const result = await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });
    expect(result.resumed).toBe(true);
    expect(existsSync(result.finalVideoPath)).toBe(true);
  });

  it('reruns the same job after cancellation during the stream precheck', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });
    const specPath = join(jobDir, 'compose-input.json');
    const controller = new AbortController();

    const running = runCompose({
      composeSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Probing')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(loadComposeJob(jobDir)).toMatchObject({ state: 'concatenating' });

    const result = await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });
    expect(existsSync(result.finalVideoPath)).toBe(true);
    expect(loadComposeJob(jobDir)).toMatchObject({ state: 'done' });
  });

  it('refuses a completed final video whose bytes changed', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });
    const specPath = join(jobDir, 'compose-input.json');
    const first = await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });

    writeFileSync(first.finalVideoPath, 'tampered final video');

    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video.*changed/i,
    );
  });

  it('rejects a completed manifest that points outside its job directory', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });
    const specPath = join(jobDir, 'compose-input.json');
    await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });
    const outside = join(cwd, 'outside.mp4');
    writeFileSync(outside, 'not this job output');
    const manifest = loadComposeJob(jobDir)!;
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...manifest, finalVideoPath: outside }),
    );

    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video path/i,
    );
  });

  it('refuses resume when a clip changed (revision ⇒ new job)', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const specPath = join(
      makeJob(cwd, {
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
      'compose-input.json',
    );
    await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });

    writeFileSync(a, 'tampered bytes');
    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /NEW job directory/,
    );
  });

  it('reports exact stream differences for incompatible clips (no silent transcode)', async () => {
    const a = makeClip(cwd, 'a.mp4', { size: '64x64' });
    const b = makeClip(cwd, 'b.mp4', { size: '128x96' }); // resolution mismatch
    const specPath = join(
      makeJob(cwd, {
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
      'compose-input.json',
    );

    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /NOT stream-compatible.*resolution 64x64 vs 128x96/s,
    );
    const manifest = loadComposeJob(join(cwd, '.video-gen', 'job-c0'))!;
    expect(manifest.state).toBe('failed');
  });

  it('validates spec before anything: ≥2 clips, unique ids, mode copy, real files', async () => {
    const a = makeClip(cwd, 'a.mp4');
    // fewer than 2
    const one = makeJob(cwd, { clips: [{ id: 'c1', path: a }] });
    await expect(
      runCompose({ composeSpecPath: join(one, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/at least 2 clips/);
    // duplicate ids
    const dup = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c1', path: a },
      ],
    });
    await expect(
      runCompose({ composeSpecPath: join(dup, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/Duplicate clip id/);
    // bad mode
    const badMode = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: a },
      ],
      output: { mode: 'reencode' },
    });
    await expect(
      runCompose({ composeSpecPath: join(badMode, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/must be "copy"/);
    // missing file
    const missing = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: join(cwd, 'nope.mp4') },
      ],
    });
    await expect(
      runCompose({ composeSpecPath: join(missing, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/not a readable regular file/);
  });

  it('rejects malformed output settings instead of defaulting to copy', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const jobDir = join(cwd, '.video-gen', 'job-c0');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'compose-input.json');
    for (const output of [null, '', [], { mode: null }]) {
      writeFileSync(
        specPath,
        JSON.stringify({
          clips: [
            { id: 'c1', path: a },
            { id: 'c2', path: a },
          ],
          output,
        }),
      );
      await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
        /output(?:\.mode)? must/,
      );
    }
  });

  it('rejects non-string clip ids (JSON 1 and "1" cannot bypass dedupe)', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 1, path: a },
        { id: '1', path: a },
      ] as never,
    });
    await expect(
      runCompose({ composeSpecPath: join(jobDir, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/id must be a string/);
  });

  it('fail-closed on a foreign (render-kind) manifest in the compose job dir', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });
    // a render manifest with paid task handles lives here
    const foreign = JSON.stringify({
      jobId: 'job-c0',
      kind: 'render',
      state: 'submitted',
      specFingerprint: 'fp',
      frameHashes: { x: 'a'.repeat(64) },
      shots: {
        s1: {
          state: 'submitted',
          handle: { taskId: 'paid-task', submittedAt: 'x', requestFingerprint: 'fp' },
        },
      },
      updatedAt: 'x',
    });
    writeFileSync(join(jobDir, 'manifest.json'), foreign);

    await expect(
      runCompose({ composeSpecPath: join(jobDir, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/already holds a "render" job manifest/);
    // the paid recovery state is untouched
    expect(readFileSync(join(jobDir, 'manifest.json'), 'utf-8')).toBe(foreign);
  });

  it('frozen snapshots stay immutable when the source or snapshot changes', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const specPath = join(
      makeJob(cwd, {
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
      'compose-input.json',
    );
    await runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) });
    const jobDir = join(cwd, '.video-gen', 'job-c0');

    // snapshot was written into the job
    expect(existsSync(join(jobDir, 'clips', 'c1.mp4'))).toBe(true);

    // tamper the SNAPSHOT → never silently repair an immutable job
    writeFileSync(join(jobDir, 'clips', 'c1.mp4'), 'tampered-snapshot');
    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /Frozen clip snapshot/,
    );

    // source drift: fresh valid run first, THEN corrupt the source
    const a2 = makeClip(cwd, 'a2.mp4');
    const jobDir2 = join(cwd, '.video-gen', 'job-c1');
    mkdirSync(jobDir2, { recursive: true });
    writeFileSync(
      join(jobDir2, 'compose-input.json'),
      JSON.stringify({
        clips: [
          { id: 'c1', path: a2 },
          { id: 'c2', path: b },
        ],
      }),
    );
    await runCompose({ composeSpecPath: join(jobDir2, 'compose-input.json'), ...baseOpts(cwd) });
    const frozenBeforeDrift = readFileSync(join(jobDir2, 'clips', 'c1.mp4'));
    writeFileSync(a2, 'source-changed');
    await expect(
      runCompose({ composeSpecPath: join(jobDir2, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/NEW job directory/);
    expect(readFileSync(join(jobDir2, 'clips', 'c1.mp4'))).toEqual(frozenBeforeDrift);
  });

  it('refuses to delete a pre-existing clips directory for a fresh job', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });
    const keep = join(jobDir, 'clips', 'keep.txt');
    mkdirSync(join(jobDir, 'clips'));
    writeFileSync(keep, 'user data');

    await expect(
      runCompose({ composeSpecPath: join(jobDir, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/clips.*already exists/i);
    expect(readFileSync(keep, 'utf-8')).toBe('user data');
  });

  it('refuses to replace a pre-existing final video for a fresh job', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const b = makeClip(cwd, 'b.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: b },
      ],
    });
    const finalVideoPath = join(jobDir, 'final_video.mp4');
    writeFileSync(finalVideoPath, 'user data');

    await expect(
      runCompose({ composeSpecPath: join(jobDir, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/final_video\.mp4.*already exists/i);
    expect(readFileSync(finalVideoPath, 'utf-8')).toBe('user data');
    expect(existsSync(join(jobDir, 'clips'))).toBe(false);
    expect(loadComposeJob(jobDir)).toBeUndefined();
  });

  it('detects audio sample-rate mismatches in the precheck', async () => {
    const a = join(cwd, 'a.mp4');
    const b = join(cwd, 'b.mp4');
    execFileSync(
      ffmpegBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=red:size=64x64',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        a,
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      ffmpegBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=blue:size=64x64',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        b,
      ],
      { stdio: 'ignore' },
    );
    const specPath = join(
      makeJob(cwd, {
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
      'compose-input.json',
    );
    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /audio sample rate 44100 vs 48000/,
    );
  });

  it('detects incompatibilities in secondary audio tracks before concat', async () => {
    const makeMultiAudioClip = (path: string, secondLayout: 'mono' | 'stereo') => {
      execFileSync(
        ffmpegBin,
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=red:size=64x64',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-f',
          'lavfi',
          '-i',
          `anullsrc=r=48000:cl=${secondLayout}`,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-map',
          '2:a',
          '-t',
          '1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          path,
        ],
        { stdio: 'ignore' },
      );
    };
    const a = join(cwd, 'multi-a.mp4');
    const b = join(cwd, 'multi-b.mp4');
    makeMultiAudioClip(a, 'mono');
    makeMultiAudioClip(b, 'stereo');
    const specPath = join(
      makeJob(cwd, {
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
      }),
      'compose-input.json',
    );

    await expect(runCompose({ composeSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /stream 2.*mono.*stereo/i,
    );
  });

  it('rejects job outside outputDir and wrong spec filename', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const outside = join(cwd, 'elsewhere', 'job-x');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'compose-input.json'),
      JSON.stringify({
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: a },
        ],
      }),
    );
    await expect(
      runCompose({ composeSpecPath: join(outside, 'compose-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/must live under/);

    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: a },
      ],
    });
    const { renameSync } = await import('node:fs');
    renameSync(join(jobDir, 'compose-input.json'), join(jobDir, 'spec.json'));
    await expect(
      runCompose({ composeSpecPath: join(jobDir, 'spec.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/must be named compose-input.json/);
  });

  it('does not expose Windows parent directories in clip errors', async () => {
    const a = makeClip(cwd, 'a.mp4');
    const jobDir = makeJob(cwd, {
      clips: [
        { id: 'c1', path: a },
        { id: 'c2', path: String.raw`C:\Users\alice\private.mp4` },
      ],
    });

    let error: unknown;
    try {
      await runCompose({
        composeSpecPath: join(jobDir, 'compose-input.json'),
        ...baseOpts(cwd),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('private.mp4');
    expect((error as Error).message).not.toContain(String.raw`C:\Users\alice`);
  });
});
