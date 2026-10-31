import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { resolveOutputDir } from './config.js';
import { safeBasename, VideoGenError } from './errors.js';
import {
  probeDuration,
  probeStreams,
  probeVideoDuration,
  resolveFfmpeg,
  resolveFfprobe,
  resolveGplFfmpeg,
  runFfmpegCommand,
} from './ffmpeg.js';
import {
  type ActiveJobs,
  assertSafeId,
  hashFileSha256,
  loadTimelineJob,
  saveTimelineJob,
  type TimelineJobManifest,
} from './jobs/store.js';
import { renderBurnedSubtitle, renderTextOverlay } from './text-layer.js';
import {
  type Motion,
  parseTimelineSpec,
  type TimelineSegment,
  type TimelineSpec,
  timelineSourcePath,
} from './timeline.js';
import { edgeTtsProvider, parseVoiceRef, type TtsProvider } from './tts/edge-tts.js';
import type { VideoGenSettings } from './types.js';

/**
 * Timeline compose pipeline (C1–C4): promo/explainer videos from images/video
 * clips + text overlays + TTS narration + motion, rendered LOCALLY with the
 * vendored ffmpeg — no video-generation model, near-zero marginal cost.
 *
 * Pipeline (all stages are artifact-cached in the job dir, so a rerun after
 * interruption resumes where it stopped):
 *   timeline-input.json → overlays/subtitles (sharp) → narration (Edge TTS) →
 *   normalized segment mp4s → xfade/concat video track →
 *   source/narration audio (+BGM ducking) → optional mov_text subtitles →
 *   ffprobe duration + QC frame extraction.
 */

export type TimelineRunResult = {
  jobId: string;
  finalVideoPath: string;
  segments: number;
  durationSec: number;
  subtitlePath?: string | undefined;
  qcFrames: string[];
};

export function assertNarrationOptIn(spec: TimelineSpec, hasInjectedTts = false): void {
  if (
    spec.segments.some((segment) => Boolean(segment.narration)) &&
    !hasInjectedTts &&
    !spec.voice?.startsWith('edge-tts:')
  )
    throw new VideoGenError(
      'Narration requires explicit Edge TTS opt-in. Set voice to "edge-tts:<voice-name>"; narration text will be sent to Microsoft.',
      'timeline: edge tts not opted in',
    );
}

const AUTO_PAD_SEC = 0.6;

function isInside(path: string): boolean {
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function copyApprovedMedia(
  sourcePath: string,
  cwd: string,
  destPath: string,
  label: string,
): Promise<void> {
  const absolute = resolve(cwd, sourcePath);
  if (!isInside(relative(resolve(cwd), absolute))) {
    throw new VideoGenError(
      `${label} must be inside the approved project directory.`,
      'timeline: media outside cwd',
    );
  }
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new VideoGenError(`${label} is not readable.`, 'timeline: media unreadable');
  }
  const root = await realpath(cwd);
  const canonical = await realpath(absolute);
  if (!isInside(relative(root, canonical))) {
    throw new VideoGenError(
      `${label} must be inside the approved project directory.`,
      'timeline: media outside cwd',
    );
  }

  const source = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const [openedInfo, canonicalInfo] = await Promise.all([source.stat(), lstat(canonical)]);
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== canonicalInfo.dev ||
      openedInfo.ino !== canonicalInfo.ino
    ) {
      throw new VideoGenError(
        `${label} changed while it was being validated.`,
        'timeline: media changed during validation',
      );
    }
    await pipeline(source.createReadStream(), createWriteStream(destPath, { flags: 'wx' }));
  } finally {
    await source.close().catch(() => {});
  }
}

/**
 * Write ffmpeg output to a TEMP path first, then atomic rename into place.
 * A cancelled run leaves a temp file, never a corrupt "final" — resume only
 * trusts a path that was renamed into existence.
 */
