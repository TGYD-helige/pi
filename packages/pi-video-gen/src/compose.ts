import { COPYFILE_EXCL } from 'node:constants';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { resolveOutputDir } from './config.js';
import { safeBasename, VideoGenError } from './errors.js';
import {
  concatVideos,
  probeStreams,
  resolveFfmpeg,
  resolveFfprobe,
  type StreamInfo,
} from './ffmpeg.js';
import {
  type ActiveJobs,
  assertSafeId,
  hashFileSha256,
  loadComposeJob,
  pathIsMissing,
  readJsonFile,
  saveComposeJob,
} from './jobs/store.js';
import type { VideoGenSettings } from './types.js';

/**
 * C0 compose pipeline (`video_compose`): lossless concat of EXISTING local
 * clips. No paid models, no re-encode, no filters — strict-copy only.
 *
 * Contract (design doc §4.1):
 * - input is `<jobDir>/compose-input.json`; the parent directory IS the job
 *   and must live under the video-gen output dir;
 * - the spec is immutable per job: fingerprint covers spec content + every
 *   clip's SHA-256 — drift means "start a new job directory";
 * - stream compatibility (codec/resolution/fps/timebase/pix_fmt/audio
 *   layout) is verified via ffprobe BEFORE concat; incompatibility reports
 *   exact per-clip differences — never a silent transcode, never a paid
 *   fallback;
 * - foreground execution, ctx.signal cancellation, exclusive temp files,
 *   atomic rename.
 */

export type ClipComposeClip = {
  id: string;
  path: string;
};

export type ClipComposeSpec = {
  clips: ClipComposeClip[];
  output?: { mode?: string | undefined } | undefined;
};

export type ComposeRunResult = {
  jobId: string;
  finalVideoPath: string;
  clipCount: number;
  resumed: boolean;
};

function sha256hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function specFingerprint(specRaw: string, clipHashes: Record<string, string>): string {
  return sha256hex(JSON.stringify({ spec: specRaw, clipHashes }));
}

/** Manual validation with agent-fixable error messages. */
function parseComposeSpec(raw: string): ClipComposeSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoGenError('compose-input.json is not valid JSON.', 'compose: spec not json');
  }
  const spec = parsed as ClipComposeSpec;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.clips)) {
    throw new VideoGenError(
      'compose-input.json must contain a "clips" array.',
      'compose: no clips',
    );
  }
  if (spec.clips.length < 2) {
    throw new VideoGenError(
      'compose needs at least 2 clips to concatenate. For a single clip, no compose is needed.',
      'compose: too few clips',
    );
  }
  if (
    spec.output !== undefined &&
    (!spec.output || typeof spec.output !== 'object' || Array.isArray(spec.output))
  ) {
    throw new VideoGenError('output must be an object.', 'compose: bad output');
  }
  if (spec.output?.mode !== undefined && spec.output.mode !== 'copy') {
    throw new VideoGenError(
      `output.mode must be "copy" (C0 only supports lossless concat; got "${spec.output.mode}").`,
      'compose: bad mode',
    );
  }
  const seen = new Set<string>();
  spec.clips.forEach((clip, i) => {
    const where = `clips[${i}]${clip?.id ? ` ("${clip.id}")` : ''}`;
    if (!clip || typeof clip !== 'object') {
      throw new VideoGenError(`${where} is not an object.`, 'compose: bad clip');
    }
    if (typeof clip.id !== 'string') {
      throw new VideoGenError(
        `${where}.id must be a string (JSON number/bool ids are not allowed).`,
        'compose: id type',
      );
    }
    assertSafeId(clip.id, 'clip');
    if (seen.has(clip.id)) {
      throw new VideoGenError(
        `Duplicate clip id "${clip.id}" — ids must be unique.`,
        'compose: dup clip id',
      );
    }
    seen.add(clip.id);
    if (typeof clip.path !== 'string' || clip.path.trim() === '') {
      throw new VideoGenError(
        `${where}.path is required (absolute path to an existing mp4).`,
        'compose: no path',
      );
    }
  });
  return spec;
}

