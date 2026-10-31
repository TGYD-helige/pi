import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeDuration, probeStreams, resolveFfprobe } from '../ffmpeg.js';
import { ActiveJobs, hashFileSha256, loadTimelineJob } from '../jobs/store.js';
import { CancelledError } from '../providers/task.js';
import { renderBurnedSubtitle, renderTextOverlay } from '../text-layer.js';
import { runTimeline } from '../timeline-render.js';
import type { TtsProvider } from '../tts/edge-tts.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-timeline');
const require = createRequire(import.meta.url);
const ffmpegStaticBin = require('ffmpeg-static') as string;

async function makeImage(
  dir: string,
  name: string,
  color: { r: number; g: number; b: number },
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  await sharp({ create: { width: 640, height: 360, channels: 3, background: color } })
    .png()
    .toFile(p);
  return p;
}

async function makeMotionMarker(dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  await sharp({ create: { width: 640, height: 360, channels: 3, background: '#000000' } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="640" height="360"><circle cx="160" cy="90" r="22" fill="white"/></svg>',
        ),
      },
    ])
    .png()
    .toFile(p);
  return p;
}

function markerMaxAcceleration(videoPath: string): number {
  const decoded = spawnSync(
    ffmpegStaticBin,
    ['-i', videoPath, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  expect(decoded.status).toBe(0);
  const width = 640;
  const height = 360;
  const frameSize = width * height;
  const centers: number[] = [];
  for (let offset = 0; offset + frameSize <= decoded.stdout.length; offset += frameSize) {
    let weightedX = 0;
    let weight = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = Math.max(0, decoded.stdout[offset + y * width + x]! - 96);
        weightedX += value * x;
        weight += value;
      }
    }
    centers.push(weightedX / weight);
  }
  const velocity = centers.slice(1).map((center, i) => center - centers[i]!);
  return Math.max(...velocity.slice(1).map((value, i) => Math.abs(value - velocity[i]!)));
}

function makeVideo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  execFileSync(
    ffmpegStaticBin,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=25:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:r=25:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=3',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'mpeg4',
      '-q:v',
      '4',
      '-c:a',
      'aac',
      p,
    ],
    { stdio: 'ignore' },
  );
  return p;
}

function makeVideoWithLongerAudio(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  execFileSync(
    ffmpegStaticBin,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=25:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=3',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      p,
    ],
    { stdio: 'ignore' },
  );
  return p;
}

