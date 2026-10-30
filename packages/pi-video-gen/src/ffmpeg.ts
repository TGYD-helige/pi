import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { safeBasename, VideoGenError } from './errors.js';
import { probeCommand } from './probe.js';
import { CancelledError } from './providers/task.js';

/**
 * Lazily resolve an ffmpeg binary without crashing when node_modules is
 * absent (extension path loading does not install dependencies).
 * Priority: platform-specific optional npm package →
 * ffmpeg-static npm package (devDependency, dev machines only).
 */
const localRequire = createRequire(import.meta.url);

const platformBin = (() => {
  try {
    return localRequire.resolve(
      `@amaster.ai/pi-video-gen-ffmpeg-${process.platform}-${process.arch}/ffmpeg`,
    );
  } catch {
    return null;
  }
})();

const ffmpegStatic = (() => {
  try {
    return localRequire('ffmpeg-static') as string | null;
  } catch {
    return null; // devDependency not installed — PATH fallback remains
  }
})();

/**
 * ffmpeg resolution and video assembly.
 *
 * Resolution order: `pi-video-gen.ffmpegPath` (sensitive — global / agent-dir
 * settings only) → `FFMPEG_PATH` env → platform-specific optional npm package
 * → `ffmpeg-static` in node_modules (dev fallback) → `ffmpeg` on PATH. The
 * doctor reports which source resolved.
 */

export type FfmpegSource = 'settings' | 'env' | 'bundled' | 'path';

export type FfmpegResolution = {
  path: string;
  source: FfmpegSource;
  runnable: boolean;
};

/**
 * Resolve ffprobe as the SIBLING of the resolved ffmpeg (same directory),
 * falling back to `ffprobe` on PATH. Platform packages ship both binaries.
 */
/**
 * Resolve the GPL ffmpeg variant (with libx264) as the sibling of the
 * resolved ffmpeg named `ffmpeg-gpl`. Required for h264 output — the LGPL
 * build intentionally has no x264 encoder.
 */
export async function resolveGplFfmpeg(
  settingsPath?: string | undefined,
  signal?: AbortSignal,
): Promise<FfmpegResolution> {
  const ff = await resolveFfmpeg(settingsPath, signal);
  const exe = process.platform === 'win32' ? 'ffmpeg-gpl.exe' : 'ffmpeg-gpl';
  if (ff.source !== 'path') {
    const sibling = join(dirname(ff.path), exe);
    if (await hasEncoder(sibling, 'libx264', signal))
      return { path: sibling, source: ff.source, runnable: true };
  }
  return {
    path: ff.path,
    source: ff.source,
    runnable: ff.runnable && (await hasEncoder(ff.path, 'libx264', signal)),
  };
}

export async function resolveFfprobe(
  settingsPath?: string | undefined,
  signal?: AbortSignal,
): Promise<FfmpegResolution> {
  const ff = await resolveFfmpeg(settingsPath, signal);
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  if (ff.source !== 'path') {
    const sibling = join(dirname(ff.path), exe);
    if (await isRunnable(sibling, signal))
      return { path: sibling, source: ff.source, runnable: true };
    if (ff.source === 'settings' || ff.source === 'env') {
      return { path: sibling, source: ff.source, runnable: false };
    }
    // Bundled sibling missing/broken — keep looking on PATH rather than dying.
  }
  return { path: exe, source: 'path', runnable: await isRunnable(exe, signal) };
}

export async function resolveFfmpeg(
  settingsPath?: string | undefined,
  signal?: AbortSignal,
): Promise<FfmpegResolution> {
  if (settingsPath)
    return {
      path: settingsPath,
      source: 'settings',
      runnable: await isRunnable(settingsPath, signal),
    };
  if (process.env.FFMPEG_PATH) {
    return {
      path: process.env.FFMPEG_PATH,
      source: 'env',
      runnable: await isRunnable(process.env.FFMPEG_PATH, signal),
    };
  }
  if (platformBin && (await isRunnable(platformBin, signal)))
    return { path: platformBin, source: 'bundled', runnable: true };
  if (ffmpegStatic && (await isRunnable(ffmpegStatic, signal)))
    return { path: ffmpegStatic, source: 'bundled', runnable: true };
  return { path: 'ffmpeg', source: 'path', runnable: await isRunnable('ffmpeg', signal) };
}