/** Compare stream info across clips and report exact differences. */
function diffStreams(probes: { clip: ClipComposeClip; streams: StreamInfo }[]): string[] {
  const diffs: string[] = [];
  const [first, ...rest] = probes;
  const base = first!.streams;
  for (const p of rest) {
    const s = p.streams;
    const mismatches: string[] = [];
    if (s.videoCodec !== base.videoCodec)
      mismatches.push(`codec ${base.videoCodec} vs ${s.videoCodec}`);
    if (s.width !== base.width || s.height !== base.height)
      mismatches.push(`resolution ${base.width}x${base.height} vs ${s.width}x${s.height}`);
    if (s.fps !== base.fps) mismatches.push(`fps ${base.fps} vs ${s.fps}`);
    if (s.timebase !== base.timebase) mismatches.push(`timebase ${base.timebase} vs ${s.timebase}`);
    if (s.pixFmt !== base.pixFmt) mismatches.push(`pix_fmt ${base.pixFmt} vs ${s.pixFmt}`);
    if (s.audioLayout !== base.audioLayout)
      mismatches.push(`audio ${base.audioLayout} vs ${s.audioLayout}`);
    if (s.audioSampleRate !== base.audioSampleRate)
      mismatches.push(`audio sample rate ${base.audioSampleRate} vs ${s.audioSampleRate}`);
    if (s.audioTimebase !== base.audioTimebase)
      mismatches.push(`audio timebase ${base.audioTimebase} vs ${s.audioTimebase}`);
    if (s.streamCount !== base.streamCount)
      mismatches.push(`stream count ${base.streamCount} vs ${s.streamCount}`);
    const maxStreams = Math.max(base.streamSignatures.length, s.streamSignatures.length);
    for (let i = 0; i < maxStreams; i++) {
      if (s.streamSignatures[i] !== base.streamSignatures[i]) {
        mismatches.push(
          `stream ${i} ${base.streamSignatures[i] ?? 'missing'} vs ${s.streamSignatures[i] ?? 'missing'}`,
        );
      }
    }
    if (mismatches.length > 0) {
      diffs.push(`  ${first!.clip.id} ↔ ${p.clip.id}: ${mismatches.join('; ')}`);
    }
  }
  return diffs;
}

