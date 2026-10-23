import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFfmpeg, runFfmpegCommand } from '../ffmpeg.js';
import { ActiveJobs } from '../jobs/store.js';
import { parseRemotionSpec, preflightRemotion, runRemotion } from '../remotion.js';

const root = join(tmpdir(), 'pi-video-gen-remotion');
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runRemotion', () => {
  it('rejects unbounded or invalid review timestamps before rendering', () => {
    const spec = { projectDir: root, compositionId: 'Promo' };
    for (const qcTimesSec of [[-1], [null], ['1'], Array(33).fill(1), '1']) {
      expect(() => parseRemotionSpec(JSON.stringify({ ...spec, qcTimesSec }))).toThrow(
        /qcTimesSec/,
      );
    }
    expect(
      parseRemotionSpec(JSON.stringify({ ...spec, qcTimesSec: [0, 1.25] })).qcTimesSec,
    ).toEqual([0, 1.25]);
  });

  it.each([
    false,
    true,
  ])('records and verifies exported review frames (audio tail: %s)', async (audioTail) => {
    const fps = audioTail ? 10 : 25;
    const project = join(root, 'review-project');
    const job = join(root, '.video-gen', 'review-job');
    const ffmpegPath = resolveFfmpeg().path;
    for (const dir of [join(project, 'src'), join(project, 'public'), job])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'src', 'index.ts'), 'root');
    for (const name of [
      'remotion',
      '@remotion/bundler',
      '@remotion/renderer',
      'react',
      'react-dom',
    ]) {
      const dir = join(project, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}');
    }
    await runFfmpegCommand(createRequire(import.meta.url)('ffmpeg-static') as string, [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=160x90:r=${fps}:d=${audioTail ? 0.1 : 2}`,
      ...(audioTail ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'aac'] : []),
      '-c:v',
      'mpeg4',
      '-y',
      join(project, 'public', 'source.mp4'),
    ]);
    writeFileSync(
      join(project, 'node_modules', '@remotion', 'bundler', 'index.js'),
      'exports.bundle = async ({publicDir}) => publicDir;',
    );
    writeFileSync(
      join(project, 'node_modules', '@remotion', 'renderer', 'index.js'),
      `
      const fs = require('node:fs'); const path = require('node:path');
      exports.selectComposition = async () => ({fps: ${fps}, durationInFrames: ${audioTail ? 1 : 50}, props: {}});
      exports.renderStill = async ({output}) => fs.writeFileSync(output, 'frame');
      exports.renderMedia = async ({serveUrl, outputLocation}) => fs.copyFileSync(path.join(serveUrl, 'source.mp4'), outputLocation);
    `,
    );
    const spec = {
      projectDir: project,
      compositionId: 'Promo',
      qcTimesSec: audioTail ? [0.09] : [0.9, 1, 1.16, 1.99, 1.9999999999999998],
    };
    writeFileSync(join(job, 'remotion-input.json'), JSON.stringify(spec));
    const opts = {
      specPath: join(job, 'remotion-input.json'),
      cwd: root,
      settings: {},
      activeJobs: new ActiveJobs(),
      trusted: true,
      ffmpegPath,
    };
    const first = await runRemotion(opts);
    expect(first.qcFrames).toHaveLength(audioTail ? 4 : 7);
    expect(readFileSync(first.qcFrames![0]!).subarray(1, 4).toString()).toBe('PNG');
    const report = JSON.parse(readFileSync(first.qcReportPath!, 'utf8'));
    const expectedTimes = audioTail
      ? [0.025, 0.05, 0.075, 0.09]
      : [0.5, 0.9, 1, 1.16, 1.5, 1.99, 1.9999999999999998];
    report.samples.forEach((sample: { timeSec: number }, index: number) => {
      expect(sample.timeSec).toBeCloseTo(expectedTimes[index]!);
    });
    expect(report.finalVideoHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.samples.at(-1).frameTimeSec).toBe(audioTail ? 0 : 1.96);
    if (!audioTail) {
      const expectedFrame = join(root, 'boundary.png');
      await runFfmpegCommand(ffmpegPath, [
        '-ss',
        '1.16',
        '-i',
        first.finalVideoPath,
        '-frames:v',
        '1',
        '-y',
        expectedFrame,
      ]);
      const boundary = report.samples.find(
        (sample: { timeSec: number }) => sample.timeSec === 1.16,
      );
      expect(readFileSync(join(job, boundary.path)).equals(readFileSync(expectedFrame))).toBe(true);
      expect(boundary.frameTimeSec).toBe(1.16);
    }
    const resumed = await runRemotion(opts);
    expect(resumed.resumed).toBe(true);
    expect(resumed.qcFrames).toEqual(first.qcFrames);
    writeFileSync(first.qcFrames![0]!, 'tampered');
    await expect(runRemotion(opts)).rejects.toThrow(/QC/);
    const manifestPath = join(job, 'remotion-manifest.json');
    const legacy = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const removed = Object.keys(legacy.qcHashes).find((path) => path.endsWith('frame_00.png'))!;
    rmSync(first.qcFrames![0]!);
    delete legacy.qcHashes[removed];
    writeFileSync(manifestPath, JSON.stringify(legacy));
    await expect(runRemotion(opts)).rejects.toThrow(/QC/);
    legacy.qcHashes = {};
    writeFileSync(manifestPath, JSON.stringify(legacy));
    await expect(runRemotion(opts)).rejects.toThrow(/QC/);
    delete legacy.qcHashes;
    writeFileSync(manifestPath, JSON.stringify(legacy));
    expect((await runRemotion(opts)).qcFrames).toEqual([]);
    await expect(
      preflightRemotion({
        spec: { ...spec, qcTimesSec: [2] },
        cwd: root,
        jobDir: job,
        assets: {},
        ffmpegPath,
      }),
    ).rejects.toThrow(/qcTimesSec/);
  });

  it('holds the job lock until cancellation stops a detached browser launched before Remotion cleanup', async () => {
    const project = join(root, 'cancel-project');
    const job = join(root, '.video-gen', 'cancel-job');
    const marker = join(job, 'renderer-child.pid');
    const helperMarker = join(job, 'renderer-helper.pid');
    const browserReady = join(job, 'browser-ready');
    const originalPath = process.env.PATH;
    for (const dir of [
      join(project, 'src'),
      ...['remotion', '@remotion/bundler', '@remotion/renderer', 'react', 'react-dom'].map((name) =>
        join(project, 'node_modules', name),
      ),
      job,
    ])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'src', 'index.ts'), 'root');
    const browserScript = join(project, 'browser.cjs');
    writeFileSync(
      browserScript,
      `
      const fs = require('node:fs');
      const {spawn} = require('node:child_process');
      if (process.platform !== 'win32') process.on('SIGUSR1', () => {
        const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', detached: true});
        fs.writeFileSync(${JSON.stringify(helperMarker)}, String(helper.pid));
      });
      fs.writeFileSync(${JSON.stringify(browserReady)}, 'ready');
      setInterval(() => {}, 1000);
    `,
    );
    if (process.platform !== 'win32') {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const fakePs = join(bin, 'ps');
      writeFileSync(
        fakePs,
        `#!/usr/bin/env node
        const fs = require('node:fs');
        const {execFileSync} = require('node:child_process');
        process.stdout.write(execFileSync('/bin/ps', process.argv.slice(2)));
        if (!fs.existsSync(${JSON.stringify(join(job, 'ps-triggered'))})) {
          fs.writeFileSync(${JSON.stringify(join(job, 'ps-triggered'))}, 'yes');
          process.kill(Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')), 'SIGUSR1');
          const deadline = Date.now() + 2000;
          while (!fs.existsSync(${JSON.stringify(helperMarker)}) && Date.now() < deadline)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      `,
      );
      chmodSync(fakePs, 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
    }
    for (const name of [
      'remotion',
      '@remotion/bundler',
      '@remotion/renderer',
      'react',
      'react-dom',
    ])
      writeFileSync(join(project, 'node_modules', name, 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(
      join(project, 'node_modules', '@remotion', 'bundler', 'index.js'),
      'exports.bundle = async () => "bundle";',
    );
    writeFileSync(
      join(project, 'node_modules', '@remotion', 'renderer', 'index.js'),
      `
      const fs = require('node:fs');
      const {spawn} = require('node:child_process');
      exports.selectComposition = async () => {
        process.on('SIGTERM', () => setTimeout(() => process.exit(1), 300));
        const child = spawn(process.execPath, ${JSON.stringify([browserScript])}, {stdio: 'ignore', detached: process.platform !== 'win32'});
        fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
        await new Promise(() => {});
      };
      exports.renderMedia = async () => {};
    `,
    );
    writeFileSync(
      join(job, 'remotion-input.json'),
      JSON.stringify({
        projectDir: project,
        compositionId: 'Promo',
        browserExecutable: process.execPath,
      }),
    );
    const activeJobs = new ActiveJobs();
    const controller = new AbortController();
    const running = runRemotion({
      specPath: join(job, 'remotion-input.json'),
      cwd: root,
      settings: {},
      activeJobs,
      trusted: true,
      ffmpegPath: resolveFfmpeg().path,
      verifyMedia: false,
      signal: controller.signal,
    });
    let settled = false;
    const observed = running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      if (process.platform !== 'win32')
        await vi.waitFor(() => expect(existsSync(browserReady)).toBe(true));
      const childPid = Number(readFileSync(marker, 'utf8'));
      controller.abort();
      expect(settled).toBe(false);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(() => activeJobs.acquire(realpathSync(job))).toThrow(/already running/);
      await expect(running).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => {
        expect(() => process.kill(childPid, 0)).toThrow();
      });
      if (process.platform !== 'win32') {
        expect(existsSync(helperMarker)).toBe(true);
        const helperPid = Number(readFileSync(helperMarker, 'utf8'));
        expect(() => process.kill(helperPid, 0)).toThrow();
      }
      activeJobs.acquire(realpathSync(job))();
    } finally {
      process.env.PATH = originalPath;
      controller.abort();
      await observed;
      if (existsSync(marker)) {
        try {
          process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL');
        } catch {}
      }
      if (existsSync(helperMarker)) {
        try {
          process.kill(Number(readFileSync(helperMarker, 'utf8')), 'SIGKILL');
        } catch {}
      }
    }
  });

  it('preserves public assets, injects shot URLs and verifies completed output', async () => {
    const project = join(root, 'project');
    const job = join(root, '.video-gen', 'job-r');
    for (const dir of [
      join(project, 'src'),
      join(project, 'public', 'fonts'),
      join(project, 'node_modules', '@remotion', 'bundler'),
      join(project, 'node_modules', '@remotion', 'renderer'),
      join(project, 'node_modules', 'remotion'),
      join(project, 'node_modules', 'react'),
      join(project, 'node_modules', 'react-dom'),
      job,
    ])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    for (const name of [
      'remotion',
      '@remotion/bundler',
      '@remotion/renderer',
      'react',
      'react-dom',
    ])
      writeFileSync(
        join(project, 'node_modules', name, 'package.json'),
        JSON.stringify({ version: '1.0.0' }),
      );
    writeFileSync(join(project, 'src', 'index.ts'), 'root');
    writeFileSync(join(project, 'public', 'logo.png'), 'logo');
    writeFileSync(join(project, 'public', 'fonts', 'brand.woff'), 'font');
    writeFileSync(
      join(project, 'node_modules', '@remotion', 'bundler', 'index.js'),
      'exports.bundle = async ({publicDir}) => publicDir;',
    );
    writeFileSync(
      join(project, 'node_modules', '@remotion', 'renderer', 'index.js'),
      `
      const fs = require('node:fs'); const path = require('node:path');
      exports.selectComposition = async ({serveUrl, id, inputProps}) => {
        if (id !== 'Promo' || !fs.existsSync(path.join(serveUrl, 'logo.png')) || !fs.existsSync(path.join(serveUrl, 'fonts/brand.woff')) || !fs.existsSync(path.join(serveUrl, inputProps.videoGenAssets.demo))) throw Error('missing asset');
        return {id, props: {videoGenShotTimesSec: {demo: 0.5}}, fps: 25, durationInFrames: 50};
      };
      exports.renderStill = async ({output}) => fs.writeFileSync(output, 'frame');
      exports.renderMedia = async ({outputLocation}) => fs.writeFileSync(outputLocation, 'video');
    `,
    );
    const clip = join(root, 'demo.mp4');
    writeFileSync(clip, 'clip');
    const spec = {
      projectDir: project,
      compositionId: 'Promo',
      assets: { demo: clip },
      browserExecutable: process.execPath,
    };
    writeFileSync(join(job, 'remotion-input.json'), JSON.stringify(spec));
    const ffmpegPath = resolveFfmpeg().path;
    const projectHash = await preflightRemotion({
      spec,
      cwd: root,
      jobDir: job,
      assets: spec.assets,
      shotIds: ['demo'],
      ffmpegPath,
    });
    await expect(
      preflightRemotion({
        spec,
        cwd: root,
        jobDir: job,
        assets: spec.assets,
        shotIds: ['missing'],
        ffmpegPath,
      }),
    ).rejects.toThrow(/videoGenShotTimesSec/);
    const opts = {
      specPath: join(job, 'remotion-input.json'),
      cwd: root,
      settings: {},
      activeJobs: new ActiveJobs(),
      trusted: true,
      frozenProjectHash: projectHash,
      ffmpegPath,
      verifyMedia: false,
      shotIds: ['demo'],
    };
    const first = await runRemotion(opts);
    const second = await runRemotion(opts);
    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    expect(first.shotTimesSec).toEqual({ demo: 0.5 });
    expect(second.shotTimesSec).toEqual({ demo: 0.5 });
    const manifestPath = join(job, 'remotion-manifest.json');
    const validManifest = readFileSync(manifestPath, 'utf8');
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...JSON.parse(validManifest), shotTimesSec: { demo: -1 } }),
    );
    await expect(runRemotion(opts)).rejects.toThrow(/shot timing/);
    writeFileSync(manifestPath, validManifest);
    expect(readFileSync(first.finalVideoPath, 'utf8')).toBe('video');
    const secondJob = join(root, '.video-gen', 'job-with-assets');
    const ownedFiles = join(secondJob, 'public-snapshot');
    mkdirSync(ownedFiles, { recursive: true });
    const inJobClip = join(ownedFiles, 'demo.mp4');
    writeFileSync(inJobClip, 'in-job-clip');
    writeFileSync(
      join(secondJob, 'remotion-input.json'),
      JSON.stringify({ ...spec, assets: { demo: inJobClip } }),
    );
    await runRemotion({ ...opts, specPath: join(secondJob, 'remotion-input.json') });
    expect(readFileSync(inJobClip, 'utf8')).toBe('in-job-clip');
    const nestedJob = join(project, 'renders', 'job-nested');
    mkdirSync(nestedJob, { recursive: true });
    writeFileSync(join(nestedJob, 'remotion-input.json'), JSON.stringify(spec));
    const nested = await runRemotion({
      ...opts,
      specPath: join(nestedJob, 'remotion-input.json'),
      settings: { outputDir: join(project, 'renders') },
    });
    expect(readFileSync(nested.finalVideoPath, 'utf8')).toBe('video');
    const siblingJob = join(project, 'renders', 'job-sibling');
    mkdirSync(siblingJob);
    writeFileSync(join(siblingJob, 'render-input.json'), '{"shots":[]}');
    const afterSibling = await runRemotion({
      ...opts,
      specPath: join(nestedJob, 'remotion-input.json'),
      settings: { outputDir: join(project, 'renders') },
      preflight: true,
      frozenProjectHash: nested.projectHash,
    });
    expect(afterSibling.projectHash).toBe(nested.projectHash);
    const failedJob = join(root, '.video-gen', 'job-failed');
    mkdirSync(failedJob);
    writeFileSync(
      join(failedJob, 'remotion-input.json'),
      JSON.stringify({ ...spec, compositionId: 'Missing' }),
    );
    await expect(
      runRemotion({
        ...opts,
        specPath: join(failedJob, 'remotion-input.json'),
        frozenProjectHash: undefined,
      }),
    ).rejects.toThrow(/composition/);
    expect(readdirSync(failedJob).some((name) => name.startsWith('public-snapshot-'))).toBe(false);
    writeFileSync(first.finalVideoPath, 'tampered');
    await expect(runRemotion(opts)).rejects.toThrow(/changed|missing/);
    await expect(
      preflightRemotion({
        spec: { ...spec, compositionId: 'Missing' },
        cwd: root,
        jobDir: job,
        assets: spec.assets,
        ffmpegPath,
      }),
    ).rejects.toThrow(/composition/);
    mkdirSync(join(project, 'public', '__pi_video_gen__'));
    await expect(
      preflightRemotion({ spec, cwd: root, jobDir: job, assets: spec.assets, ffmpegPath }),
    ).rejects.toThrow(/reserved/);
  });

  it('freezes an explicit entry point under out', async () => {
    const project = join(root, 'project');
    const job = join(root, '.video-gen', 'job-out');
    for (const dir of [
      join(project, 'out'),
      ...['remotion', '@remotion/bundler', '@remotion/renderer', 'react', 'react-dom'].map((name) =>
        join(project, 'node_modules', name),
      ),
      job,
    ])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    for (const name of [
      'remotion',
      '@remotion/bundler',
      '@remotion/renderer',
      'react',
      'react-dom',
    ])
      writeFileSync(join(project, 'node_modules', name, 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(join(project, 'out', 'index.ts'), 'original');
    writeFileSync(
      join(job, 'remotion-input.json'),
      JSON.stringify({
        projectDir: project,
        entryPoint: 'out/index.ts',
        compositionId: 'Promo',
        browserExecutable: process.execPath,
      }),
    );
    const opts = {
      specPath: join(job, 'remotion-input.json'),
      cwd: root,
      settings: {},
      activeJobs: new ActiveJobs(),
      trusted: true,
      ffmpegPath: resolveFfmpeg().path,
      preflight: true,
    };
    const first = await runRemotion(opts);
    writeFileSync(join(project, 'out', 'index.ts'), 'changed');
    await expect(runRemotion({ ...opts, frozenProjectHash: first.projectHash })).rejects.toThrow(
      /changed since preflight/,
    );
    const hiddenEntry = join(project, '.video-gen', 'entry.ts');
    mkdirSync(join(project, '.video-gen'));
    writeFileSync(hiddenEntry, 'original');
    const customOutput = join(root, 'custom-output');
    const customJob = join(customOutput, 'job-hidden-entry');
    mkdirSync(customJob, { recursive: true });
    writeFileSync(
      join(customJob, 'remotion-input.json'),
      JSON.stringify({
        projectDir: project,
        entryPoint: '.video-gen/entry.ts',
        compositionId: 'Promo',
        browserExecutable: process.execPath,
      }),
    );
    const customOpts = {
      ...opts,
      specPath: join(customJob, 'remotion-input.json'),
      settings: { outputDir: customOutput },
    };
    const hidden = await runRemotion(customOpts);
    writeFileSync(hiddenEntry, 'changed');
    await expect(
      runRemotion({ ...customOpts, frozenProjectHash: hidden.projectHash }),
    ).rejects.toThrow(/changed since preflight/);
    const outputInProject = join(project, 'renders');
    const outputEntry = join(outputInProject, 'index.ts');
    const outputJob = join(outputInProject, 'job-entry');
    mkdirSync(outputJob, { recursive: true });
    writeFileSync(outputEntry, 'source');
    writeFileSync(
      join(outputJob, 'remotion-input.json'),
      JSON.stringify({
        projectDir: project,
        entryPoint: 'renders/index.ts',
        compositionId: 'Promo',
        browserExecutable: process.execPath,
      }),
    );
    const outputOpts = {
      ...opts,
      specPath: join(outputJob, 'remotion-input.json'),
      settings: { outputDir: outputInProject },
      preflight: true,
      frozenProjectHash: undefined,
    };
    await expect(runRemotion(outputOpts)).rejects.toThrow(/entryPoint cannot be inside/);
  });
});