async function isRunnable(path: string, signal?: AbortSignal): Promise<boolean> {
  return (await probeCommand(path, ['-version'], signal)) !== undefined;
}

async function hasEncoder(path: string, encoder: string, signal?: AbortSignal): Promise<boolean> {
  const output = await probeCommand(path, ['-hide_banner', '-encoders'], signal);
  return output !== undefined && new RegExp(`\\b${encoder}\\b`).test(output);
}

export type StreamInfo = {
  videoCodec: string;
  width: number;
  height: number;
  fps: string;
  timebase: string;
  pixFmt: string;
  audioLayout: string;
  /** Extra incompatibility vectors beyond the first video track. */
  streamCount: number;
  audioSampleRate: string;
  audioTimebase: string;
  subtitleCodec: string;
  streamSignatures: string[];
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  time_base?: string;
  pix_fmt?: string;
  channel_layout?: string;
  channels?: number;
  sample_rate?: string;
};

function streamSignature(stream: FfprobeStream): string {
  if (stream.codec_type === 'video') {
    return `video:${stream.codec_name ?? 'unknown'}/${stream.width ?? '?'}x${stream.height ?? '?'}/${stream.r_frame_rate ?? 'unknown'}/${stream.time_base ?? 'unknown'}/${stream.pix_fmt ?? 'unknown'}`;
  }
  if (stream.codec_type === 'audio') {
    return `audio:${stream.codec_name ?? 'unknown'}/${stream.channel_layout ?? stream.channels ?? '?'}/${stream.sample_rate ?? 'unknown'}/${stream.time_base ?? 'unknown'}`;
  }
  return `${stream.codec_type ?? 'unknown'}:${stream.codec_name ?? 'unknown'}/${stream.time_base ?? 'unknown'}`;
}

function runFfprobe(
  ffprobePath: string,
  args: string[],
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'], signal });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => {
      reject(
        signal?.aborted
          ? new CancelledError()
          : new VideoGenError(
              'ffprobe is not runnable. Run /video-gen doctor.',
              'probe: spawn failed',
            ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(output);
      } else {
        reject(
          new VideoGenError(
            `ffprobe failed (exit ${code}) reading ${safeBasename(filePath)}.`,
            `probe: exit ${code}`,
          ),
        );
      }
    });
  });
}