async function writeAtomic(
  destPath: string,
  run: (tmpPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(join(dirname(destPath), `.${basename(destPath)}.tmp-`));
  const tmp = join(tmpDir, basename(destPath));
  try {
    await run(tmp);
    await rename(tmp, destPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function hasSafeCachedArtifact(path: string, realJob: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new VideoGenError(
      `Cached artifact "${safeBasename(path)}" is not a regular file (symlink?).`,
      'timeline: cached artifact invalid',
    );
  }
  const real = await realpath(path);
  if (!real.startsWith(`${realJob}${sep}`)) {
    throw new VideoGenError(
      `Cached artifact "${safeBasename(path)}" resolves outside the job directory.`,
      'timeline: cached artifact escapes',
    );
  }
  return true;
}

function artifactKey(jobDir: string, path: string): string {
  return relative(jobDir, path).split(sep).join('/');
}

async function canReuseArtifact(opts: {
  path: string;
  jobDir: string;
  realJob: string;
  manifest: TimelineJobManifest;
  validatedArtifactKeys: Set<string>;
  signal?: AbortSignal | undefined;
}): Promise<boolean> {
  const key = artifactKey(opts.jobDir, opts.path);
  const expected = opts.manifest.artifactHashes[key];
  if (!expected && opts.manifest.state === 'done') {
    throw new VideoGenError(
      `The completed manifest is missing the artifact hash for "${safeBasename(opts.path)}". Start a NEW job directory or restore the manifest.`,
      'timeline: completed artifact hash missing',
    );
  }
  if (!expected) {
    let invalidated = false;
    for (const artifact of Object.keys(opts.manifest.artifactHashes)) {
      if (!opts.validatedArtifactKeys.has(artifact)) {
        delete opts.manifest.artifactHashes[artifact];
        invalidated = true;
      }
    }
    if (invalidated) saveTimelineJob(opts.jobDir, opts.manifest);
  }
  if (!(await hasSafeCachedArtifact(opts.path, opts.realJob))) {
    if (expected) {
      throw new VideoGenError(
        `Cached artifact "${safeBasename(opts.path)}" is missing.`,
        'timeline: cached artifact missing',
      );
    }
    return false;
  }
  if (!expected) {
    await rm(opts.path);
    return false;
  }
  if ((await hashFileSha256(opts.path, opts.signal)) !== expected) {
    throw new VideoGenError(
      `Cached artifact "${safeBasename(opts.path)}" changed since it was created.`,
      'timeline: cached artifact changed',
    );
  }
  opts.validatedArtifactKeys.add(key);
  return true;
}

async function recordArtifact(opts: {
  path: string;
  jobDir: string;
  realJob: string;
  manifest: TimelineJobManifest;
  validatedArtifactKeys: Set<string>;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  if (!(await hasSafeCachedArtifact(opts.path, opts.realJob))) {
    throw new VideoGenError(
      `Expected cached artifact "${safeBasename(opts.path)}" was not created.`,
      'timeline: cached artifact missing',
    );
  }
  const key = artifactKey(opts.jobDir, opts.path);
  opts.manifest.artifactHashes[key] = await hashFileSha256(opts.path, opts.signal);
  opts.validatedArtifactKeys.add(key);
  saveTimelineJob(opts.jobDir, opts.manifest);
}

function sha256hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function specFingerprint(opts: {
  specRaw: string;
  imageHashes: Record<string, string>;
  voice: string;
  resolution: string;
  fps: number;
  codec?: string | undefined;
  bgm?: string | null | undefined;
  bgmHash?: string | undefined;
}): string {
  return sha256hex(JSON.stringify(opts));
}

function motionFilter(
  motion: Motion | undefined,
  frames: number,
  width: number,
  height: number,
  fps: number,
  fit: 'contain' | 'cover' = 'contain',
): string {
  const m = motion ?? 'static';
  if (m === 'static') {
    return fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  }
  // zoompan truncates crop origins to chroma-aligned integers. Oversampling
  // keeps those source-pixel jumps subpixel-sized after the final downscale;
  // cap the long edge so extreme aspect ratios cannot create huge frames.
  const scale = Math.max(
    1.5,
    Math.min(2880 / Math.min(width, height), 8192 / Math.max(width, height)),
  );
  const bigW = 2 * Math.ceil((width * scale) / 2);
  const bigH = 2 * Math.ceil((height * scale) / 2);
  const pre = `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH}`;
  switch (m) {
    case 'kenburns-in':
      return `${pre},zoompan=z='min(1+0.06*on/${frames},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'kenburns-out':
      return `${pre},zoompan=z='max(1.12-0.06*on/${frames},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'zoom-in':
      return `${pre},zoompan=z='min(1+0.10*on/${frames},1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'zoom-out':
      return `${pre},zoompan=z='max(1.2-0.10*on/${frames},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'pan-left':
      return `${pre},zoompan=z='1.15':x='(iw-iw/zoom)*on/${frames}':y='(ih-ih/zoom)/2':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'pan-right':
      return `${pre},zoompan=z='1.15':x='(iw-iw/zoom)*(1-on/${frames})':y='(ih-ih/zoom)/2':d=${frames}:s=${width}x${height}:fps=${fps}`;
  }
}

function srtTimestamp(totalSec: number): string {
  const ms = Math.round(totalSec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`;
}

function splitCueText(text: string, maxLen = 24): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  const mid = Math.floor(t.length / 2);
  let cut = mid;
  for (let i = mid; i < Math.min(mid + 6, t.length); i++) {
    if ('，。、；：！？,.!?;: '.includes(t[i]!)) {
      cut = i + 1;
      break;
    }
  }
  return `${t.slice(0, cut).trim()}\n${t.slice(cut).trim()}`;
}

function transitionOverlap(segment: TimelineSegment): number {
  return segment.transitionTo?.durationSec ?? 0;
}

function isSourceAudioEnabled(segment: TimelineSegment & { sourceHasAudio?: boolean }): boolean {
  return Boolean(
    segment.video &&
      segment.sourceHasAudio &&
      !segment.sourceAudio?.muted &&
      (segment.sourceAudio?.volume ?? 1) > 0,
  );
}

function segmentSnapshotName(segment: TimelineSegment): string {
  const source = timelineSourcePath(segment);
  return `segment-${segment.id}${extname(source) || (segment.video ? '.mp4' : '.png')}`;
}

export async function runTimeline(opts: {
  timelineSpecPath: string;
  cwd: string;
  settings: VideoGenSettings;
  activeJobs: ActiveJobs;
  tts?: TtsProvider | undefined;
  signal?: AbortSignal | undefined;
  onUpdate?: ((msg: string) => void) | undefined;
}): Promise<TimelineRunResult> {
  const { settings, cwd } = opts;
  const outputDir = resolveOutputDir(settings, cwd);

  // ── 1. spec + job identity (realpath first) ─────────────────────────────
  const absSpecPath = resolve(cwd, opts.timelineSpecPath);
  const realSpecPath = await realpath(absSpecPath).catch(() => {
    throw new VideoGenError(
      'Timeline spec not readable. Expected <jobDir>/timeline-input.json under the video-gen output directory (.video-gen).',
      'timeline: spec unreadable',
    );
  });
  const realOutput = await realpath(outputDir).catch(() => resolve(outputDir));
  const jobDir = dirname(realSpecPath);
  if (jobDir !== realOutput && !jobDir.startsWith(`${realOutput}${sep}`)) {
    throw new VideoGenError(
      'The timeline job directory must live under the video-gen output directory (.video-gen).',
      'timeline: job outside outputDir',
    );
  }
  const jobId = basename(jobDir);
  assertSafeId(jobId, 'job');
  if (basename(realSpecPath) !== 'timeline-input.json') {
    throw new VideoGenError(
      'The timeline spec file must be named timeline-input.json.',
      'timeline: spec name',
    );
  }

  const specRaw = await readFile(realSpecPath);
  const spec = parseTimelineSpec(specRaw.toString('utf-8'));
  assertNarrationOptIn(spec, Boolean(opts.tts));
  const width = Number((spec.output?.resolution ?? '1920x1080').split('x')[0]);
  const height = Number((spec.output?.resolution ?? '1920x1080').split('x')[1]);
  const fps = spec.output?.fps ?? 25;
  const tts = opts.tts ?? edgeTtsProvider;
  const voice = parseVoiceRef(spec.voice);
  const bgmSource = spec.bgm;

  const release = opts.activeJobs.acquire(jobDir);
  let manifestForFailure: TimelineJobManifest | undefined;
  try {
    // Load any existing job BEFORE touching snapshots: a foreign manifest
    // (non-timeline kind) refuses immediately; a timeline manifest is only
    // accepted if its fingerprint still matches. Snapshotting uses a NEW
    // staging directory per run — a drifted spec never touches the old job's
    // frozen assets until the fingerprint matches.
    const existing = loadTimelineJob(jobDir);
    if (existing?.state === 'done' && existing.finalVideoPath !== join(jobDir, 'final_video.mp4')) {
      throw new VideoGenError(
        'The completed manifest final video path is invalid. Restore final_video.mp4 inside the job directory or start a NEW job.',
        'timeline: final path invalid',
      );
    }
    if (!existing) {
      for (const name of [
        'assets',
        'overlays',
        'audio',
        'segments',
        'qc',
        'video_track.mp4',
        'audio_track.mp4',
        '.audio-list.txt',
        'subtitles.srt',
        'final_video.mp4',
      ]) {
        const stat = await lstat(join(jobDir, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (stat) {
          throw new VideoGenError(
            `${name} already exists in this fresh timeline job. Move it aside or choose a new job directory; refusing to delete existing files.`,
            'timeline: output already exists',
          );
        }
      }
    }

    // ── 2. stage media (and BGM) into a FRESH staging dir, verify fingerprint
    //    against the manifest, then swap in as the job's frozen assets. The old
    //    job's assets/ is NEVER modified before the fingerprint check passes.
    opts.onUpdate?.('Freezing segment media…');
    const assetsDir = join(jobDir, 'assets');
    const stagingDir = await mkdtemp(join(jobDir, '.assets-staging-'));
    // Directory-realpath guard on the JOB dir itself (staging sits inside it).
    const realJob = await realpath(jobDir);
    const mediaHashes: Record<string, string> = {};
    const mediaSnaps: Record<string, string> = {};
    let bgmSnapshotPath = '';
    let manifest: TimelineJobManifest;
    try {
      for (const seg of spec.segments) {
        const source = timelineSourcePath(seg);
        const destPath = join(stagingDir, segmentSnapshotName(seg));
        await copyApprovedMedia(source, cwd, destPath, `Segment "${seg.id}" media source`);
        mediaSnaps[seg.id] = destPath;
        mediaHashes[seg.id] = await hashFileSha256(destPath, opts.signal);
      }

      // Freeze the BGM too (path alone doesn't pin content): snapshot + hash,
      // use the snapshot for mixing. Absent BGM → empty string, not included.
      let bgmHash = '';
      if (bgmSource) {
        const absBgm = resolve(cwd, bgmSource);
        const bgmDest = join(stagingDir, `bgm${extname(absBgm) || '.mp3'}`);
        await copyApprovedMedia(bgmSource, cwd, bgmDest, 'BGM');
        bgmSnapshotPath = bgmDest;
        bgmHash = await hashFileSha256(bgmDest, opts.signal);
      }

      const fingerprint = specFingerprint({
        specRaw: specRaw.toString('utf-8'),
        imageHashes: mediaHashes,
        voice,
        resolution: `${width}x${height}`,
        fps,
        codec: spec.output?.codec,
        bgm: bgmSource ?? null,
        bgmHash,
      });
      if (existing && existing.fingerprint !== fingerprint) {
        throw new VideoGenError(
          'timeline-input.json or a segment media source changed since this job was created. Revisions require a NEW job directory.',
          'timeline: input drift',
        );
      }

      manifest = existing ?? {
        jobId,
        kind: 'timeline',
        state: 'working',
        fingerprint,
        imageHashes: mediaHashes,
        artifactHashes: {},
        segments: {},
        updatedAt: new Date().toISOString(),
      };

      const assetsStat = await lstat(assetsDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (assetsStat && (!assetsStat.isDirectory() || assetsStat.isSymbolicLink())) {
        throw new VideoGenError(
          'assets/ is not a regular directory (symlink?).',
          'timeline: assets invalid',
        );
      }
      if (assetsStat) {
        const realAssets = await realpath(assetsDir);
        if (!realAssets.startsWith(`${realJob}${sep}`)) {
          throw new VideoGenError(
            'assets/ resolves outside the job directory (symlink?).',
            'timeline: assets escape',
          );
        }
      }

      // A matching manifest already owns an immutable snapshot; do not replace
      // it. New/recovery jobs publish the staged directory with one rename.
      if (existing && !assetsStat) {
        throw new VideoGenError(
          'Frozen timeline assets are missing. Start a NEW job directory.',
          'timeline: frozen assets missing',
        );
      }
      if (existing) {
        for (const seg of spec.segments) {
          const frozenPath = join(assetsDir, segmentSnapshotName(seg));
          const frozenStat = await lstat(frozenPath).catch(() => null);
          if (
            !frozenStat?.isFile() ||
            (await hashFileSha256(frozenPath, opts.signal)) !== mediaHashes[seg.id]
          ) {
            throw new VideoGenError(
              `Frozen media snapshot "${seg.id}" changed or is missing. Start a NEW job directory.`,
              'timeline: frozen media invalid',
            );
          }
        }
        if (bgmSnapshotPath) {
          const frozenBgm = join(assetsDir, basename(bgmSnapshotPath));
          const frozenStat = await lstat(frozenBgm).catch(() => null);
          if (!frozenStat?.isFile() || (await hashFileSha256(frozenBgm, opts.signal)) !== bgmHash) {
            throw new VideoGenError(
              'Frozen BGM snapshot changed or is missing. Start a NEW job directory.',
              'timeline: frozen bgm invalid',
            );
          }
        }
      } else {
        if (assetsStat) {
          throw new VideoGenError(
            'assets/ already exists in this fresh timeline job. Move it aside or choose a new job directory; refusing to delete existing files.',
            'timeline: assets already exist',
          );
        }
        await rename(stagingDir, assetsDir);
      }
      manifestForFailure = manifest;
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }

    // Repoint media references at the final assets/ paths (staging paths
    // were only for the pre-check fingerprint).
    for (const seg of spec.segments) {
      mediaSnaps[seg.id] = join(assetsDir, segmentSnapshotName(seg));
    }
    if (bgmSnapshotPath) {
      bgmSnapshotPath = join(assetsDir, basename(bgmSnapshotPath));
    }

    const validatedArtifactKeys = new Set<string>();
    const canReuse = (path: string) =>
      canReuseArtifact({
        path,
        jobDir,
        realJob,
        manifest,
        validatedArtifactKeys,
        signal: opts.signal,
      });
    const record = (path: string) =>
      recordArtifact({
        path,
        jobDir,
        realJob,
        manifest,
        validatedArtifactKeys,
        signal: opts.signal,
      });

    // ── 3. per-segment: overlay (sharp) + narration (TTS) + duration ──────
    const overlaysDir = join(jobDir, 'overlays');
    const audioDir = join(jobDir, 'audio');
    await mkdir(overlaysDir, { recursive: true });
    await mkdir(audioDir, { recursive: true });
    for (const dir of [overlaysDir, audioDir]) {
      const real = await realpath(dir);
      if (!real.startsWith(`${realJob}${sep}`)) {
        throw new VideoGenError(
          `${safeBasename(dir)}/ resolves outside the job directory (symlink?).`,
          'timeline: dir escapes',
        );
      }
    }

    type ResolvedSegment = TimelineSegment & {
      resolvedDurationSec: number;
      overlayPath?: string;
      burnedSubtitles?: { path: string; startSec: number; endSec: number }[];
      narrationPath?: string;
      narrationDurationSec?: number;
      sourceDurationSec?: number;
      sourceHasAudio?: boolean;
    };
    const resolved: ResolvedSegment[] = [];
    const mediaProbe = await resolveFfprobe(settings.ffmpegPath, opts.signal);

    for (const seg of spec.segments) {
      const out: ResolvedSegment = { ...seg, resolvedDurationSec: 0 };

      if (seg.video) {
        const sourcePath = mediaSnaps[seg.id]!;
        const [sourceDurationSec, streams] = await Promise.all([
          probeVideoDuration(mediaProbe.path, sourcePath, opts.signal),
          probeStreams(mediaProbe.path, sourcePath, opts.signal),
        ]);
        out.sourceDurationSec = sourceDurationSec;
        out.sourceHasAudio = streams.audioLayout !== 'none';
      }

      // text overlay
      if (seg.overlay && (seg.overlay.title || seg.overlay.subtitle)) {
        const overlayPath = join(overlaysDir, `text-${seg.id}.png`);
        if (!(await canReuse(overlayPath))) {
          opts.onUpdate?.(`Rendering text overlay for ${seg.id}…`);
          await writeAtomic(overlayPath, async (tmp) => {
            await renderTextOverlay({
              overlay: seg.overlay!,
              width,
              height,
              outPath: tmp,
              signal: opts.signal,
            });
          });
          await record(overlayPath);
        }
        out.overlayPath = overlayPath;
      }

      // narration via TTS
      if (seg.narration) {
        const narrationPath = join(audioDir, `${seg.id}.mp3`);
        const alreadyDegraded = manifest.segments[seg.id]?.narrationDegraded === true;
        let hasNarrationArtifact = alreadyDegraded ? false : await canReuse(narrationPath);
        let narrationNeedsCommit = false;
        if (alreadyDegraded) {
          opts.onUpdate?.(`Keeping the accepted silent-audio degradation for ${seg.id}.`);
        } else if (!hasNarrationArtifact) {
          try {
            opts.onUpdate?.(`Synthesizing narration for ${seg.id} (${voice})…`);
            const ttsResult = await tts.synthesize({
              text: seg.narration,
              voice,
              outPath: narrationPath,
              signal: opts.signal,
            });
            manifest.segments[seg.id] = {
              ...manifest.segments[seg.id],
              sentenceTimings: ttsResult.sentenceTimings?.filter(
                (cue) =>
                  cue.text.trim() &&
                  Number.isFinite(cue.startSec) &&
                  Number.isFinite(cue.endSec) &&
                  cue.startSec >= 0 &&
                  cue.endSec > cue.startSec,
              ),
            };
            hasNarrationArtifact = true;
            narrationNeedsCommit = true;
          } catch (error) {
            if (opts.signal?.aborted || spec.ttsFailureMode !== 'silent-subtitles') throw error;
            await rm(narrationPath, { force: true });
            delete manifest.artifactHashes[artifactKey(jobDir, narrationPath)];
            hasNarrationArtifact = false;
            manifest.segments[seg.id] = {
              ...manifest.segments[seg.id],
              narrationDurationSec: undefined,
              narrationDegraded: true,
            };
            opts.onUpdate?.(
              `Narration unavailable for ${seg.id}; using silent audio with subtitles as requested.`,
            );
          }
        }
        if (!alreadyDegraded && hasNarrationArtifact) {
          if (!(await hasSafeCachedArtifact(narrationPath, realJob))) {
            throw new VideoGenError(
              `Expected cached artifact "${safeBasename(narrationPath)}" was not created.`,
              'timeline: cached artifact missing',
            );
          }
          // The encoded file is authoritative; provider metadata may omit
          // trailing silence. Probe failures are infrastructure/media errors,
          // not an accepted TTS degradation.
          const durationSec = await probeDuration(mediaProbe.path, narrationPath, opts.signal);
          out.narrationPath = narrationPath;
          out.narrationDurationSec = durationSec;
          manifest.segments[seg.id] = {
            ...manifest.segments[seg.id],
            narrationDurationSec: durationSec,
            narrationDegraded: false,
          };
          if (narrationNeedsCommit) await record(narrationPath);
        }
      }

      // duration resolution
      const outgoingOverlap = transitionOverlap(seg);
      const audioFloor = out.narrationDurationSec
        ? out.narrationDurationSec + AUTO_PAD_SEC + outgoingOverlap
        : 0;
      const narrationWindow = (out.narrationDurationSec ?? 0) + outgoingOverlap;
      if (seg.video && typeof seg.durationSec === 'number' && narrationWindow > seg.durationSec) {
        throw new VideoGenError(
          `Segment "${seg.id}" narration (${out.narrationDurationSec?.toFixed(2)}s) does not fit the fixed ${seg.durationSec.toFixed(2)}s video duration. Shorten the narration or increase durationSec.`,
          'timeline: narration exceeds video duration',
        );
      }
      if (seg.durationSec === 'auto') {
        out.resolvedDurationSec = Math.max(1, audioFloor || 3);
      } else if (seg.video) {
        out.resolvedDurationSec = seg.durationSec;
      } else {
        out.resolvedDurationSec = Math.max(seg.durationSec, audioFloor);
      }
      if (
        seg.video &&
        (seg.trimStartSec ?? 0) + out.resolvedDurationSec > (out.sourceDurationSec ?? 0) + 0.05
      ) {
        throw new VideoGenError(
          `Segment "${seg.id}" requests ${(seg.trimStartSec ?? 0).toFixed(2)}s + ${out.resolvedDurationSec.toFixed(2)}s, beyond the ${out.sourceDurationSec?.toFixed(2)}s source video.`,
          'timeline: video trim exceeds source',
        );
      }
      if (seg.narration && spec.subtitles?.mode === 'burn') {
        const visibleSpan = out.resolvedDurationSec - transitionOverlap(seg);
        const timed = manifest.segments[seg.id]?.sentenceTimings;
        const cues = timed?.length
          ? timed
          : [{ text: seg.narration, startSec: 0, endSec: out.narrationDurationSec ?? visibleSpan }];
        out.burnedSubtitles = [];
        for (const [index, cue] of cues.entries()) {
          const endSec = Math.min(cue.endSec, visibleSpan);
          if (endSec <= cue.startSec) continue;
          const path = join(overlaysDir, `subtitle-${seg.id}-${index}.png`);
          if (!(await canReuse(path))) {
            await writeAtomic(path, async (tmp) => {
              await renderBurnedSubtitle({
                signal: opts.signal,
                text: cue.text,
                style: spec.subtitles!,
                width,
                height,
                outPath: tmp,
              });
            });
            await record(path);
          }
          out.burnedSubtitles.push({ path, startSec: cue.startSec, endSec });
        }
      }
      // Post-resolution revalidation: the resolved duration may differ from the declared duration.
      if (seg.transitionTo && seg.transitionTo.durationSec >= out.resolvedDurationSec) {
        throw new VideoGenError(
          `Segment "${seg.id}": transitionTo.durationSec (${seg.transitionTo.durationSec}s) must be shorter than the resolved duration (${out.resolvedDurationSec.toFixed(1)}s).`,
          'timeline: transition invalid',
        );
      }
      resolved.push(out);
      manifest.segments[seg.id] = {
        ...manifest.segments[seg.id],
        resolvedDurationSec: out.resolvedDurationSec,
      };
      saveTimelineJob(jobDir, manifest);
    }

    // ── 4. per-segment mp4 render ──────────────────────────────────────────
    const wantsH264 = spec.output?.codec === 'h264';
    const ffmpeg = wantsH264
      ? await resolveGplFfmpeg(settings.ffmpegPath, opts.signal)
      : await resolveFfmpeg(settings.ffmpegPath, opts.signal);
    if (wantsH264 && !ffmpeg.runnable) {
      throw new VideoGenError(
        'h264 output needs an ffmpeg with the libx264 encoder. Reinstall pi-video-gen, set pi-video-gen.ffmpegPath to a compatible binary, or use output.codec "mpeg4".',
        'timeline: gpl ffmpeg missing',
      );
    }
    if (!ffmpeg.runnable) {
      throw new VideoGenError(
        `ffmpeg is not runnable (source tried: ${ffmpeg.source}). Install or set pi-video-gen.ffmpegPath.`,
        'timeline: ffmpeg missing',
      );
    }
    const segmentsDir = join(jobDir, 'segments');
    await mkdir(segmentsDir, { recursive: true });
    const realSegments = await realpath(segmentsDir);
    if (!realSegments.startsWith(`${realJob}${sep}`)) {
      throw new VideoGenError(
        'segments/ resolves outside the job directory (symlink?).',
        'timeline: dir escapes',
      );
    }

    for (const seg of resolved) {
      const segPath = join(segmentsDir, `${seg.id}.mp4`);
      if (await canReuse(segPath)) continue;
      opts.onUpdate?.(`Rendering segment ${seg.id} (${seg.resolvedDurationSec.toFixed(1)}s)…`);
      const frames = Math.round(seg.resolvedDurationSec * fps);
      const motion = motionFilter(seg.motion, frames, width, height, fps, seg.fit);
      const inputs: string[] = seg.video
        ? [
            '-ss',
            (seg.trimStartSec ?? 0).toFixed(2),
            '-t',
            seg.resolvedDurationSec.toFixed(2),
            '-i',
            mediaSnaps[seg.id]!,
          ]
        : [
            '-loop',
            '1',
            '-framerate',
            String(fps),
            '-t',
            seg.resolvedDurationSec.toFixed(2),
            '-i',
            mediaSnaps[seg.id]!,
          ];
      const graphParts: string[] = [
        `[0:v]${motion}${seg.video ? `,fps=${fps}` : ''},format=yuv420p[base]`,
      ];
      let currentLayer = 'base';
      const overlays = [
        ...(seg.overlayPath ? [{ path: seg.overlayPath }] : []),
        ...(seg.burnedSubtitles ?? []),
      ];
      for (const [index, overlay] of overlays.entries()) {
        const overlayPath = overlay.path;
        const inputIndex = inputs.filter((arg) => arg === '-i').length;
        inputs.push('-i', overlayPath);
        const enable =
          'startSec' in overlay
            ? `:enable='between(t,${overlay.startSec.toFixed(3)},${overlay.endSec.toFixed(3)})'`
            : '';
        graphParts.push(
          `[${inputIndex}:v]format=rgba[ovr${index}]`,
          `[${currentLayer}][ovr${index}]overlay=0:0:format=auto${enable}[layer${index}]`,
        );
        currentLayer = `layer${index}`;
      }
      if (currentLayer === 'base') {
        graphParts.push(`[base]copy[vout]`);
      } else {
        graphParts.push(`[${currentLayer}]copy[vout]`);
      }

      await writeAtomic(segPath, async (tmp) => {
        if (seg.narrationPath) {
          inputs.push('-i', seg.narrationPath);
        } else {
          inputs.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`);
        }
        const audioInputIndex = inputs.filter((a) => a === '-i').length - 1;
        await runFfmpegCommand(
          ffmpeg.path,
          [
            ...inputs,
            '-filter_complex',
            graphParts.join(';'),
            '-map',
            '[vout]',
            '-map',
            `${audioInputIndex}:a`,
            '-t',
            seg.resolvedDurationSec.toFixed(2),
            '-c:v',
            ...(wantsH264 ? ['libx264', '-crf', '20'] : ['mpeg4', '-q:v', '4']),
            '-c:a',
            'aac',
            '-b:a',
            '96k',
            '-r',
            String(fps),
            '-y',
            tmp,
          ],
          opts.signal,
        );
      });
      await record(segPath);
    }

    // ── 5. video chain: xfade for transitions, concat for cuts ─────────────
    opts.onUpdate?.('Joining segments…');
    const videoOnlyPath = join(jobDir, 'video_track.mp4');
    if (!(await canReuse(videoOnlyPath))) {
      await writeAtomic(videoOnlyPath, async (tmp) => {
        const segInputs = resolved.flatMap((s) => ['-i', join(segmentsDir, `${s.id}.mp4`)]);
        const chains: string[] = resolved.map((_s, i) => `[${i}:v]settb=AVTB,fps=${fps}[v${i}]`);
        let current = 'v0';
        let offsetBase = 0;

        for (let i = 0; i < resolved.length - 1; i++) {
          const seg = resolved[i]!;
          const t = transitionOverlap(seg);

          offsetBase += seg.resolvedDurationSec;
          if (t > 0) {
            const offset = Math.max(0.1, offsetBase - t);
            chains.push(
              `[${current}][v${i + 1}]xfade=transition=${seg.transitionTo!.style}:duration=${t.toFixed(2)}:offset=${offset.toFixed(2)}[x${i}]`,
            );
            current = `x${i}`;
            offsetBase -= t;
          } else {
            chains.push(`[${current}][v${i + 1}]concat=n=2:v=1:a=0[x${i}]`);
            current = `x${i}`;
          }
        }
        await runFfmpegCommand(
          ffmpeg.path,
          [
            ...segInputs,
            '-filter_complex',
            `${chains.join(';')};[${current}]format=yuv420p[v]`,
            '-map',
            '[v]',
            '-c:v',
            ...(wantsH264 ? ['libx264', '-crf', '20'] : ['mpeg4', '-q:v', '4']),
            '-r',
            String(fps),
            '-y',
            tmp,
          ],
          opts.signal,
        );
      });
      await record(videoOnlyPath);
    }

    // ── 6. audio track: concat per-segment audio, optional BGM ducking ─────
    const audioTrackPath = join(jobDir, 'audio_track.mp4');
    for (const seg of resolved) {
      const sourceAudioEnabled = isSourceAudioEnabled(seg);
      if (seg.narrationPath) await canReuse(join(audioDir, `${seg.id}_padded.mp4`));
      if (sourceAudioEnabled) await canReuse(join(audioDir, `${seg.id}_source.mp4`));
      if (seg.narrationPath && sourceAudioEnabled) {
        await canReuse(join(audioDir, `${seg.id}_mixed.mp4`));
      }
      if (!seg.narrationPath && !sourceAudioEnabled) {
        await canReuse(join(audioDir, `${seg.id}_silence.mp4`));
      }
    }
    if (!(await canReuse(audioTrackPath))) {
      opts.onUpdate?.('Mixing audio track…');
      const listPath = join(jobDir, '.audio-list.txt');
      const lines: string[] = [];
      // Audio follows the effective VIDEO timeline. Auto duration includes an
      // outgoing xfade, so subtracting that overlap here still leaves the full
      // narration plus padding before the next segment starts.
      for (let i = 0; i < resolved.length; i++) {
        const seg = resolved[i]!;
        const overlap = transitionOverlap(seg);
        const audioSpan = Math.max(0.2, seg.resolvedDurationSec - overlap);
        let narrationAudioPath: string | undefined;
        if (seg.narrationPath) {
          // Narration length IS its own audio; the segment spans it. No
          // trimming (long transitions must never cut narration) and no fake
          // MP3→MP4 padding — narration stays whole, silence fills the rest.
          const narrationSpan = seg.narrationDurationSec ?? audioSpan;
          const narrationClipped = Math.min(narrationSpan, audioSpan);
          const paddedPath = join(audioDir, `${seg.id}_padded.mp4`);
          if (!(await canReuse(paddedPath))) {
            const gapSec = Math.max(0, audioSpan - narrationClipped);
            await writeAtomic(paddedPath, async (tmp) => {
              await runFfmpegCommand(
                ffmpeg.path,
                [
                  '-i',
                  seg.narrationPath!,
                  '-f',
                  'lavfi',
                  '-i',
                  'anullsrc=r=48000:cl=stereo',
                  '-filter_complex',
                  `[0:a]atrim=0:${narrationClipped.toFixed(2)}[na];[1:a]atrim=0:${gapSec.toFixed(2)}[sil];[na][sil]concat=n=2:v=0:a=1[out]`,
                  '-map',
                  '[out]',
                  '-t',
                  audioSpan.toFixed(2),
                  '-c:a',
                  'aac',
                  '-b:a',
                  '96k',
                  '-y',
                  tmp,
                ],
                opts.signal,
              );
            });
            await record(paddedPath);
          }
          narrationAudioPath = paddedPath;
        }

        const sourceAudioEnabled = isSourceAudioEnabled(seg);
        let sourceAudioPath: string | undefined;
        if (sourceAudioEnabled) {
          sourceAudioPath = join(audioDir, `${seg.id}_source.mp4`);
          if (!(await canReuse(sourceAudioPath))) {
            await writeAtomic(sourceAudioPath, async (tmp) => {
              await runFfmpegCommand(
                ffmpeg.path,
                [
                  '-ss',
                  (seg.trimStartSec ?? 0).toFixed(2),
                  '-t',
                  audioSpan.toFixed(2),
                  '-i',
                  mediaSnaps[seg.id]!,
                  '-f',
                  'lavfi',
                  '-i',
                  'anullsrc=r=48000:cl=stereo',
                  '-filter_complex',
                  `[0:a]volume=${(seg.sourceAudio?.volume ?? 1).toFixed(3)}[src];[src][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=false[out]`,
                  '-map',
                  '[out]',
                  '-t',
                  audioSpan.toFixed(2),
                  '-ar',
                  '48000',
                  '-ac',
                  '2',
                  '-c:a',
                  'aac',
                  '-b:a',
                  '96k',
                  '-y',
                  tmp,
                ],
                opts.signal,
              );
            });
            await record(sourceAudioPath);
          }
        }

        let segmentAudioPath = narrationAudioPath ?? sourceAudioPath;
        if (narrationAudioPath && sourceAudioPath) {
          const mixedPath = join(audioDir, `${seg.id}_mixed.mp4`);
          if (!(await canReuse(mixedPath))) {
            await writeAtomic(mixedPath, async (tmp) => {
              await runFfmpegCommand(
                ffmpeg.path,
                [
                  '-i',
                  narrationAudioPath!,
                  '-i',
                  sourceAudioPath!,
                  '-filter_complex',
                  '[0:a][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[out]',
                  '-map',
                  '[out]',
                  '-c:a',
                  'aac',
                  '-b:a',
                  '96k',
                  '-y',
                  tmp,
                ],
                opts.signal,
              );
            });
            await record(mixedPath);
          }
          segmentAudioPath = mixedPath;
        }

        if (!segmentAudioPath) {
          // silence: reuse anullsrc through a named filter is not possible in
          // concat demuxer — record the silent gap via a generated silent file
          const silencePath = join(audioDir, `${seg.id}_silence.mp4`);
          if (!(await canReuse(silencePath))) {
            await writeAtomic(silencePath, async (tmp) => {
              await runFfmpegCommand(
                ffmpeg.path,
                [
                  '-f',
                  'lavfi',
                  '-i',
                  'anullsrc=r=48000:cl=stereo',
                  '-t',
                  audioSpan.toFixed(2),
                  '-c:a',
                  'aac',
                  '-b:a',
                  '96k',
                  '-y',
                  tmp,
                ],
                opts.signal,
              );
            });
            await record(silencePath);
          }
          segmentAudioPath = silencePath;
        }
        lines.push(`file '${segmentAudioPath.replace(/'/g, `'\\''`)}'`);
      }
      await writeAtomic(listPath, async (tmp) => {
        await writeFile(tmp, lines.join('\n'), 'utf-8');
      });

      if (bgmSource) {
        await writeAtomic(audioTrackPath, async (tmp) => {
          await runFfmpegCommand(
            ffmpeg.path,
            [
              '-f',
              'concat',
              '-safe',
              '0',
              '-i',
              listPath,
              '-i',
              bgmSnapshotPath,
              '-filter_complex',
              '[0:a]volume=1.0[a1];[1:a]volume=0.18[a2];[a1][a2]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[aout]',
              '-map',
              '[aout]',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-shortest',
              '-y',
              tmp,
            ],
            opts.signal,
          );
        });
      } else {
        await writeAtomic(audioTrackPath, async (tmp) => {
          await runFfmpegCommand(
            ffmpeg.path,
            [
              '-f',
              'concat',
              '-safe',
              '0',
              '-i',
              listPath,
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-y',
              tmp,
            ],
            opts.signal,
          );
        });
      }
      await record(audioTrackPath);
    }

    // ── 7. mux video+audio, mov_text subtitles ─────────────────────────────
    const finalVideoPath = join(jobDir, 'final_video.mp4');
    if (manifest.state !== 'done') {
      let invalidated = false;
      for (const key of Object.keys(manifest.artifactHashes)) {
        if (key.startsWith('qc/')) {
          delete manifest.artifactHashes[key];
          invalidated = true;
        }
      }
      if (manifest.finalVideoPath !== undefined || manifest.finalVideoHash !== undefined) {
        delete manifest.finalVideoPath;
        delete manifest.finalVideoHash;
        invalidated = true;
      }
      if (invalidated) saveTimelineJob(jobDir, manifest);
    }
    const finalStat = await lstat(finalVideoPath).catch(() => null);
    if (manifest.state === 'done' && !finalStat) {
      throw new VideoGenError(
        'The completed final video is missing. Restore final_video.mp4 or start a NEW job directory.',
        'timeline: final artifact missing',
      );
    }
    if (finalStat && (!finalStat.isFile() || finalStat.isSymbolicLink())) {
      throw new VideoGenError(
        'The cached final video is invalid (not a regular file or is a symlink).',
        'timeline: final artifact invalid',
      );
    }
    let hasFinalVideo = Boolean(finalStat);
    if (hasFinalVideo && manifest.state === 'done') {
      const actualHash = await hashFileSha256(finalVideoPath, opts.signal);
      if (actualHash !== manifest.finalVideoHash) {
        throw new VideoGenError(
          'The cached final video changed since this job completed.',
          'timeline: final artifact changed',
        );
      }
    } else if (hasFinalVideo) {
      // The process may have stopped after rename but before the done manifest.
      // Without a persisted hash the artifact has no recoverable identity.
      await rm(finalVideoPath);
      hasFinalVideo = false;
    }
    const narrated = resolved.filter((segment) => Boolean(segment.narration));
    const hasNarration = narrated.length > 0;
    const hasSoftSubtitles = hasNarration && spec.subtitles?.mode !== 'burn';
    const subtitlePath = hasNarration ? join(jobDir, 'subtitles.srt') : undefined;
    let expectedSrt = '';
    if (subtitlePath) {
      const cues: string[] = [];
      // Cue times follow the VIDEO timeline: each xfade overlap shifts later
      // segments earlier by the transition duration.
      let videoCursor = 0;
      let idx = 1;
      for (const seg of resolved) {
        if (seg.narration) {
          const start = videoCursor;
          const visibleSpan = seg.resolvedDurationSec - transitionOverlap(seg);
          const timed = manifest.segments[seg.id]?.sentenceTimings;
          const sentences = timed?.length
            ? timed
            : [
                {
                  text: seg.narration,
                  startSec: 0,
                  endSec: seg.narrationDurationSec ?? visibleSpan,
                },
              ];
          for (const cue of sentences) {
            const end = Math.min(start + visibleSpan, start + cue.endSec);
            if (end <= start + cue.startSec) continue;
            cues.push(`${idx++}
${srtTimestamp(start + cue.startSec)} --> ${srtTimestamp(end)}
${splitCueText(cue.text)}
`);
          }
        }
        videoCursor += seg.resolvedDurationSec - transitionOverlap(seg);
      }
      expectedSrt = cues.join('\n');
      if (!(await canReuse(subtitlePath))) {
        await writeAtomic(subtitlePath, async (tmp) => {
          await writeFile(tmp, expectedSrt, 'utf-8');
        });
        await record(subtitlePath);
      }
    }
    if (!hasFinalVideo) {
      const subArgs = hasSoftSubtitles
        ? ['-i', subtitlePath!, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi']
        : [];

      opts.onUpdate?.('Muxing final video…');
      await writeAtomic(finalVideoPath, async (tmp) => {
        await runFfmpegCommand(
          ffmpeg.path,
          [
            '-i',
            videoOnlyPath,
            '-i',
            audioTrackPath,
            ...subArgs,
            '-map',
            '0:v',
            '-map',
            '1:a',
            ...(hasSoftSubtitles ? ['-map', '2:s'] : []),
            '-c:v',
            'copy',
            '-c:a',
            'copy',
            '-movflags',
            '+faststart',
            // NO -shortest: with a subtitle track present it truncates the
            // container to the shortest STREAM (the last cue), not the video.
            '-y',
            tmp,
          ],
          opts.signal,
        );
      });
    }
    const finalVideoHash = await hashFileSha256(finalVideoPath, opts.signal);

    // ── 8. QC: duration probe + frame extraction ───────────────────────────
    const ffprobe = await resolveFfprobe(settings.ffmpegPath, opts.signal);
    const qcDir = join(jobDir, 'qc');
    await mkdir(qcDir, { recursive: true });
    const realQc = await realpath(qcDir);
    if (!realQc.startsWith(`${realJob}${sep}`)) {
      throw new VideoGenError(
        'qc/ resolves outside the job directory (symlink?).',
        'timeline: dir escapes',
      );
    }
    // Expected = Σ segment durations − Σ xfade overlaps (each transition
    // shortens the video by its duration). Compare against the final probe.
    const totalOverlap = resolved.reduce((n, segment) => n + transitionOverlap(segment), 0);
    const expectedSec = resolved.reduce((n, s) => n + s.resolvedDurationSec, 0) - totalOverlap;
    const actualSec = await probeDuration(ffprobe.path, finalVideoPath, opts.signal);
    if (Math.abs(actualSec - expectedSec) > 1) {
      throw new VideoGenError(
        `QC: final duration ${actualSec.toFixed(1)}s differs from planned ${expectedSec.toFixed(1)}s by more than 1s.`,
        'timeline: duration qc',
      );
    }
    const streams = await probeStreams(ffprobe.path, finalVideoPath, opts.signal);
    if (streams.audioLayout === 'none') {
      throw new VideoGenError(
        'QC: the final video is missing its audio stream.',
        'timeline: audio qc',
      );
    }
    if (hasSoftSubtitles && streams.subtitleCodec !== 'mov_text') {
      throw new VideoGenError(
        'QC: the final video is missing its mov_text subtitle track.',
        'timeline: subtitle qc',
      );
    }
    if (hasNarration && !hasSoftSubtitles && streams.subtitleCodec !== 'none') {
      throw new VideoGenError(
        'QC: burned-subtitle output unexpectedly contains a soft subtitle track.',
        'timeline: burned subtitle qc',
      );
    }
    if (subtitlePath && (await readFile(subtitlePath, 'utf-8')) !== expectedSrt) {
      throw new VideoGenError(
        'QC: the SRT timeline does not match the resolved narration timeline.',
        'timeline: srt timeline qc',
      );
    }

    const edgeOffset = Math.min(0.5, actualSec / 4);
    const shots: [string, number][] = [
      ['qc_first.png', edgeOffset],
      ['qc_mid.png', actualSec / 2],
      ['qc_last.png', actualSec - edgeOffset],
    ];
    let segmentCursor = 0;
    for (const seg of resolved) {
      const overlap = transitionOverlap(seg);
      const visibleSpan = seg.resolvedDurationSec - overlap;
      shots.push([`qc_segment_${seg.id}.png`, segmentCursor + visibleSpan / 2]);
      if (overlap > 0) {
        const boundary = segmentCursor + visibleSpan;
        const delta = Math.min(0.15, overlap / 3);
        shots.push([`qc_transition_${seg.id}_before.png`, boundary - delta]);
        shots.push([`qc_transition_${seg.id}_after.png`, boundary + delta]);
      }
      segmentCursor += visibleSpan;
    }
    const qcReady = (await Promise.all(shots.map(([name]) => canReuse(join(qcDir, name))))).every(
      Boolean,
    );
    if (!qcReady) {
      opts.onUpdate?.('Extracting QC frames…');
      for (const [name, t] of shots) {
        const out = join(qcDir, name);
        if (await canReuse(out)) continue;
        await writeAtomic(out, async (tmp) => {
          await runFfmpegCommand(
            ffmpeg.path,
            [
              '-ss',
              Math.max(0, Math.min(actualSec - 0.02, t)).toFixed(2),
              '-i',
              finalVideoPath,
              '-frames:v',
              '1',
              '-y',
              tmp,
            ],
            opts.signal,
          );
        });
        await record(out);
      }
    }
    const qcFrames = shots.map(([name]) => join(qcDir, name));

    manifest.state = 'done';
    manifest.finalVideoPath = finalVideoPath;
    manifest.finalVideoHash = finalVideoHash;
    saveTimelineJob(jobDir, manifest);
    opts.onUpdate?.(`Done: ${finalVideoPath}`);

    return {
      jobId,
      finalVideoPath,
      segments: resolved.length,
      durationSec: expectedSec,
      subtitlePath,
      qcFrames,
    };
  } catch (error) {
    if (manifestForFailure && manifestForFailure.state !== 'done') {
      manifestForFailure.state = opts.signal?.aborted ? 'cancelled' : 'failed';
      manifestForFailure.error = opts.signal?.aborted
        ? 'Timeline render cancelled.'
        : 'Timeline render failed. Retry the same job to resume.';
      saveTimelineJob(jobDir, manifestForFailure);
    }
    throw error;
  } finally {
    release();
  }
}