export async function runCompose(opts: {
  composeSpecPath: string;
  cwd: string;
  settings: VideoGenSettings;
  activeJobs: ActiveJobs;
  signal?: AbortSignal | undefined;
  onUpdate?: ((msg: string) => void) | undefined;
}): Promise<ComposeRunResult> {
  const outputDir = resolveOutputDir(opts.settings, opts.cwd);

  // 1. job identity FIRST (realpath resolves any symlinks), spec read SECOND.
  const absSpecPath = resolve(opts.cwd, opts.composeSpecPath);
  const realSpecPath = await realpath(absSpecPath).catch(() => {
    throw new VideoGenError(
      'Compose spec not readable. Expected <jobDir>/compose-input.json under the video-gen output directory (.video-gen).',
      'compose: spec unreadable',
    );
  });
  const realOutput = await realpath(outputDir).catch(() => resolve(outputDir));
  const jobDir = dirname(realSpecPath);
  const realJobDir = jobDir;

  const specRaw = await readFile(realSpecPath).catch(() => {
    throw new VideoGenError(
      'Compose spec not readable. Expected <jobDir>/compose-input.json under the video-gen output directory (.video-gen).',
      'compose: spec unreadable',
    );
  });
  const spec = parseComposeSpec(specRaw.toString('utf-8'));
  if (realJobDir !== realOutput && !realJobDir.startsWith(`${realOutput}${sep}`)) {
    throw new VideoGenError(
      'The compose job directory must live under the video-gen output directory (.video-gen). Move your spec there.',
      'compose: job outside outputDir',
    );
  }
  const jobId = basename(jobDir);
  const finalVideoPath = join(jobDir, 'final_video.mp4');
  assertSafeId(jobId, 'job');
  if (basename(realSpecPath) !== 'compose-input.json') {
    throw new VideoGenError(
      'The compose spec file must be named compose-input.json inside the job directory.',
      'compose: spec name',
    );
  }

  const release = opts.activeJobs.acquire(realJobDir);
  try {
    // 2. foreign-manifest guard FIRST: a directory holding a render/single
    // manifest is NOT a fresh compose job — refuse before touching clips/.
    {
      const foreign = readJsonFile<{ kind?: string }>(join(jobDir, 'manifest.json'));
      if (foreign && foreign.kind !== 'compose') {
        throw new VideoGenError(
          `This directory already holds a "${foreign.kind ?? 'unknown'}" job manifest. Choose a different job directory for compose — refusing to overwrite another job's state.`,
          'compose: foreign manifest',
        );
      }
    }

    const existing = loadComposeJob(jobDir);
    if (!existing) {
      const finalStat = await lstat(finalVideoPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (finalStat) {
        throw new VideoGenError(
          'final_video.mp4 already exists in this fresh compose job. Move it aside or choose a new job directory; refusing to replace existing files.',
          'compose: final already exists',
        );
      }
    }

    // 2. Stage and hash inputs before publishing them. A drifted rerun never
    // touches the old job's immutable clips; matching reruns verify the frozen
    // bytes rather than silently repairing them.
    opts.onUpdate?.('Snapshotting input clips into the job…');
    const clipHashes: Record<string, string> = {};
    const clipSnapshots: Record<string, string> = {};
    const clipsDir = join(jobDir, 'clips');
    const stagingDir = await mkdtemp(join(jobDir, '.clips-staging-'));
    let fingerprint = '';
    try {
      for (const clip of spec.clips) {
        const absClip = resolve(opts.cwd, clip.path);
        const st = await lstat(absClip).catch(() => null);
        if (!st?.isFile()) {
          throw new VideoGenError(
            `Clip "${clip.id}" is not a readable regular file: ${safeBasename(clip.path)}.`,
            'compose: clip unreadable',
          );
        }
        const stagedPath = join(stagingDir, `${clip.id}.mp4`);
        try {
          await copyFile(absClip, stagedPath, COPYFILE_EXCL);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === 'ENOENT' &&
            (await pathIsMissing(absClip))
          ) {
            throw new VideoGenError(
              `Clip "${clip.id}" is not readable: ${safeBasename(clip.path)}.`,
              'compose: clip unreadable',
            );
          }
          throw error;
        }
        clipHashes[clip.id] = await hashFileSha256(stagedPath, opts.signal);
      }

      fingerprint = specFingerprint(specRaw.toString('utf-8'), clipHashes);
      if (existing && existing.fingerprint !== fingerprint) {
        throw new VideoGenError(
          'compose-input.json or one of the clips changed since this job was created. Revisions require a NEW job directory (rerunning the same path only resumes identical input).',
          'compose: input drift',
        );
      }

      const clipsStat = await lstat(clipsDir).catch(() => null);
      if (clipsStat && (!clipsStat.isDirectory() || clipsStat.isSymbolicLink())) {
        throw new VideoGenError(
          'clips/ is not a regular directory (symlink?). Remove it and retry.',
          'compose: dir invalid',
        );
      }
      if (clipsStat) {
        const realClips = await realpath(clipsDir);
        if (!realClips.startsWith(`${realJobDir}${sep}`)) {
          throw new VideoGenError(
            'clips/ resolves outside the job directory (symlink?). Remove it and retry.',
            'compose: dir escapes',
          );
        }
      }

      if (existing) {
        for (const clip of spec.clips) {
          const frozenPath = join(clipsDir, `${clip.id}.mp4`);
          const frozenStat = await lstat(frozenPath).catch(() => null);
          const expectedHash = existing.clipHashes[clip.id];
          if (
            !frozenStat?.isFile() ||
            !expectedHash ||
            (await hashFileSha256(frozenPath, opts.signal)) !== expectedHash
          ) {
            throw new VideoGenError(
              `Frozen clip snapshot "${clip.id}" changed or is missing. Start a NEW job directory.`,
              'compose: frozen snapshot invalid',
            );
          }
          clipSnapshots[clip.id] = frozenPath;
        }
      } else {
        if (clipsStat) {
          throw new VideoGenError(
            'clips/ already exists in this fresh compose job. Move it aside or choose a new job directory; refusing to delete existing files.',
            'compose: clips already exist',
          );
        }
        await rename(stagingDir, clipsDir);
        for (const clip of spec.clips) {
          clipSnapshots[clip.id] = join(clipsDir, `${clip.id}.mp4`);
        }
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }

    if (existing) {
      if (existing.state === 'done') {
        const finalStat = await lstat(finalVideoPath).catch(() => null);
        if (
          existing.finalVideoPath !== finalVideoPath ||
          !finalStat?.isFile() ||
          finalStat.isSymbolicLink()
        ) {
          throw new VideoGenError(
            'The completed manifest final video path is invalid. Restore final_video.mp4 inside the job directory or start a NEW job.',
            'compose: invalid final path',
          );
        }
        if ((await hashFileSha256(finalVideoPath, opts.signal)) !== existing.finalVideoHash) {
          throw new VideoGenError(
            'The cached final video changed since this compose job completed.',
            'compose: final artifact changed',
          );
        }
        return {
          jobId,
          finalVideoPath,
          clipCount: spec.clips.length,
          resumed: true,
        };
      }
      opts.onUpdate?.(`Resuming compose job ${jobId} (fingerprint verified).`);
    }

    saveComposeJob(jobDir, {
      jobId,
      kind: 'compose',
      state: 'concatenating',
      fingerprint,
      clipHashes,
      updatedAt: new Date().toISOString(),
    });

    // 3. stream compatibility precheck via ffprobe
    const ffmpeg = await resolveFfmpeg(opts.settings.ffmpegPath, opts.signal);
    if (!ffmpeg.runnable) {
      throw new VideoGenError(
        `ffmpeg is not runnable (source tried: ${ffmpeg.source}). Install ffmpeg (brew/apt) or set pi-video-gen.ffmpegPath in GLOBAL settings.`,
        'compose: ffmpeg missing',
      );
    }
    const ffprobe = await resolveFfprobe(opts.settings.ffmpegPath, opts.signal);
    if (!ffprobe.runnable) {
      throw new VideoGenError(
        `ffprobe is not runnable (source tried: ${ffprobe.source}) — required for stream compatibility prechecks.`,
        'compose: ffprobe missing',
      );
    }
    opts.onUpdate?.(`Probing ${spec.clips.length} clips for stream compatibility…`);
    const probes: { clip: ClipComposeClip; streams: StreamInfo }[] = [];
    for (const clip of spec.clips) {
      probes.push({
        clip,
        streams: await probeStreams(ffprobe.path, clipSnapshots[clip.id]!, opts.signal),
      });
    }
    const diffs = diffStreams(probes);
    if (diffs.length > 0) {
      saveComposeJob(jobDir, {
        jobId,
        kind: 'compose',
        state: 'failed',
        fingerprint,
        clipHashes,
        error: `stream mismatch: ${diffs.length} pair(s)`,
        updatedAt: new Date().toISOString(),
      });
      throw new VideoGenError(
        `Clips are NOT stream-compatible for lossless concat:\n${diffs.join('\n')}\nResolve by re-encoding the mismatched clips to match, or ask the user how to proceed — compose will not silently transcode.`,
        'compose: stream mismatch',
      );
    }

    // 4. strict-copy concat (no fallback, no re-encode)
    const inputs = spec.clips.map((c) => clipSnapshots[c.id]!);
    opts.onUpdate?.(`Concatenating ${inputs.length} clips (strict copy)…`);
    try {
      await concatVideos({
        inputs,
        outputPath: finalVideoPath,
        ffmpegPath: ffmpeg.path,
        signal: opts.signal,
        strictCopy: true,
      });
    } catch (error) {
      saveComposeJob(jobDir, {
        jobId,
        kind: 'compose',
        state: opts.signal?.aborted ? 'cancelled' : 'failed',
        fingerprint,
        clipHashes,
        error: error instanceof Error ? error.message : 'concat failed',
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }

    const finalVideoHash = await hashFileSha256(finalVideoPath, opts.signal);
    saveComposeJob(jobDir, {
      jobId,
      kind: 'compose',
      state: 'done',
      fingerprint,
      clipHashes,
      finalVideoPath,
      finalVideoHash,
      updatedAt: new Date().toISOString(),
    });
    return { jobId, finalVideoPath, clipCount: spec.clips.length, resumed: false };
  } finally {
    release();
  }
}