/** Probe a media file's stream signature for strict-copy compatibility checks. */
export async function probeStreams(
  ffprobePath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<StreamInfo> {
  const args = ['-v', 'error', '-show_streams', '-of', 'json', filePath];
  const output = await runFfprobe(ffprobePath, args, filePath, signal);

  let streams: FfprobeStream[];
  try {
    streams = (JSON.parse(output) as { streams?: FfprobeStream[] }).streams ?? [];
  } catch {
    throw new VideoGenError(
      `ffprobe returned unparseable output for ${safeBasename(filePath)} — is it a media file?`,
      'probe: bad output',
    );
  }
  const video = streams.find((st) => st.codec_type === 'video');
  if (!video?.codec_name || !video.width || !video.height) {
    throw new VideoGenError(
      `No video stream found in ${safeBasename(filePath)} — compose needs mp4 clips with a video track.`,
      'probe: no video stream',
    );
  }
  const audio = streams.find((st) => st.codec_type === 'audio');
  const subtitle = streams.find((st) => st.codec_type === 'subtitle');
  return {
    videoCodec: video.codec_name,
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate ?? 'unknown',
    timebase: video.time_base ?? 'unknown',
    pixFmt: video.pix_fmt ?? 'unknown',
    audioLayout: audio
      ? `${audio.codec_name ?? 'unknown'}/${audio.channel_layout ?? audio.channels ?? '?'}`
      : 'none',
    streamCount: streams.length,
    audioSampleRate: audio?.sample_rate ?? 'none',
    audioTimebase: audio?.time_base ?? 'none',
    subtitleCodec: subtitle?.codec_name ?? 'none',
    streamSignatures: streams.map(streamSignature),
  };
}

/** ffprobe the container duration of a media file, in seconds. */
export async function probeDuration(
  ffprobePath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<number> {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=0',
    filePath,
  ];
  const output = await runFfprobe(ffprobePath, args, filePath, signal);
  const match = output.match(/duration=([0-9.]+)/);
  if (!match) {
    throw new VideoGenError(
      `ffprobe returned no duration for ${safeBasename(filePath)}.`,
      'probe: no duration',
    );
  }
  return Number(match[1]);
}

/** Probe the first video stream's duration (container audio may be longer). */
export async function probeVideoDuration(
  ffprobePath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<number> {
  const output = await runFfprobe(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=duration:stream_tags=duration',
      '-of',
      'json',
      filePath,
    ],
    filePath,
    signal,
  );
  let duration = Number.NaN;
  try {
    const stream = (
      JSON.parse(output) as {
        streams?: Array<{ duration?: string; tags?: { DURATION?: string } }>;
      }
    ).streams?.[0];
    duration = Number(stream?.duration);
    if ((!Number.isFinite(duration) || duration <= 0) && stream?.tags?.DURATION) {
      const [hours, minutes, seconds] = stream.tags.DURATION.split(':').map(Number);
      duration = hours! * 3600 + minutes! * 60 + seconds!;
    }
  } catch {
    // Report the same bounded media error below.
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoGenError(
      `Could not determine the video stream duration of ${safeBasename(filePath)}.`,
      'probe: bad video duration',
    );
  }
  return duration;
}

/** Public ffmpeg runner used by the timeline pipeline (arbitrary arg lists). */
export function runFfmpegCommand(
  ffmpegPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: 'ignore', signal });
    child.on('error', () => {
      if (signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      reject(
        new VideoGenError('ffmpeg is not runnable. Run /video-gen doctor.', 'ffmpeg: spawn failed'),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new VideoGenError(
            `ffmpeg failed (exit ${code}) while processing local media. Run /video-gen doctor and retry.`,
            `ffmpeg: exit ${code}`,
          ),
        );
      }
    });
  });
}

/**
 * Concatenate shot clips into the final video. Tries the lossless concat
 * demuxer (`-c copy`) first — same-codec clips join in seconds without
 * re-encoding; falls back to an mpeg4 re-encode when codecs/params differ
 * (mpeg4 is LGPL-clean — libx264 would REQUIRE a GPL build of ffmpeg).
 */
export async function concatVideos(opts: {
  inputs: string[];
  outputPath: string;
  ffmpegPath: string;
  signal?: AbortSignal | undefined;
  /** C0 compose: copy ONLY — report failure instead of re-encoding. */
  strictCopy?: boolean | undefined;
}): Promise<void> {
  if (opts.inputs.length === 0) {
    throw new VideoGenError('No clips to concatenate.', 'concat: empty inputs');
  }
  const dir = dirname(opts.outputPath);
  const workDir = await mkdtemp(join(dir, '.concat-'));
  const listPath = join(workDir, 'list.txt');
  const tmpOut = join(workDir, 'output.mp4');

  try {
    // ffconcat single-quote escaping: an embedded ' would break the demuxer
    // ("O'Brien/project") — close-quote, escaped quote, reopen.
    await writeFile(
      listPath,
      opts.inputs.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n'),
      {
        encoding: 'utf-8',
        flag: 'wx',
      },
    );
    try {
      await runFfmpegCommand(
        opts.ffmpegPath,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', tmpOut],
        opts.signal,
      );
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (opts.strictCopy) {
        throw new VideoGenError(
          'Lossless concat failed even though streams probed as compatible. The clips may have container-level issues (timestamps, edit lists) that concat copy cannot handle. compose will not transcode — re-encode the clips first.',
          'concat: strict copy failed',
        );
      }
      await runFfmpegCommand(
        opts.ffmpegPath,
        [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c:v',
          'mpeg4',
          '-q:v',
          '5',
          '-pix_fmt',
          'yuv420p',
          tmpOut,
        ],
        opts.signal,
      );
    }
    await rename(tmpOut, opts.outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