function makeAudio(dir: string, name: string, frequency: number): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  execFileSync(
    ffmpegStaticBin,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:sample_rate=48000:duration=3`,
      '-c:a',
      'libmp3lame',
      p,
    ],
    { stdio: 'ignore' },
  );
  return p;
}

/** Fake TTS: writes a real (sine) mp3 via ffmpeg-static and returns its duration. */
const fakeTts: TtsProvider = {
  name: 'fake',
  async synthesize({ outPath }) {
    execFileSync(
      ffmpegStaticBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '2',
        '-c:a',
        'libmp3lame',
        outPath,
      ],
      {
        stdio: 'ignore',
      },
    );
    return { audioPath: outPath };
  },
};

function baseOpts(cwd: string) {
  return { cwd, settings: {}, activeJobs: new ActiveJobs(), tts: fakeTts };
}

function parseSrtTimestamp(value: string): number {
  const [hours, minutes, seconds, milliseconds] = value.split(/[:,]/).map(Number);
  return hours! * 3600 + minutes! * 60 + seconds! + milliseconds! / 1000;
}

function toneAmplitude(videoPath: string, frequency: number): number {
  const decoded = spawnSync(
    ffmpegStaticBin,
    ['-i', videoPath, '-map', '0:a:0', '-t', '1', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  expect(decoded.status).toBe(0);
  const pcm = decoded.stdout;
  const samples = Math.floor(pcm.length / 4);
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readFloatLE(i * 4);
    const angle = (2 * Math.PI * frequency * i) / 48_000;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  return (2 * Math.hypot(real, imaginary)) / samples;
}

describe('timeline pipeline (C1–C4)', () => {
  let cwd: string;

  it('requires explicit Edge TTS opt-in before sending narration text', async () => {
    const image = await makeImage(cwd, 'tts-opt-in.png', { r: 1, g: 2, b: 3 });
    const jobDir = join(cwd, '.video-gen', 'tts-opt-in');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        segments: [{ id: 's1', image, durationSec: 1, narration: 'private narration' }],
      }),
    );
    const { tts: _tts, ...withoutInjectedTts } = baseOpts(cwd);
    await expect(
      runTimeline({ timelineSpecPath: specPath, ...withoutInjectedTts }),
    ).rejects.toThrow(/explicit Edge TTS opt-in/i);
  });

  beforeEach(() => {
    cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects timeline media outside the project directory', async () => {
    const outside = `${cwd}-outside`;
    try {
      const image = await makeImage(outside, 'private.png', { r: 1, g: 2, b: 3 });
      const jobDir = join(cwd, '.video-gen', 'outside-media');
      mkdirSync(jobDir, { recursive: true });
      const specPath = join(jobDir, 'timeline-input.json');
      writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

      await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
        /inside the approved project directory/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects timeline media through a parent symlink', async () => {
    const outside = `${cwd}-outside`;
    try {
      await makeImage(outside, 'private.png', { r: 1, g: 2, b: 3 });
      const link = join(cwd, 'linked-media');
      symlinkSync(outside, link, 'dir');
      const jobDir = join(cwd, '.video-gen', 'linked-media');
      mkdirSync(jobDir, { recursive: true });
      const specPath = join(jobDir, 'timeline-input.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          segments: [{ id: 's1', image: join(link, 'private.png'), durationSec: 1 }],
        }),
      );

      await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
        /inside the approved project directory/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('renders a text overlay PNG via sharp', async () => {
    const out = join(cwd, 'ovr.png');
    const result = await renderTextOverlay({
      overlay: { title: 'Title test', subtitle: 'subtitle here', position: 'bottom-left' },
      width: 640,
      height: 360,
      outPath: out,
    });
    expect(result).toBe(out);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
    // not a blank image — the plate + text produce non-uniform pixels
    const stats = await sharp(out).stats();
    expect(stats.channels[0]!.max).toBeGreaterThan(0);
  });

  it('reports titles that cannot fit the safe frame after wrapping', async () => {
    await expect(
      renderTextOverlay({
        overlay: { title: 'UNBREAKABLE'.repeat(30), position: 'center' },
        width: 640,
        height: 360,
        outPath: join(cwd, 'too-long.png'),
      }),
    ).rejects.toThrow(/safe frame|safe.*width/i);
  });

  it('keeps title and subtitle on separate text rows', async () => {
    const out = join(cwd, 'separate-lines.png');
    await renderTextOverlay({
      overlay: { title: 'TITLE', subtitle: 'subtitle', position: 'top-left' },
      width: 640,
      height: 360,
      outPath: out,
    });

    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const brightRows: number[] = [];
    for (let y = 0; y < info.height; y += 1) {
      let hasText = false;
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset]! > 180 && data[offset + 3]! > 0) {
          hasText = true;
          break;
        }
      }
      if (hasText) brightRows.push(y);
    }
    const gaps = brightRows
      .slice(1)
      .map((row, index) => row - brightRows[index]!)
      .filter((gap) => gap > 1);
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('wraps long burned subtitles inside the video safe area', async () => {
    const out = join(cwd, 'wrapped-subtitle.png');
    await renderBurnedSubtitle({
      text: 'This long subtitle must wrap across several readable lines instead of being clipped by either side of the video frame.',
      style: {
        fontSize: 32,
        textColor: '#ff0000',
        backgroundColor: '#0000ff',
        backgroundOpacity: 1,
      },
      width: 640,
      height: 360,
      outPath: out,
    });

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    let minTextX = info.width;
    let maxTextX = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset]! > 180 && data[offset + 1]! < 100 && data[offset + 2]! < 100) {
          minTextX = Math.min(minTextX, x);
          maxTextX = Math.max(maxTextX, x);
        }
      }
    }
    expect(minTextX).toBeGreaterThan(20);
    expect(maxTextX).toBeLessThan(620);
  });

  it('keeps wide Latin glyphs inside the burned-subtitle safe area', async () => {
    const out = join(cwd, 'wide-subtitle.png');
    await renderBurnedSubtitle({
      text: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
      style: {
        fontSize: 32,
        textColor: '#ff0000',
        backgroundColor: '#0000ff',
        backgroundOpacity: 1,
      },
      width: 640,
      height: 360,
      outPath: out,
    });

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    let minTextX = info.width;
    let maxTextX = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset]! > 180 && data[offset + 1]! < 100 && data[offset + 2]! < 100) {
          minTextX = Math.min(minTextX, x);
          maxTextX = Math.max(maxTextX, x);
        }
      }
    }
    expect(minTextX).toBeGreaterThan(20);
    expect(maxTextX).toBeLessThan(620);
  });

  it('records a cancelled manifest when local rendering is aborted', async () => {
    const image = await makeImage(cwd, 'cancel.png', { r: 20, g: 30, b: 40 });
    const jobDir = join(cwd, '.video-gen', 'cancel-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, motion: 'static' }],
      }),
    );
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Rendering segment')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'cancelled' });
  });

  it('uses voice and BGM from the immutable timeline spec', async () => {
    const image = await makeImage(cwd, 'override.png', { r: 50, g: 60, b: 70 });
    const specBgm = join(cwd, 'spec-bgm.mp3');
    writeFileSync(specBgm, 'spec bgm bytes');
    const jobDir = join(cwd, '.video-gen', 'override-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        voice: 'edge-tts:spec-voice',
        bgm: specBgm,
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, narration: 'hello' }],
      }),
    );
    let usedVoice = '';
    const capturingTts: TtsProvider = {
      name: 'capturing',
      async synthesize(options) {
        usedVoice = options.voice;
        return fakeTts.synthesize(options);
      },
    };
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      tts: capturingTts,
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Rendering segment')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(usedVoice).toBe('spec-voice');
    expect(readFileSync(join(jobDir, 'assets', 'bgm.mp3'), 'utf-8')).toBe('spec bgm bytes');
  });

  it('can explicitly degrade a TTS failure to silent audio with subtitles', async () => {
    const image = await makeImage(cwd, 'tts-fallback.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'tts-fallback-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, narration: '旁白服务暂时不可用' }],
      }),
    );
    const failingTts: TtsProvider = {
      name: 'failing',
      async synthesize() {
        throw new Error('remote TTS unavailable');
      },
    };

    const result = await runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      tts: failingTts,
    });

    expect(loadTimelineJob(jobDir)).toMatchObject({
      state: 'done',
      segments: { s1: { narrationDegraded: true } },
    });
    expect(readFileSync(result.subtitlePath!, 'utf-8')).toContain('旁白服务暂时不可用');
    const streams = await probeStreams((await resolveFfprobe()).path, result.finalVideoPath);
    expect(streams.audioLayout).not.toBe('none');
    expect(streams.subtitleCodec).toBe('mov_text');
  });

  it('keeps an explicitly degraded segment silent on identical resume', async () => {
    const image = await makeImage(cwd, 'tts-resume.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'tts-resume-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, narration: '保持静音降级' }],
      }),
    );
    const failingTts: TtsProvider = {
      name: 'failing',
      async synthesize() {
        throw new Error('remote TTS unavailable');
      },
    };
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: failingTts });
    const audioBefore = readFileSync(join(jobDir, 'audio_track.mp4'));

    let retried = 0;
    const recoveredTts: TtsProvider = {
      ...fakeTts,
      async synthesize(opts) {
        retried += 1;
        return fakeTts.synthesize(opts);
      },
    };
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: recoveredTts });

    expect(retried).toBe(0);
    expect(loadTimelineJob(jobDir)).toMatchObject({
      state: 'done',
      segments: { s1: { narrationDegraded: true } },
    });
    expect(readFileSync(join(jobDir, 'audio_track.mp4'))).toEqual(audioBefore);
  });

  it('does not misclassify an invalid encoded narration as a TTS degradation', async () => {
    const image = await makeImage(cwd, 'bad-audio.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'bad-audio-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        segments: [{ id: 's1', image, durationSec: 1, narration: '损坏音频' }],
      }),
    );
    const corruptTts: TtsProvider = {
      name: 'corrupt',
      async synthesize({ outPath }) {
        writeFileSync(outPath, 'not an mp3');
        return { audioPath: outPath };
      },
    };

    await expect(
      runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: corruptTts }),
    ).rejects.toThrow(/ffprobe failed/);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'failed' });

    let retries = 0;
    const recoveredTts: TtsProvider = {
      ...fakeTts,
      async synthesize(opts) {
        retries += 1;
        return fakeTts.synthesize(opts);
      },
    };
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: recoveredTts });
    expect(retries).toBe(1);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'done' });
  });

  it('does not misclassify narration artifact validation failures as TTS degradation', async () => {
    const image = await makeImage(cwd, 'linked-audio.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'linked-audio-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        segments: [{ id: 's1', image, durationSec: 1, narration: '路径校验失败' }],
      }),
    );
    const outside = join(cwd, 'outside.mp3');
    await fakeTts.synthesize({ text: 'outside', voice: 'fake', outPath: outside });
    const linkedTts: TtsProvider = {
      name: 'linked',
      async synthesize({ outPath }) {
        symlinkSync(outside, outPath);
        return { audioPath: outPath };
      },
    };

    await expect(
      runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: linkedTts }),
    ).rejects.toThrow(/cached artifact.*symlink/i);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'failed' });
  });

  it('renders a 3-segment promo with narration, xfade, subtitles, and QC', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 200, g: 40, b: 40 });
    const imgB = await makeImage(cwd, 'b.png', { r: 40, g: 120, b: 200 });
    const imgC = await makeImage(cwd, 'c.png', { r: 40, g: 180, b: 80 });
    const jobDir = join(cwd, '.video-gen', 'promo-1');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'timeline-input.json'),
      JSON.stringify({
        title: 'test promo',
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 's1',
            image: imgA,
            durationSec: 1.5,
            motion: 'kenburns-in',
            narration: '第一段旁白内容',
            transitionTo: { type: 'xfade', style: 'fade', durationSec: 0.5 },
          },
          {
            id: 's2',
            image: imgB,
            durationSec: 'auto',
            narration: '第二段旁白内容',
            overlay: { title: 'Title', subtitle: 'Subtitle' },
          },
          { id: 's3', image: imgC, durationSec: 1.5, motion: 'static' },
        ],
      }),
    );

    const result = await runTimeline({
      timelineSpecPath: join(jobDir, 'timeline-input.json'),
      ...baseOpts(cwd),
    });

    expect(result.segments).toBe(3);
    expect(existsSync(result.finalVideoPath)).toBe(true);
    expect(result.subtitlePath && existsSync(result.subtitlePath)).toBe(true);
    expect(readFileSync(result.subtitlePath!, 'utf-8')).toContain('第一段旁白内容');
    expect(result.qcFrames).toHaveLength(8);
    expect(result.qcFrames.some((path) => path.includes('qc_segment_'))).toBe(true);
    expect(result.qcFrames.some((path) => path.includes('qc_transition_'))).toBe(true);
    for (const f of result.qcFrames) expect(existsSync(f)).toBe(true);

    // artifacts cached: overlays, audio, segments
    expect(existsSync(join(jobDir, 'overlays', 'text-s2.png'))).toBe(true);
    expect(existsSync(join(jobDir, 'audio', 's1.mp3'))).toBe(true);
    expect(existsSync(join(jobDir, 'segments', 's1.mp4'))).toBe(true);

    // Narrated s1 grows to 2s audio + 0.6s pad + 0.5s outgoing xfade;
    // subtracting the overlap leaves the full narration and pad on screen.
    const ffprobe = await resolveFfprobe();
    const dur = await probeDuration(ffprobe.path, result.finalVideoPath);
    expect(dur).toBeGreaterThan(6.5);
    expect(dur).toBeLessThan(7);

    const manifest = loadTimelineJob(jobDir)!;
    expect(manifest.state).toBe('done');

    // mov_text subtitle track present in the final video
    const streams = await probeStreams(ffprobe.path, result.finalVideoPath);
    expect(streams.audioLayout).not.toBe('none');
    expect(streams.subtitleCodec).toBe('mov_text');
  }, 15_000);

  it('renders slow Ken Burns motion without stop-and-jump acceleration', async () => {
    const image = await makeMotionMarker(cwd, 'marker.png');
    const jobDir = join(cwd, '.video-gen', 'smooth-motion');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25, codec: 'mpeg4' },
        segments: [{ id: 'marker', image, durationSec: 3, motion: 'kenburns-in' }],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    expect(markerMaxAcceleration(result.finalVideoPath)).toBeLessThan(0.5);
  });

  it('uses real sentence boundaries for soft subtitles', async () => {
    const image = await makeImage(cwd, 'sentences.png', { r: 40, g: 40, b: 40 });
    const jobDir = join(cwd, '.video-gen', 'sentences');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 3, narration: 'Hello. World.' }],
      }),
    );
    const timedTts: TtsProvider = {
      name: 'timed',
      async synthesize(opts) {
        await fakeTts.synthesize(opts);
        return {
          audioPath: opts.outPath,
          sentenceTimings: [
            { text: 'Hello.', startSec: 0.1, endSec: 0.8 },
            { text: 'World.', startSec: 1.1, endSec: 1.8 },
          ],
        };
      },
    };
    const result = await runTimeline({
      ...baseOpts(cwd),
      timelineSpecPath: specPath,
      tts: timedTts,
    });
    const srt = readFileSync(result.subtitlePath!, 'utf8');
    expect(srt).toContain('00:00:00,100 --> 00:00:00,800');
    expect(srt).toContain('00:00:01,100 --> 00:00:01,800');
    expect(srt.match(/-->/g) ?? []).toHaveLength(2);
  });

  it('renders one burned caption per real sentence boundary', async () => {
    const image = await makeImage(cwd, 'burn-sentences.png', { r: 255, g: 255, b: 255 });
    const jobDir = join(cwd, '.video-gen', 'burn-sentences');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        subtitles: { mode: 'burn' },
        segments: [{ id: 's1', image, durationSec: 3, narration: 'One. Two.' }],
      }),
    );
    const timedTts: TtsProvider = {
      name: 'timed',
      async synthesize(opts) {
        await fakeTts.synthesize(opts);
        return {
          audioPath: opts.outPath,
          sentenceTimings: [
            { text: 'One.', startSec: 0, endSec: 0.8 },
            { text: 'Two.', startSec: 1, endSec: 1.8 },
          ],
        };
      },
    };
    const result = await runTimeline({
      ...baseOpts(cwd),
      timelineSpecPath: specPath,
      tts: timedTts,
    });
    expect(existsSync(result.finalVideoPath)).toBe(true);
    expect(existsSync(join(jobDir, 'overlays', 'subtitle-s1-0.png'))).toBe(true);
    expect(existsSync(join(jobDir, 'overlays', 'subtitle-s1-1.png'))).toBe(true);
  });

  it('mixes a trimmed video segment and its source audio into the timeline', async () => {
    const image = await makeImage(cwd, 'intro.png', { r: 20, g: 30, b: 40 });
    const video = makeVideo(cwd, 'demo.mp4');
    const jobDir = join(cwd, '.video-gen', 'mixed-media');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 'intro',
            image,
            durationSec: 1.5,
            transitionTo: { type: 'xfade', style: 'fade', durationSec: 0.5 },
          },
          {
            id: 'demo',
            video,
            trimStartSec: 1.1,
            durationSec: 1.2,
            fit: 'cover',
            sourceAudio: { volume: 0.5 },
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(result.durationSec).toBeCloseTo(2.2, 1);

    const frame = join(cwd, 'video-frame.png');
    execFileSync(
      ffmpegStaticBin,
      ['-y', '-ss', '1.7', '-i', result.finalVideoPath, '-frames:v', '1', frame],
      { stdio: 'ignore' },
    );
    const stats = await sharp(frame).stats();
    expect(stats.channels[2]!.mean).toBeGreaterThan(stats.channels[0]!.mean * 2);

    const volume = spawnSync(
      ffmpegStaticBin,
      ['-i', result.finalVideoPath, '-af', 'volumedetect', '-f', 'null', '-'],
      { encoding: 'utf-8' },
    );
    expect(volume.status).toBe(0);
    const meanDb = Number(volume.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
    expect(meanDb).toBeGreaterThan(-40);
  }, 15_000);

  it('keeps a segment named bgm separate from a same-extension BGM snapshot', async () => {
    const video = makeVideo(cwd, 'visual.mp4');
    const bgm = makeAudio(cwd, 'music.mp4', 220);
    const jobDir = join(cwd, '.video-gen', 'bgm-segment');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        bgm,
        segments: [{ id: 'bgm', video, durationSec: 1, sourceAudio: { muted: true } }],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(result.durationSec).toBeCloseTo(1, 1);
  }, 15_000);

  it('preserves source-audio gain when padding the segment with silence', async () => {
    const video = makeVideo(cwd, 'source-volume.mp4');
    const jobDir = join(cwd, '.video-gen', 'source-volume');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 'demo',
            video,
            durationSec: 1,
            sourceAudio: { volume: 1 },
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(toneAmplitude(result.finalVideoPath, 880)).toBeGreaterThan(0.09);
  }, 15_000);

  it('keeps source-audio gain stable when narration is mixed in', async () => {
    const video = makeVideo(cwd, 'source-with-narration.mp4');
    const jobDir = join(cwd, '.video-gen', 'source-with-narration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 'demo',
            video,
            durationSec: 3,
            sourceAudio: { volume: 1 },
            narration: 'Narration over source audio',
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(toneAmplitude(result.finalVideoPath, 880)).toBeGreaterThan(0.09);
  }, 15_000);

  it('keeps source-audio gain stable when BGM is mixed in', async () => {
    const video = makeVideo(cwd, 'source-with-bgm.mp4');
    const bgm = makeAudio(cwd, 'source-bgm.mp3', 220);
    const jobDir = join(cwd, '.video-gen', 'source-with-bgm');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        bgm,
        segments: [
          {
            id: 'demo',
            video,
            durationSec: 1,
            sourceAudio: { volume: 1 },
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(toneAmplitude(result.finalVideoPath, 880)).toBeGreaterThan(0.09);
  }, 15_000);

  it('rejects a video trim window beyond the source duration', async () => {
    const video = makeVideo(cwd, 'short.mp4');
    const jobDir = join(cwd, '.video-gen', 'trim-overflow');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 'demo',
            video,
            trimStartSec: 2.5,
            durationSec: 1,
          },
        ],
      }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /beyond the 3\.00s source video/,
    );
  });

  it('validates trims against the video stream instead of longer container audio', async () => {
    const video = makeVideoWithLongerAudio(cwd, 'long-audio.mp4');
    const jobDir = join(cwd, '.video-gen', 'video-stream-duration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 'demo', video, durationSec: 2 }],
      }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /beyond the 1\.00s source video/,
    );
  });

  it('rejects narration that does not fit a fixed-duration video segment', async () => {
    const video = makeVideo(cwd, 'fixed-window.mp4');
    const jobDir = join(cwd, '.video-gen', 'fixed-video-window');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 'demo',
            video,
            durationSec: 1,
            narration: 'Narration longer than the selected video window',
          },
        ],
      }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /narration .*does not fit.*1\.00s video duration/i,
    );
  });

  it('keeps the requested video duration when shorter narration fits', async () => {
    const video = makeVideo(cwd, 'short-narration.mp4');
    const jobDir = join(cwd, '.video-gen', 'short-video-narration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 'demo', video, durationSec: 1, narration: 'Short narration' }],
      }),
    );
    const shortTts: TtsProvider = {
      name: 'short',
      async synthesize({ outPath }) {
        execFileSync(
          ffmpegStaticBin,
          [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000',
            '-t',
            '0.5',
            '-c:a',
            'libmp3lame',
            outPath,
          ],
          { stdio: 'ignore' },
        );
        return { audioPath: outPath };
      },
    };

    const result = await runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      tts: shortTts,
    });
    expect(result.durationSec).toBeCloseTo(1, 1);
  }, 15_000);

  it('mixes source audio and narration in the final timeline audio', async () => {
    const video = makeVideo(cwd, 'narrated-demo.mp4');
    const bgm = makeAudio(cwd, 'bgm.mp3', 220);
    const jobDir = join(cwd, '.video-gen', 'narrated-video');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        bgm,
        segments: [
          {
            id: 'demo',
            video,
            durationSec: 3,
            sourceAudio: { volume: 0.5 },
            narration: 'Narration over source audio',
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(toneAmplitude(result.finalVideoPath, 220)).toBeGreaterThan(0.002);
    expect(toneAmplitude(result.finalVideoPath, 440)).toBeGreaterThan(0.01);
    expect(toneAmplitude(result.finalVideoPath, 880)).toBeGreaterThan(0.005);
  }, 15_000);

  it('burns styled narration subtitles into the video when requested', async () => {
    const image = await makeImage(cwd, 'white.png', { r: 255, g: 255, b: 255 });
    const jobDir = join(cwd, '.video-gen', 'burned-subtitles');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        subtitles: {
          mode: 'burn',
          fontSize: 30,
          textColor: '#ff0000',
          backgroundColor: '#0000ff',
          backgroundOpacity: 1,
        },
        segments: [
          {
            id: 'caption',
            image,
            durationSec: 3,
            overlay: { title: 'BRAND', position: 'top-left' },
            narration: 'Burned subtitle',
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const streams = await probeStreams((await resolveFfprobe()).path, result.finalVideoPath);
    expect(streams.subtitleCodec).toBe('none');

    const frame = join(cwd, 'burned-frame.png');
    execFileSync(
      ffmpegStaticBin,
      ['-y', '-ss', '1', '-i', result.finalVideoPath, '-frames:v', '1', frame],
      { stdio: 'ignore' },
    );
    const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
    let hasRedText = false;
    let hasBluePlate = false;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset]!;
      const green = data[offset + 1]!;
      const blue = data[offset + 2]!;
      hasRedText ||= red > 180 && green < 100 && blue < 100;
      hasBluePlate ||= blue > 180 && red < 100 && green < 100;
    }
    expect(hasRedText).toBe(true);
    expect(hasBluePlate).toBe(true);
  }, 15_000);

  it('stops showing a burned subtitle when its narration cue ends', async () => {
    const image = await makeImage(cwd, 'cue-white.png', { r: 255, g: 255, b: 255 });
    const jobDir = join(cwd, '.video-gen', 'burned-subtitle-cue');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        subtitles: {
          mode: 'burn',
          fontSize: 30,
          textColor: '#ff0000',
          backgroundColor: '#0000ff',
          backgroundOpacity: 1,
        },
        segments: [{ id: 'caption', image, durationSec: 3, narration: 'Short cue' }],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const frame = join(cwd, 'after-burned-cue.png');
    execFileSync(
      ffmpegStaticBin,
      ['-y', '-ss', '2.7', '-i', result.finalVideoPath, '-frames:v', '1', frame],
      { stdio: 'ignore' },
    );
    const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
    let hasBluePlate = false;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset]!;
      const green = data[offset + 1]!;
      const blue = data[offset + 2]!;
      hasBluePlate ||= blue > 180 && red < 100 && green < 100;
    }
    expect(hasBluePlate).toBe(false);
  }, 15_000);

  it('keeps burned subtitles separate from another segment overlay with a colliding id', async () => {
    const image = await makeImage(cwd, 'collision-white.png', { r: 255, g: 255, b: 255 });
    const jobDir = join(cwd, '.video-gen', 'overlay-name-collision');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        subtitles: {
          mode: 'burn',
          fontSize: 30,
          textColor: '#ff0000',
          backgroundColor: '#0000ff',
          backgroundOpacity: 1,
        },
        segments: [
          { id: 'caption', image, durationSec: 3, narration: 'Burned subtitle' },
          {
            id: 'caption_subtitle',
            image,
            durationSec: 1,
            overlay: { title: 'SECOND', position: 'top-left' },
          },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const frame = join(cwd, 'second-overlay-frame.png');
    execFileSync(
      ffmpegStaticBin,
      ['-y', '-ss', '3.5', '-i', result.finalVideoPath, '-frames:v', '1', frame],
      { stdio: 'ignore' },
    );
    const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
    let hasBluePlate = false;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset]!;
      const green = data[offset + 1]!;
      const blue = data[offset + 2]!;
      hasBluePlate ||= blue > 180 && red < 100 && green < 100;
    }
    expect(hasBluePlate).toBe(false);
  }, 15_000);

  it('keeps narration and subtitles aligned across a long xfade', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 200, g: 40, b: 40 });
    const imgB = await makeImage(cwd, 'b.png', { r: 40, g: 120, b: 200 });
    const jobDir = join(cwd, '.video-gen', 'long-xfade');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [
          {
            id: 's1',
            image: imgA,
            durationSec: 'auto',
            narration: '第一段旁白',
            transitionTo: { type: 'xfade', style: 'fade', durationSec: 1 },
          },
          { id: 's2', image: imgB, durationSec: 'auto', narration: '第二段旁白' },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const ffprobe = await resolveFfprobe();
    const videoDuration = await probeDuration(ffprobe.path, join(jobDir, 'video_track.mp4'));
    const audioDuration = await probeDuration(ffprobe.path, join(jobDir, 'audio_track.mp4'));

    expect(Math.abs(audioDuration - videoDuration)).toBeLessThan(0.1);
    const manifest = loadTimelineJob(jobDir)!;
    const cues = [
      ...readFileSync(result.subtitlePath!, 'utf-8').matchAll(
        /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g,
      ),
    ].map((match) => ({
      start: parseSrtTimestamp(match[1]!),
      end: parseSrtTimestamp(match[2]!),
    }));
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe(0);
    expect(cues[0]!.end).toBeCloseTo(manifest.segments.s1!.narrationDurationSec!, 2);
    expect(cues[1]!.start - cues[0]!.end).toBeCloseTo(0.6, 2);
    expect(cues[1]!.end - cues[1]!.start).toBeCloseTo(
      manifest.segments.s2!.narrationDurationSec!,
      2,
    );
  });

  it('resolves auto duration from the encoded narration', async () => {
    const img = await makeImage(cwd, 'a.png', { r: 80, g: 120, b: 180 });
    const jobDir = join(cwd, '.video-gen', 'audio-duration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 'auto', narration: '旁白' }],
      }),
    );
    const result = await runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
    });

    expect(result.durationSec).toBeGreaterThan(2.5);
    expect(loadTimelineJob(jobDir)!.segments.s1!.narrationDurationSec).toBeGreaterThan(1.9);
  });

  it('resumes from cached artifacts on identical rerun', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 50, g: 50, b: 200 });
    const imgB = await makeImage(cwd, 'b.png', { r: 200, g: 50, b: 50 });
    const jobDir = join(cwd, '.video-gen', 'promo-2');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          { id: 's1', image: imgA, durationSec: 1, narration: '旁白一' },
          { id: 's2', image: imgB, durationSec: 1 },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const segMtime = readFileSync(join(jobDir, 'segments', 's1.mp4')).byteLength;
    const frozenImageInode = statSync(join(jobDir, 'assets', 'segment-s1.png')).ino;

    const again = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(existsSync(again.finalVideoPath)).toBe(true);
    expect(again.subtitlePath && existsSync(again.subtitlePath)).toBe(true);
    expect(readFileSync(join(jobDir, 'segments', 's1.mp4')).byteLength).toBe(segMtime);
    expect(statSync(join(jobDir, 'assets', 'segment-s1.png')).ino).toBe(frozenImageInode);

    writeFileSync(join(jobDir, 'assets', 'segment-s1.png'), 'tampered frozen image');
    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /Frozen media snapshot/,
    );
  });

  it('refuses to delete a pre-existing assets directory for a fresh job', async () => {
    const image = await makeImage(cwd, 'source.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'existing-assets');
    const assetsDir = join(jobDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    const keep = join(assetsDir, 'keep.txt');
    writeFileSync(keep, 'user data');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /assets.*already exists/i,
    );
    expect(readFileSync(keep, 'utf-8')).toBe('user data');
    expect(loadTimelineJob(jobDir)).toBeUndefined();

    rmSync(assetsDir, { recursive: true });
    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(existsSync(result.finalVideoPath)).toBe(true);
  });

  it('refuses to delete pre-existing derived outputs for a fresh job', async () => {
    const image = await makeImage(cwd, 'source.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'existing-outputs');
    const overlaysDir = join(jobDir, 'overlays');
    mkdirSync(overlaysDir, { recursive: true });
    const keep = join(overlaysDir, 'keep.png');
    writeFileSync(keep, 'user data');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /overlays.*already exists/i,
    );
    expect(readFileSync(keep, 'utf-8')).toBe('user data');
  });

  it('refuses to replace a pre-existing final video for a fresh job', async () => {
    const image = await makeImage(cwd, 'source.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'existing-final');
    mkdirSync(jobDir, { recursive: true });
    const finalVideoPath = join(jobDir, 'final_video.mp4');
    writeFileSync(finalVideoPath, 'user data');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final_video\.mp4.*already exists/i,
    );
    expect(readFileSync(finalVideoPath, 'utf-8')).toBe('user data');
  });

  it('refuses to rebuild a missing artifact that already has a committed hash', async () => {
    const image = await makeImage(cwd, 'missing-narration.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'missing-narration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 'auto', narration: '不可重建的旁白' }],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    rmSync(join(jobDir, 'audio', 's1.mp3'));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /cached artifact.*missing/i,
    );
  });

  it('refuses a completed manifest with a missing upstream artifact hash', async () => {
    const image = await makeImage(cwd, 'sparse-done.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'sparse-done');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [
          {
            id: 's1',
            image,
            durationSec: 1,
            overlay: { title: 'Committed title' },
          },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    delete manifest.artifactHashes['overlays/text-s1.png'];
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed manifest.*missing.*artifact hash/i,
    );
    expect(loadTimelineJob(jobDir)?.state).toBe('done');
  });

  it('validates cached audio inputs even when the mixed track is reusable', async () => {
    const image = await makeImage(cwd, 'sparse-audio.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'sparse-audio');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1 }],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    delete manifest.artifactHashes['audio/s1_silence.mp4'];
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed manifest.*missing.*artifact hash/i,
    );
  });

  it('invalidates committed downstream artifacts before rebuilding an uncommitted upstream', async () => {
    const image = await makeImage(cwd, 'sparse-failed.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'sparse-failed');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [
          {
            id: 's1',
            image,
            durationSec: 1,
            overlay: { title: 'Rebuilt title' },
          },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    manifest.state = 'failed';
    delete manifest.artifactHashes['overlays/text-s1.png'];
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Rendering segment')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(loadTimelineJob(jobDir)?.artifactHashes['segments/s1.mp4']).toBeUndefined();
  });

  it('invalidates QC artifacts before rebuilding an uncommitted final video', async () => {
    const image = await makeImage(cwd, 'stale-qc.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'stale-qc');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1 }],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    manifest.state = 'failed';
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Muxing final video')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    const hashes = loadTimelineJob(jobDir)!.artifactHashes;
    expect(Object.keys(hashes).filter((key) => key.startsWith('qc/'))).toEqual([]);
  });

  it('refuses a cached segment replaced by a symlink', async () => {
    const image = await makeImage(cwd, 'segment-link.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'segment-link');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    const segmentPath = join(jobDir, 'segments', 's1.mp4');
    const outside = join(cwd, 'outside-segment.mp4');
    copyFileSync(segmentPath, outside);
    rmSync(segmentPath);
    symlinkSync(outside, segmentPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /cached artifact.*symlink/i,
    );
  });

  it('refuses a cached segment whose bytes changed', async () => {
    const image = await makeImage(cwd, 'segment-changed.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'segment-changed');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    writeFileSync(join(jobDir, 'segments', 's1.mp4'), 'tampered segment');

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /cached artifact.*changed/i,
    );
  });

  it('refuses resume when the spec changed (revision ⇒ new job)', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 10, g: 10, b: 10 });
    const imgB = await makeImage(cwd, 'b.png', { r: 240, g: 240, b: 240 });
    const jobDir = join(cwd, '.video-gen', 'promo-3');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        segments: [
          { id: 's1', image: imgA, durationSec: 1 },
          { id: 's2', image: imgB, durationSec: 1 },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    writeFileSync(
      specPath,
      JSON.stringify({
        segments: [
          { id: 's1', image: imgA, durationSec: 2 },
          { id: 's2', image: imgB, durationSec: 1 },
        ],
      }),
    );
    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /NEW job directory/,
    );
    expect(readdirSync(jobDir).filter((name) => name.startsWith('.assets-staging-'))).toEqual([]);
  });

  it('refuses a pre-placed QC output symlink', async () => {
    const img = await makeImage(cwd, 'a.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'qc-symlink');
    const qcDir = join(jobDir, 'qc');
    mkdirSync(qcDir, { recursive: true });
    const outside = join(cwd, 'outside.png');
    writeFileSync(outside, 'do not overwrite');
    symlinkSync(outside, join(qcDir, 'qc_first.png'));
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /qc.*already exists/i,
    );

    expect(readFileSync(outside, 'utf-8')).toBe('do not overwrite');
    expect(lstatSync(join(qcDir, 'qc_first.png')).isSymbolicLink()).toBe(true);
  });

  it('refuses a fully pre-placed QC cache made of symlinks', async () => {
    const img = await makeImage(cwd, 'a.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'qc-cache-symlinks');
    const qcDir = join(jobDir, 'qc');
    mkdirSync(qcDir, { recursive: true });
    for (const name of ['qc_first.png', 'qc_mid.png', 'qc_last.png']) {
      symlinkSync(img, join(qcDir, name));
    }
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /qc.*already exists/i,
    );
  });

  it('refuses a completed final video replaced by a symlink', async () => {
    const img = await makeImage(cwd, 'final-symlink.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-symlink');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const outside = join(cwd, 'outside-final.mp4');
    copyFileSync(first.finalVideoPath, outside);
    rmSync(first.finalVideoPath);
    symlinkSync(outside, first.finalVideoPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video.*invalid|changed|symlink/i,
    );
  });

  it('rejects a completed manifest whose final video path is not job-local', async () => {
    const img = await makeImage(cwd, 'final-path.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-path');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...manifest, finalVideoPath: join(cwd, 'outside.mp4') }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video path/i,
    );
  });

  it('refuses a completed job whose final video is missing', async () => {
    const img = await makeImage(cwd, 'final-missing.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-missing');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 1 }],
      }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    rmSync(first.finalVideoPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed final video.*missing/i,
    );
    expect(loadTimelineJob(jobDir)?.state).toBe('done');
    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed final video.*missing/i,
    );
    expect(loadTimelineJob(jobDir)?.state).toBe('done');
  });

  it('refuses a completed final video whose bytes changed', async () => {
    const img = await makeImage(cwd, 'final-changed.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-changed');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const replacement = join(cwd, 'replacement.mp4');
    execFileSync(
      ffmpegStaticBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=blue:size=1920x1080',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-t',
        '1',
        '-c:v',
        'mpeg4',
        '-c:a',
        'aac',
        replacement,
      ],
      { stdio: 'ignore' },
    );
    copyFileSync(replacement, first.finalVideoPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video.*changed/i,
    );
  });

  it('fails QC when the final video has no audio stream', async () => {
    const img = await makeImage(cwd, 'no-audio.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'no-audio');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    execFileSync(
      ffmpegStaticBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=blue:size=1920x1080',
        '-t',
        '1',
        '-c:v',
        'mpeg4',
        first.finalVideoPath,
      ],
      { stdio: 'ignore' },
    );
    const manifest = loadTimelineJob(jobDir)!;
    manifest.finalVideoHash = await hashFileSha256(first.finalVideoPath);
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /missing.*audio/i,
    );
  });

  it('fails QC when the cached SRT no longer matches the resolved timeline', async () => {
    const img = await makeImage(cwd, 'bad-srt.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'bad-srt');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 'auto', narration: '旁白时间轴' }],
      }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const subtitlePath = first.subtitlePath!;
    writeFileSync(subtitlePath, '1\n00:00:00,500 --> 00:00:01,000\n旁白时间轴\n');
    const manifest = loadTimelineJob(jobDir)!;
    manifest.artifactHashes['subtitles.srt'] = await hashFileSha256(subtitlePath);
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /SRT timeline/i,
    );
  });

  it('extracts QC frames for the minimum valid 0.5-second timeline', async () => {
    const img = await makeImage(cwd, 'short.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'short');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 0.5 }],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    expect(result.qcFrames).toHaveLength(4);
    for (const frame of result.qcFrames) expect(existsSync(frame)).toBe(true);
  });

  it('validates bad specs before any rendering', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 1, g: 2, b: 3 });
    const jobDir = join(cwd, '.video-gen', 'promo-bad');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'timeline-input.json'),
      JSON.stringify({ segments: [{ id: 's1', image: imgA, durationSec: 1, motion: 'fly' }] }),
    );
    await expect(
      runTimeline({ timelineSpecPath: join(jobDir, 'timeline-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/motion must be one of/);
  });
});
