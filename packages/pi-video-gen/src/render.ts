import { COPYFILE_EXCL } from 'node:constants';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { resolveOutputDir } from './config.js';
import {
  AmbiguousSubmitError,
  errorMessageForUser,
  RemoteTaskFailedError,
  RemoteTaskNotFoundError,
  safeBasename,
  toLogSummary,
  VideoGenError,
} from './errors.js';
import {
  concatVideos,
  probeDuration,
  probeStreams,
  resolveFfprobe,
  resolveGplFfmpeg,
  runFfmpegCommand,
} from './ffmpeg.js';
import { readApprovedFrame } from './frame-input.js';
import {
  type ActiveJobs,
  assertSafeId,
  hashFileSha256,
  loadRenderJob,
  loadTimelineJob,
  type RenderJobManifest,
  readJsonFile,
  saveRenderJob,
  writeJsonAtomic,
} from './jobs/store.js';
import { assemblePrompt, validateFilmPrompt, validateShotPrompt } from './prompt.js';
import {
  normalizeReferenceAssets,
  referenceAssetPreflightError,
  requestFingerprint,
} from './providers/request.js';
import { CancelledError, pollTask, type RateLimiter } from './providers/task.js';
import {
  parseRemotionSpec,
  preflightRemotion,
  type RemotionSpec,
  runRemotion,
} from './remotion.js';
import { hasCjkFont } from './text-layer.js';
import { parseTimelineSpec, type TimelineSpec } from './timeline.js';
import { assertNarrationOptIn, runTimeline } from './timeline-render.js';
import type {
  FilmPrompt,
  GenerateVideoParams,
  ReferenceAsset,
  RemoteTaskHandle,
  ResolvedModel,
  ShotPrompt,
  VideoGenSettings,
  VideoProviderAdapter,
} from './types.js';

/**
 * Multi-shot render orchestration (`video_render`).
 *
 * Contract (design review):
 * - input is `<jobDir>/render-input.json`; the parent directory IS the job and
 *   must live under the video-gen output dir;
 * - the spec is immutable per job: resume verifies a fingerprint over
 *   spec + frame contents + model/provider and REFUSES on drift (revisions
 *   go in a new job directory);
 * - remote task handles persist to the manifest the moment submit() returns;
 *   reruns resume via inspect() and never re-bill finished shots;
 * - foreground execution with onUpdate progress; signal cancels locally
 *   (`polling_stopped` — the remote task may keep billing).
 */

export type RenderShotInput = {
  id: string;
  /** Structured per-shot prompt fields — assembled via assemblePrompt before submit. */
  prompt?: ShotPrompt;
  videoPath?: string;
  firstFramePath?: string | undefined;
  lastFramePath?: string | undefined;
  referenceAssets?: ReferenceAsset[] | undefined;
  durationSec?: number | undefined;
};

export type RenderInput = FilmPrompt & {
  title?: string | undefined;
  aspectRatio?: string | undefined;
  shots: RenderShotInput[];
  assembly?:
    | {
        type: 'remotion';
        projectDir: string;
        compositionId: string;
        entryPoint?: string;
        inputProps?: Record<string, unknown>;
        assets?: Record<string, string>;
        browserExecutable?: string;
        qcTimesSec?: number[];
      }
    | { type: 'timeline'; timeline: TimelineSpec };
};

export type RenderRunResult = {
  jobId: string;
  finalVideoPath: string;
  shotsDone: number;
  degraded: string[];
  qcFrames: string[];
  qcReportPath?: string | undefined;
  editableProjectDir?: string | undefined;
};

let snapshotCounter = 0;

function sha256hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function specFingerprint(specRaw: string, resolved?: ResolvedModel): string {
  if (!resolved) return sha256hex(JSON.stringify({ spec: specRaw, mode: 'local' }));
  return sha256hex(
    JSON.stringify({
      spec: specRaw,
      model: resolved.remoteId,
      provider: resolved.provider.style,
      baseUrl: resolved.provider.baseUrl,
      defaults: {
        resolution: resolved.entry.defaultResolution,
        aspectRatio: resolved.entry.defaultAspectRatio,
        durationSec: resolved.entry.defaultDurationSec,
      },
      capabilities: resolved.entry.capabilities,
    }),
  );
}

function expectedSnapshotKeys(spec: RenderInput, cwd: string): string[] {
  return spec.shots.flatMap((shot) => {
    const keys: string[] = [];
    if (shot.firstFramePath) {
      keys.push(
        join(
          'shots',
          shot.id,
          `first_frame${extname(resolve(cwd, shot.firstFramePath)) || '.png'}`,
        ),
      );
    }
    if (shot.lastFramePath) {
      keys.push(
        join('shots', shot.id, `last_frame${extname(resolve(cwd, shot.lastFramePath)) || '.png'}`),
      );
    }
    return keys;
  });
}

function sameKeys(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const wanted = new Set(expected);
  return actual.every((key) => wanted.has(key));
}

function assemblySources(spec: RenderInput, cwd: string): Record<string, string> {
  if (spec.assembly?.type === 'remotion')
    return Object.fromEntries(
      Object.entries(spec.assembly.assets ?? {}).map(([id, path]) => [id, resolve(cwd, path)]),
    );
  if (spec.assembly?.type === 'timeline' && spec.assembly.timeline.bgm)
    return { bgm: resolve(cwd, spec.assembly.timeline.bgm) };
  return {};
}

function timelineWithShotPaths(timeline: TimelineSpec, shotsDir: string): TimelineSpec {
  return {
    ...timeline,
    segments: timeline.segments.map(
      (segment: TimelineSpec['segments'][number] & { shotId?: string }) => ({
        ...segment,
        video: join(shotsDir, segment.shotId!, 'video.mp4'),
        shotId: undefined,
      }),
    ),
  };
}

/** Manual validation with agent-fixable error messages (better than a schema dump). */
export function parseRenderSpec(raw: string): RenderInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoGenError('render-input.json is not valid JSON.', 'render: spec not json');
  }
  const spec = parsed as RenderInput;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.shots) || spec.shots.length === 0) {
    throw new VideoGenError(
      'render-input.json must contain a non-empty "shots" array.',
      'render: no shots',
    );
  }
  const charactersError = validateFilmPrompt(spec, 'render-input.json');
  if (charactersError) {
    throw new VideoGenError(charactersError, 'render: bad characters');
  }
  // Type-check, not truthiness: 0/false/"" would skip the capability check but
  // still flow through `??` into the fingerprint and paid request.
  if (
    spec.aspectRatio !== undefined &&
    (typeof spec.aspectRatio !== 'string' || spec.aspectRatio.trim() === '')
  ) {
    throw new VideoGenError(
      'render-input.json aspectRatio must be a non-empty string (e.g. "16:9").',
      'render: bad ratio type',
    );
  }
  const seen = new Set<string>();
  spec.shots.forEach((shot, i) => {
    const where = `shots[${i}]${shot?.id ? ` ("${shot.id}")` : ''}`;
    if (!shot || typeof shot !== 'object') {
      throw new VideoGenError(`${where} is not an object.`, 'render: bad shot');
    }
    if (typeof shot.id !== 'string' || shot.id.trim() === '') {
      throw new VideoGenError(`${where}.id must be a non-empty string.`, 'render: bad id type');
    }
    assertSafeId(shot.id, 'shot');
    if (seen.has(shot.id)) {
      throw new VideoGenError(
        `Duplicate shot id "${shot.id}" — ids must be unique.`,
        'render: dup shot id',
      );
    }
    seen.add(shot.id);
    if (shot.videoPath !== undefined) {
      if (typeof shot.videoPath !== 'string' || shot.videoPath.trim() === '') {
        throw new VideoGenError(
          `${where}.videoPath must be a non-empty path.`,
          'render: bad video path',
        );
      }
      if (
        shot.prompt !== undefined ||
        shot.firstFramePath !== undefined ||
        shot.lastFramePath !== undefined ||
        shot.referenceAssets !== undefined ||
        shot.durationSec !== undefined
      ) {
        throw new VideoGenError(
          `${where}.videoPath cannot be combined with generation fields.`,
          'render: mixed shot source',
        );
      }
      return;
    }
    if (
      shot.firstFramePath !== undefined &&
      (typeof shot.firstFramePath !== 'string' || shot.firstFramePath.trim() === '')
    ) {
      throw new VideoGenError(
        `${where}.firstFramePath must be a path string when present.`,
        'render: bad first frame type',
      );
    }
    if (
      shot.lastFramePath !== undefined &&
      (typeof shot.lastFramePath !== 'string' || shot.lastFramePath.trim() === '')
    ) {
      throw new VideoGenError(
        `${where}.lastFramePath must be a path string when present.`,
        'render: bad last frame type',
      );
    }
    if (shot.lastFramePath && !shot.firstFramePath) {
      throw new VideoGenError(
        `${where}.lastFramePath requires firstFramePath.`,
        'render: last frame without first',
      );
    }
    const referenceAssets = normalizeReferenceAssets(
      (shot as { referenceAssets?: unknown }).referenceAssets,
      `${where}.referenceAssets`,
    );
    shot.referenceAssets = referenceAssets.length > 0 ? referenceAssets : undefined;
    if (!shot.firstFramePath && !shot.referenceAssets) {
      throw new VideoGenError(
        `${where} requires firstFramePath or at least one referenceAsset.`,
        'render: missing visual input',
      );
    }
    const promptError = validateShotPrompt(
      spec,
      shot.prompt,
      { hasFirstFrame: Boolean(shot.firstFramePath?.trim()) },
      `${where}.prompt`,
    );
    if (promptError) {
      throw new VideoGenError(promptError, 'render: bad prompt');
    }
    if (
      shot.durationSec !== undefined &&
      (typeof shot.durationSec !== 'number' || !Number.isSafeInteger(shot.durationSec))
    ) {
      throw new VideoGenError(
        `${where}.durationSec must be an integer number of seconds.`,
        'render: bad duration type',
      );
    }
  });
  if (spec.assembly !== undefined) {
    if (
      !spec.assembly ||
      typeof spec.assembly !== 'object' ||
      !['remotion', 'timeline'].includes(spec.assembly.type)
    )
      throw new VideoGenError('assembly.type must be remotion or timeline.', 'render: assembly');
    if (spec.assembly.type === 'remotion') {
      parseRemotionSpec(JSON.stringify(spec.assembly));
      for (const id of Object.keys(spec.assembly.assets ?? {}))
        if (seen.has(id))
          throw new VideoGenError(
            `Remotion asset "${id}" conflicts with shot ID.`,
            'render: asset collision',
          );
    }
    if (spec.assembly.type === 'timeline') {
      const timeline = spec.assembly.timeline;
      if (!timeline || !Array.isArray(timeline.segments))
        throw new VideoGenError('assembly.timeline must contain segments.', 'render: timeline');
      const shotIds = new Set(spec.shots.map((shot) => shot.id));
      for (const segment of timeline.segments as ((typeof timeline.segments)[number] & {
        shotId?: string;
      })[]) {
        if (
          typeof segment.shotId !== 'string' ||
          !shotIds.has(segment.shotId) ||
          segment.video !== undefined ||
          segment.image !== undefined
        )
          throw new VideoGenError(
            `Timeline segment ${segment.id ?? '?'} needs a valid shotId and no video/image path.`,
            'render: timeline shot ref',
          );
      }
    }
  }
  return spec;
}

async function runPool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  let firstError: unknown;
  const runners = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (idx < items.length && firstError === undefined) {
      const item = items[idx++]!;
      try {
        await worker(item);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(runners);
  if (firstError !== undefined) throw firstError;
}

export async function runRender(opts: {
  renderSpecPath: string;
  allowDegradations?: string[] | undefined;
  settings: VideoGenSettings;
  cwd: string;
  resolved?: ResolvedModel | undefined;
  adapter?: VideoProviderAdapter | undefined;
  activeJobs: ActiveJobs;
  rateLimiter: RateLimiter;
  ffmpegPath: string;
  trusted?: boolean;
  signal?: AbortSignal | undefined;
  onUpdate?: ((msg: string) => void) | undefined;
  concatImpl?: typeof concatVideos | undefined;
  verifyMedia?: boolean | undefined;
}): Promise<RenderRunResult> {
  const { settings, cwd, resolved, adapter } = opts;
  const outputDir = resolveOutputDir(settings, cwd);

  // 1. spec + job identity
  const absSpecPath = resolve(cwd, opts.renderSpecPath);
  const specRaw = await readFile(absSpecPath, 'utf-8').catch(() => {
    throw new VideoGenError(
      'Render spec not readable. Expected <jobDir>/render-input.json under the video-gen output directory (.video-gen).',
      'render: spec unreadable',
    );
  });
  const spec = parseRenderSpec(specRaw);
  const generated = spec.shots.filter((shot) => !shot.videoPath);
  if (generated.length && (!resolved || !adapter)) {
    throw new VideoGenError(
      'Generated shots require a configured video model and provider.',
      'render: model missing',
    );
  }
  const caps = resolved?.entry.capabilities;

  // Containment must survive symlinks: compare REAL paths, not lexical
  // prefixes — a symlinked jobDir would otherwise let writes escape outputDir.
  const realOutput = await realpath(outputDir).catch(() => resolve(outputDir));
  const requestedJobDir = dirname(absSpecPath);
  const realJobDir = await realpath(requestedJobDir).catch(() => {
    throw new VideoGenError('The job directory does not exist.', 'render: job missing');
  });
  if (realJobDir !== realOutput && !realJobDir.startsWith(`${realOutput}${sep}`)) {
    throw new VideoGenError(
      'The job directory must live under the video-gen output directory (.video-gen). Move your render spec there.',
      'render: job outside outputDir',
    );
  }
  const jobId = basename(requestedJobDir);
  const jobDir = realJobDir;
  assertSafeId(jobId, 'job');
  if (basename(absSpecPath) !== 'render-input.json') {
    throw new VideoGenError(
      'The render spec file must be named render-input.json inside the job directory.',
      'render: spec name',
    );
  }

  // 2. capability preflight — fail BEFORE anything paid
  const degraded: string[] = [];
  const wantsLastFrame = generated.filter((s) => s.lastFramePath).map((s) => s.id);
  if (wantsLastFrame.length > 0 && !caps?.supportsFirstLastFrame) {
    if (opts.allowDegradations?.includes('first-frame-only')) {
      for (const shot of spec.shots) shot.lastFramePath = undefined;
      degraded.push(`first-frame-only (dropped last frames for: ${wantsLastFrame.join(', ')})`);
    } else {
      throw new VideoGenError(
        `Shots ${wantsLastFrame.join(', ')} request last-frame interpolation, but ${resolved?.entry.id} does not support it. Options: switch model (/video-gen models), remove lastFramePath from those shots, or explicitly pass allowDegradations: ["first-frame-only"].`,
        'render: flf unsupported',
      );
    }
  }
  if (spec.aspectRatio && caps && !caps.aspectRatios.includes(spec.aspectRatio)) {
    throw new VideoGenError(
      `aspectRatio must be one of ${caps.aspectRatios.join(', ')} for ${resolved?.entry.id} (got ${spec.aspectRatio}).`,
      'render: bad ratio',
    );
  }
  for (const shot of generated) {
    const referenceError = referenceAssetPreflightError({
      providerStyle: resolved!.provider.style,
      modelId: resolved!.entry.id,
      capabilities: caps!,
      referenceAssets: shot.referenceAssets ?? [],
      localImageReferences: (shot.firstFramePath ? 1 : 0) + (shot.lastFramePath ? 1 : 0),
    });
    if (referenceError) {
      throw new VideoGenError(`Shot "${shot.id}": ${referenceError}`, 'render: invalid references');
    }
    const d = shot.durationSec ?? resolved!.entry.defaultDurationSec;
    if (d < caps!.durations[0] || d > caps!.durations[1]) {
      throw new VideoGenError(
        `Shot "${shot.id}" durationSec ${d}s is outside ${caps!.durations[0]}-${caps!.durations[1]}s for ${resolved!.entry.id}.`,
        'render: bad duration',
      );
    }
  }
  for (const shot of spec.shots) {
    if (!shot.videoPath) continue;
    const source = await stat(resolve(cwd, shot.videoPath)).catch(() => null);
    if (!source?.isFile() || source.size === 0)
      throw new VideoGenError(
        `Local shot "${shot.id}" is missing or empty.`,
        'render: local source invalid',
      );
    if (opts.verifyMedia !== false) {
      const ffprobe = await resolveFfprobe(settings.ffmpegPath, opts.signal);
      if (!ffprobe.runnable)
        throw new VideoGenError(
          'ffprobe is required to validate existing video before model submission.',
          'render: ffprobe missing',
        );
      await probeStreams(ffprobe.path, resolve(cwd, shot.videoPath), opts.signal);
      await probeDuration(ffprobe.path, resolve(cwd, shot.videoPath), opts.signal);
    }
  }

  // Key the concurrency lock on the REAL path: two lexical aliases of the
  // same job directory must collide here, not run concurrently.
  const release = opts.activeJobs.acquire(realJobDir);
  try {
    // Validate the shared parent before creating per-shot directories. A
    // pre-placed `shots` symlink must not create `<outside>/<shotId>` first.
    const shotsDir = join(jobDir, 'shots');
    await mkdir(shotsDir, { recursive: true });
    const realShotsDir = await realpath(shotsDir);
    if (!realShotsDir.startsWith(`${realJobDir}${sep}`)) {
      throw new VideoGenError(
        'The shots directory resolves outside the job directory (symlink?). Remove it and retry.',
        'render: shots dir escapes',
      );
    }
    if (spec.assembly?.type === 'timeline') {
      const assemblyDir = join(jobDir, 'assembly');
      await mkdir(assemblyDir, { recursive: true });
      if (!(await realpath(assemblyDir)).startsWith(`${realJobDir}${sep}`))
        throw new VideoGenError(
          'Timeline assembly directory escapes the render job.',
          'render: assembly escape',
        );
    }
    const fingerprint = specFingerprint(specRaw, generated.length ? resolved : undefined);
    let manifest = loadRenderJob(jobDir);
    let remotionQc: Pick<RenderRunResult, 'qcFrames' | 'qcReportPath'> | undefined;

    if (manifest) {
      // 3a. resume: verify the whole input fingerprint before trusting anything
      if (manifest.specFingerprint !== fingerprint) {
        throw new VideoGenError(
          'render-input.json or the model/provider config changed since this job was created. Revisions require a NEW job directory (rerunning the same path only resumes identical input).',
          'render: spec drift',
        );
      }
      const expectedShotIds = spec.shots.map((shot) => shot.id);
      if (!sameKeys(Object.keys(manifest.shots), expectedShotIds)) {
        throw new VideoGenError(
          'manifest.json does not contain exactly the shots in render-input.json. Refusing to resume — a missing paid-task handle must never be recreated implicitly.',
          'render: manifest shot set mismatch',
        );
      }
      const expectedFrames = expectedSnapshotKeys(spec, cwd);
      if (!sameKeys(Object.keys(manifest.frameHashes), expectedFrames)) {
        throw new VideoGenError(
          'manifest.json does not contain exactly the expected frame snapshot hashes. Refusing to resume on unverified frames.',
          'render: frame hash set mismatch',
        );
      }
      for (const [relSnap, entry] of Object.entries(manifest.frameHashes)) {
        const snapPath = join(jobDir, relSnap);
        if (!existsSync(snapPath)) {
          throw new VideoGenError(
            `Frame snapshot missing: ${relSnap}. The job is incomplete; recreate it or start a new job.`,
            'render: snapshot missing',
          );
        }
        // The hash check alone is not enough: shots/<id> could have been
        // swapped for an external symlink carrying a same-hash plant. Verify
        // the RESOLVED snapshot is still inside the job.
        const realSnap = await realpath(snapPath);
        if (!realSnap.startsWith(`${realJobDir}${sep}`)) {
          throw new VideoGenError(
            `${relSnap} resolves outside the job directory (swapped symlink?). Refusing to resume.`,
            'render: snapshot escapes',
          );
        }
        const hash = sha256hex(await readFile(snapPath));
        if (hash !== entry) {
          throw new VideoGenError(
            `Frame snapshot ${relSnap} changed on disk — the frozen input is no longer trustworthy. Start a new job.`,
            'render: frame drift',
          );
        }
      }
      if (manifest.state === 'done') {
        if (!manifest.finalVideoHash || !manifest.finalVideoPath) {
          throw new VideoGenError(
            'Old completed render has no trustworthy final video hash. Compose its saved clips in a new job directory.',
            'render: legacy final unverifiable',
          );
        }
        const expectedFinal = join(
          jobDir,
          ...(spec.assembly ? ['assembly', 'final_video.mp4'] : ['final_video.mp4']),
        );
        if (manifest.finalVideoPath !== expectedFinal)
          throw new VideoGenError(
            'Completed render points to an unexpected final video path.',
            'render: final path drift',
          );
        const finalStat = await lstat(expectedFinal).catch(() => null);
        if (
          !finalStat?.isFile() ||
          finalStat.isSymbolicLink() ||
          !(await realpath(expectedFinal)).startsWith(`${realJobDir}${sep}`)
        )
          throw new VideoGenError(
            'Completed final video is not a regular file inside the job.',
            'render: final file escape',
          );
        const actual = await hashFileSha256(manifest.finalVideoPath).catch(() => null);
        if (!actual || actual !== manifest.finalVideoHash) {
          throw new VideoGenError(
            'Final video is missing or its hash changed. Refusing to reuse or silently rebuild it.',
            'render: final video drift',
          );
        }
        for (const [rel, expected] of Object.entries(manifest.qcHashes ?? {})) {
          const qcPath = join(jobDir, rel);
          const qcStat = await lstat(qcPath).catch(() => null);
          if (
            !qcStat?.isFile() ||
            qcStat.isSymbolicLink() ||
            !(await realpath(qcPath)).startsWith(`${realJobDir}${sep}`)
          )
            throw new VideoGenError(
              `QC artifact ${rel} is not a regular file inside the job.`,
              'render: qc escape',
            );
          const qc = await hashFileSha256(qcPath).catch(() => null);
          if (!qc || qc !== expected)
            throw new VideoGenError(
              `QC artifact ${rel} changed or is missing.`,
              'render: qc drift',
            );
        }
      }
      for (const shot of spec.shots) {
        const state = manifest.shots[shot.id];
        const storedVideo = join(realShotsDir, shot.id, 'video.mp4');
        if (state?.state === 'done') {
          const videoStat = await lstat(storedVideo).catch(() => null);
          if (
            (!videoStat && (shot.videoPath || manifest.state === 'done')) ||
            (videoStat &&
              (!videoStat.isFile() ||
                videoStat.isSymbolicLink() ||
                !(await realpath(storedVideo)).startsWith(`${realJobDir}${sep}`)))
          )
            throw new VideoGenError(
              `Shot "${shot.id}" video snapshot is missing or escapes the job.`,
              'render: shot video escape',
            );
        }
        if (shot.videoPath) {
          if (state?.source !== 'local')
            throw new VideoGenError(
              `Shot "${shot.id}" has no verified local source in the manifest.`,
              'render: local manifest drift',
            );
          const source = await hashFileSha256(resolve(cwd, shot.videoPath)).catch(() => null);
          const snap = await hashFileSha256(join(realShotsDir, shot.id, 'video.mp4')).catch(
            () => null,
          );
          if (!source || !snap || source !== state.localSourceHash || snap !== state.videoHash) {
            throw new VideoGenError(
              `Local shot "${shot.id}" changed or its snapshot is missing. Start a new job.`,
              'render: local shot drift',
            );
          }
        } else if (state?.source === 'local') {
          throw new VideoGenError(
            `Generated shot "${shot.id}" cannot use a local-only manifest entry.`,
            'render: generated source drift',
          );
        } else if (state?.state === 'done' && state.videoHash) {
          const snap = await hashFileSha256(join(realShotsDir, shot.id, 'video.mp4')).catch(
            () => null,
          );
          if (snap && snap !== state.videoHash)
            throw new VideoGenError(
              `Generated shot "${shot.id}" changed on disk.`,
              'render: generated shot drift',
            );
        }
      }
      const frozenAssemblyAssets = assemblySources(spec, cwd);
      if (
        spec.assembly &&
        (!manifest.assemblyAssetHashes ||
          !sameKeys(Object.keys(manifest.assemblyAssetHashes), Object.keys(frozenAssemblyAssets)))
      )
        throw new VideoGenError(
          'Assembly asset identities are missing from the render manifest.',
          'render: assembly assets missing',
        );
      for (const [id, path] of Object.entries(frozenAssemblyAssets)) {
        if ((await hashFileSha256(path).catch(() => null)) !== manifest.assemblyAssetHashes?.[id])
          throw new VideoGenError(
            `Assembly asset "${id}" changed since the paid input was frozen.`,
            'render: assembly asset drift',
          );
      }
      if (spec.assembly?.type === 'remotion') {
        if (!manifest.assemblyProjectHash || !opts.trusted)
          throw new VideoGenError(
            'Remotion assembly has no frozen trusted project identity.',
            'render: assembly identity',
          );
        const childSpec = readJsonFile<unknown>(join(jobDir, 'assembly', 'remotion-input.json'));
        if (!childSpec || JSON.stringify(childSpec) !== JSON.stringify(spec.assembly))
          throw new VideoGenError(
            'Remotion assembly input changed since the paid script was frozen.',
            'render: child spec drift',
          );
        const current = await runRemotion({
          specPath: join(jobDir, 'assembly', 'remotion-input.json'),
          cwd,
          settings,
          activeJobs: opts.activeJobs,
          trusted: true,
          preflight: true,
          ffmpegPath: opts.ffmpegPath,
        });
        if (current.projectHash !== manifest.assemblyProjectHash)
          throw new VideoGenError(
            'Remotion project changed since paid generation; use a new job.',
            'render: assembly drift',
          );
      }
      if (manifest.state === 'done') {
        if (spec.assembly?.type === 'remotion') {
          const assets = {
            ...spec.assembly.assets,
            ...Object.fromEntries(
              spec.shots.map((shot) => [shot.id, join(realShotsDir, shot.id, 'video.mp4')]),
            ),
          };
          const child = await runRemotion({
            specPath: join(jobDir, 'assembly', 'remotion-input.json'),
            cwd,
            settings,
            activeJobs: opts.activeJobs,
            trusted: Boolean(opts.trusted),
            frozenProjectHash: manifest.assemblyProjectHash,
            assets,
            ffmpegPath: opts.ffmpegPath,
            verifyOnly: true,
            signal: opts.signal,
          });
          remotionQc = { qcFrames: child.qcFrames, qcReportPath: child.qcReportPath };
        }
        if (spec.assembly) {
          if (spec.assembly.type === 'timeline')
            await runTimeline({
              timelineSpecPath: join(jobDir, 'assembly', 'timeline-input.json'),
              cwd: await realpath(cwd),
              settings,
              activeJobs: opts.activeJobs,
              signal: opts.signal,
            });
          const childPath =
            spec.assembly.type === 'remotion'
              ? join(jobDir, 'assembly', 'remotion-manifest.json')
              : join(jobDir, 'assembly', 'manifest.json');
          const child = readJsonFile<{
            kind?: string;
            state?: string;
            finalVideoPath?: string;
            finalVideoHash?: string;
          }>(childPath);
          if (
            !child ||
            child.finalVideoPath !== manifest.finalVideoPath ||
            child.finalVideoHash !== manifest.finalVideoHash ||
            (spec.assembly.type === 'timeline' && child.state !== 'done')
          )
            throw new VideoGenError(
              'Assembly child manifest does not match the completed render. Refusing to reuse.',
              'render: child manifest drift',
            );
        }
        return {
          jobId,
          finalVideoPath: manifest.finalVideoPath!,
          shotsDone: spec.shots.length,
          degraded,
          qcFrames: [
            ...Object.keys(manifest.qcHashes ?? {})
              .filter((name) => name.endsWith('.png'))
              .map((name) => join(jobDir, name)),
            ...(remotionQc?.qcFrames ?? []),
          ],
          qcReportPath: manifest.qcHashes?.[join('qc', 'report.json')]
            ? join(jobDir, 'qc', 'report.json')
            : undefined,
          editableProjectDir:
            spec.assembly?.type === 'remotion' ? spec.assembly.projectDir : undefined,
        };
      }
      opts.onUpdate?.(`Resuming job ${jobId} (fingerprint verified).`);
    } else {
      // 3b. fresh: snapshot frames into the job and freeze their hashes
      opts.onUpdate?.('Snapshotting frames into the job…');
      const frameHashes: Record<string, string> = {};
      const assets: Record<string, { sourcePath: string; snapshotPath: string; sha256: string }> =
        {};
      for (const shot of spec.shots) {
        const shotDir = join(realShotsDir, shot.id);
        await mkdir(shotDir, { recursive: true });
        const realShotDir = await realpath(shotDir);
        if (!realShotDir.startsWith(`${realJobDir}${sep}`)) {
          throw new VideoGenError(
            `shots/${shot.id} resolves outside the job directory (symlink?). Remove it and retry.`,
            'render: shot dir escapes',
          );
        }
        for (const kind of ['firstFrame', 'lastFrame'] as const) {
          const sourcePath = kind === 'firstFrame' ? shot.firstFramePath : shot.lastFramePath;
          if (!sourcePath) continue;
          const absSource = resolve(cwd, sourcePath);
          const frameBytes = await readApprovedFrame(absSource, cwd);
          const ext = extname(absSource) || '.png';
          const relSnap = join(
            'shots',
            shot.id,
            `${kind === 'firstFrame' ? 'first_frame' : 'last_frame'}${ext}`,
          );
          const destPath = join(jobDir, relSnap);
          // copyFile FOLLOWS destination symlinks — a pre-placed link would
          // overwrite an arbitrary file outside the job. Refuse non-files.
          const destStat = await lstat(destPath).catch(() => null);
          if (destStat && (destStat.isSymbolicLink() || !destStat.isFile())) {
            throw new VideoGenError(
              `Refusing to write ${relSnap} — it already exists and is not a regular file (symlink?). Remove it and retry.`,
              'render: snapshot destination not a file',
            );
          }
          // Write to an EXCLUSIVELY-created sibling temp, then
          // atomic rename(2), which replaces the destination entry outright.
          let tmpSnap = '';
          for (let i = 0; ; i++) {
            const candidate = `${destPath}.tmp-${process.pid}-${snapshotCounter++}-${i}`;
            try {
              await writeFile(candidate, frameBytes, { flag: 'wx' });
              tmpSnap = candidate;
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new VideoGenError(
                  `Shot "${shot.id}" ${kind} not readable: ${safeBasename(sourcePath)}. Use the absolute path returned by image_generate.`,
                  'render: frame unreadable',
                );
              }
              throw error;
            }
          }
          await rename(tmpSnap, destPath);
          // Hash the SNAPSHOT bytes (what we will actually submit) — hashing a
          // pre-copy read of the source would race concurrent source rewrites.
          const hash = sha256hex(await readFile(destPath));
          frameHashes[relSnap] = hash;
          assets[`${shot.id}/${kind}`] = {
            sourcePath: absSource,
            snapshotPath: relSnap,
            sha256: hash,
          };
        }
      }
      // Merge, don't overwrite: the image stage already registered portraits
      // and other semantic assets in assets.json — our frame snapshots are
      // added. STRICT read: corrupted/unreadable assets.json refuses rather
      // than being truncated to an empty index.
      const assetsDoc = readJsonFile<unknown>(join(jobDir, 'assets.json'));
      // File ABSENT is fine (first run). File PRESENT but not a plain object —
      // or with an "assets" field that is not a plain object — is corruption:
      // refuse rather than truncate the image stage's index.
      const assetsField = (assetsDoc as { assets?: unknown } | undefined)?.assets;
      const docInvalid =
        assetsDoc !== undefined &&
        (typeof assetsDoc !== 'object' ||
          assetsDoc === null ||
          Array.isArray(assetsDoc) ||
          (assetsField !== undefined &&
            (typeof assetsField !== 'object' ||
              assetsField === null ||
              Array.isArray(assetsField))));
      if (docInvalid) {
        throw new VideoGenError(
          'assets.json is not a valid asset index (root must be an object, "assets" must be an object). Fix or remove it — refusing to overwrite.',
          'render: assets shape invalid',
        );
      }
      const existingAssets = (assetsField ?? {}) as Record<string, unknown>;
      writeJsonAtomic(join(jobDir, 'assets.json'), {
        assets: { ...existingAssets, ...assets },
        updatedAt: new Date().toISOString(),
      });
      const assemblyAssetHashes: Record<string, string> = {};
      for (const [id, path] of Object.entries(assemblySources(spec, cwd))) {
        if (!(await stat(path).catch(() => null))?.isFile())
          throw new VideoGenError(
            `Assembly asset "${id}" is missing.`,
            'render: assembly asset missing',
          );
        if (opts.verifyMedia !== false && /\.(mp4|mov|webm|m4v)$/i.test(path)) {
          const ffprobe = await resolveFfprobe(settings.ffmpegPath, opts.signal);
          if (!ffprobe.runnable)
            throw new VideoGenError(
              'ffprobe is required to validate existing assembly video.',
              'render: ffprobe missing',
            );
          await probeStreams(ffprobe.path, path, opts.signal);
          await probeDuration(ffprobe.path, path, opts.signal);
        }
        assemblyAssetHashes[id] = await hashFileSha256(path);
      }
      let assemblyProjectHash: string | undefined;
      if (spec.assembly?.type === 'remotion') {
        if (!opts.trusted)
          throw new VideoGenError(
            'Remotion assembly requires a trusted project.',
            'render: untrusted assembly',
          );
        const assets = {
          ...spec.assembly.assets,
          ...Object.fromEntries(
            spec.shots.map((shot) => [
              shot.id,
              shot.videoPath
                ? resolve(cwd, shot.videoPath)
                : join(realShotsDir, shot.id, 'video.mp4'),
            ]),
          ),
        };
        assemblyProjectHash = await preflightRemotion({
          spec: spec.assembly as RemotionSpec,
          cwd,
          jobDir,
          outputDir,
          assets,
          shotIds: spec.shots.map((shot) => shot.id),
          ffmpegPath: opts.ffmpegPath,
          signal: opts.signal,
        });
        writeJsonAtomic(join(jobDir, 'assembly', 'remotion-input.json'), spec.assembly);
      }
      if (spec.assembly?.type === 'timeline') {
        const timelineInput = spec.assembly.timeline;
        const mapped = timelineWithShotPaths(timelineInput, realShotsDir);
        assertNarrationOptIn(parseTimelineSpec(JSON.stringify(mapped)));
        if (opts.verifyMedia !== false) {
          if (!(await resolveFfprobe(settings.ffmpegPath, opts.signal)).runnable)
            throw new VideoGenError(
              'Timeline assembly needs ffprobe before model submission.',
              'render: timeline ffprobe missing',
            );
          if (
            timelineInput.output?.codec === 'h264' &&
            !(await resolveGplFfmpeg(settings.ffmpegPath, opts.signal)).runnable
          )
            throw new VideoGenError(
              'H.264 timeline assembly needs an ffmpeg build with libx264.',
              'render: timeline encoder missing',
            );
          const visibleText = timelineInput.segments
            .map(
              (segment) =>
                `${segment.overlay?.title ?? ''}${segment.overlay?.subtitle ?? ''}${timelineInput.subtitles?.mode === 'burn' ? (segment.narration ?? '') : ''}`,
            )
            .join('');
          if (/\p{Script=Han}/u.test(visibleText) && !(await hasCjkFont(opts.signal)))
            throw new VideoGenError(
              'Timeline assembly needs a CJK font for its text overlays.',
              'render: timeline CJK font missing',
            );
        }
      }
      manifest = {
        jobId,
        kind: 'render',
        state: 'rendering',
        specFingerprint: fingerprint,
        frameHashes,
        assemblyProjectHash,
        assemblyAssetHashes: spec.assembly ? assemblyAssetHashes : undefined,
        shots: Object.fromEntries(spec.shots.map((s) => [s.id, { state: 'pending' as const }])),
        updatedAt: new Date().toISOString(),
      };
      for (const shot of spec.shots) {
        if (!shot.videoPath) continue;
        const sourcePath = resolve(cwd, shot.videoPath);
        const sourceStat = await stat(sourcePath).catch(() => null);
        if (!sourceStat?.isFile() || sourceStat.size === 0)
          throw new VideoGenError(
            `Local shot "${shot.id}" is not a readable video file.`,
            'render: local source invalid',
          );
        const videoPath = join(realShotsDir, shot.id, 'video.mp4');
        const existing = await lstat(videoPath).catch(() => null);
        if (existing && !existing.isFile())
          throw new VideoGenError(
            `Local shot "${shot.id}" snapshot path is not a regular file.`,
            'render: local destination invalid',
          );
        const temp = `${videoPath}.tmp-${randomUUID()}`;
        await copyFile(sourcePath, temp, COPYFILE_EXCL);
        await rename(temp, videoPath);
        const localSourceHash = await hashFileSha256(sourcePath);
        const videoHash = await hashFileSha256(videoPath);
        if (localSourceHash !== videoHash)
          throw new VideoGenError(
            `Local shot "${shot.id}" changed while being copied. Start a new job.`,
            'render: source race',
          );
        manifest.shots[shot.id] = {
          state: 'done',
          source: 'local',
          videoPath,
          localSourceHash,
          videoHash,
        };
      }
      saveRenderJob(jobDir, manifest);
    }

    // 4. per-shot render loop (resume-aware)
    const concat = opts.concatImpl ?? concatVideos;
    const renderShot = async (shot: RenderShotInput): Promise<void> => {
      const shotState = manifest!.shots[shot.id]!;
      const videoPath = join(realShotsDir, shot.id, 'video.mp4');
      if (shot.videoPath) return;
      if (shotState.state === 'done' && existsSync(videoPath)) return;

      const firstSnap = shot.firstFramePath
        ? join(jobDir, 'shots', shot.id, `first_frame${pickExt(manifest!, shot.id, 'firstFrame')}`)
        : undefined;
      const lastSnap = shot.lastFramePath
        ? join(jobDir, 'shots', shot.id, `last_frame${pickExt(manifest!, shot.id, 'lastFrame')}`)
        : undefined;
      const attempt = shotState.attempt ?? 1;
      const params: GenerateVideoParams = {
        prompt: assemblePrompt(spec, shot.prompt!),
        requestId: `${jobId}:${shot.id}:${attempt}`,
        firstFramePath: firstSnap,
        lastFramePath: lastSnap,
        referenceAssets: shot.referenceAssets,
        durationSec: shot.durationSec ?? resolved!.entry.defaultDurationSec,
        aspectRatio: spec.aspectRatio ?? resolved!.entry.defaultAspectRatio,
        resolution: resolved!.entry.defaultResolution,
        generateAudio: caps!.nativeAudio,
      };
      let activeFingerprint = requestFingerprint(resolved!.remoteId, params);

      // A previously ambiguous submit must NEVER auto-resubmit: a paid task
      // may exist. Block the whole run until the user resolves it through the
      // locked /video-gen recover reset/adopt paths.
      if (shotState.state === 'ambiguous') {
        throw new VideoGenError(
          `Shot "${shot.id}" had an ambiguous submit — a paid task MAY exist on the provider. Check the provider console, then run /video-gen recover ${jobId} ${shot.id} reset if no task exists, or /video-gen recover ${jobId} ${shot.id} adopt <taskId> to resume an existing task.`,
          'render: ambiguous shot',
        );
      }

      let handle: RemoteTaskHandle | undefined = shotState.handle;
      let currentAttempt = shotState.attempt;
      if (
        handle &&
        shotState.requestFingerprint !== 'manual-adopt' &&
        shotState.requestFingerprint !== activeFingerprint
      ) {
        throw new VideoGenError(
          `Shot "${shot.id}" has a task handle that does not match its frozen request fingerprint. Refusing to poll it.`,
          'render: handle fingerprint mismatch',
        );
      }
      if (!handle) {
        currentAttempt = (currentAttempt ?? 0) + 1;
        params.requestId = `${jobId}:${shot.id}:${currentAttempt}`;
        const submittedFingerprint = requestFingerprint(resolved!.remoteId, params);
        activeFingerprint = submittedFingerprint;
        await opts.rateLimiter.acquire(opts.signal);
        opts.onUpdate?.(`Shot ${shot.id}: submitting…`);
        // Crash-safe paid boundary: until a handle is durably persisted, the
        // only honest state is "a remote task may exist".
        manifest!.shots[shot.id] = {
          state: 'ambiguous',
          attempt: currentAttempt,
          requestFingerprint: submittedFingerprint,
        };
        saveRenderJob(jobDir, manifest!);
        try {
          handle = await adapter!.submit(
            resolved!.provider,
            resolved!.remoteId,
            params,
            fetch,
            opts.signal,
          );
        } catch (error) {
          manifest!.shots[shot.id] = {
            state: error instanceof AmbiguousSubmitError ? 'ambiguous' : 'failed',
            attempt: currentAttempt,
            requestFingerprint: submittedFingerprint,
            error: toLogSummary(error),
          };
          saveRenderJob(jobDir, manifest!);
          throw error;
        }
        manifest!.shots[shot.id] = {
          state: 'submitted',
          attempt: currentAttempt,
          handle,
          requestFingerprint: submittedFingerprint,
        };
        saveRenderJob(jobDir, manifest!);
      }

      opts.onUpdate?.(`Shot ${shot.id}: polling task ${handle.taskId}…`);
      const succeeded = await pollTask({
        check: () => adapter!.inspect(resolved!.provider, handle!, fetch, opts.signal),
        signal: opts.signal,
      }).catch((error: unknown) => {
        if (error instanceof RemoteTaskNotFoundError) {
          manifest!.shots[shot.id] = {
            state: 'ambiguous',
            attempt: currentAttempt,
            handle,
            requestFingerprint: shotState.requestFingerprint ?? activeFingerprint,
            error: toLogSummary(error),
          };
          saveRenderJob(jobDir, manifest!);
          throw new VideoGenError(
            `Shot "${shot.id}" is no longer found by the provider. Check the provider console, then run /video-gen recover ${jobId} ${shot.id} reset if the task is gone, or adopt its current task id.`,
            toLogSummary(error),
          );
        }
        if (error instanceof RemoteTaskFailedError) {
          manifest!.shots[shot.id] = {
            state: 'failed',
            attempt: currentAttempt,
            error:
              error instanceof RemoteTaskFailedError ? error.providerMessage : toLogSummary(error),
          };
          saveRenderJob(jobDir, manifest!);
        }
        throw error;
      });
      opts.onUpdate?.(`Shot ${shot.id}: downloading…`);
      await adapter!.downloadTo(
        resolved!.provider,
        handle,
        succeeded.videoUrl,
        videoPath,
        fetch,
        opts.signal,
      );
      const videoHash = await hashFileSha256(videoPath);
      if (shotState.state === 'done' && shotState.videoHash && videoHash !== shotState.videoHash)
        throw new VideoGenError(
          `Recovered video for shot "${shot.id}" does not match its previously frozen hash.`,
          'render: recovered shot drift',
        );
      manifest!.shots[shot.id] = {
        state: 'done',
        attempt: currentAttempt,
        handle,
        requestFingerprint: shotState.requestFingerprint ?? activeFingerprint,
        videoPath,
        videoHash,
      };
      saveRenderJob(jobDir, manifest!);
      opts.onUpdate?.(`Shot ${shot.id}: done.`);
    };

    try {
      await runPool(spec.shots, opts.settings.concurrency?.clips ?? 2, renderShot);
    } catch (error) {
      if (error instanceof CancelledError || opts.signal?.aborted) {
        let cancelledRemotely = 0;
        for (const [shotId, shotState] of Object.entries(manifest.shots)) {
          if (!shotState.handle || shotState.state === 'done') continue;
          let cancelled = false;
          if (adapter?.cancel && resolved) {
            try {
              cancelled = (
                await adapter.cancel(
                  resolved.provider,
                  shotState.handle,
                  fetch,
                  AbortSignal.timeout(10_000),
                )
              ).cancelled;
            } catch {
              console.error('[pi-video-gen] remote cancel failed');
            }
          }
          if (cancelled) {
            cancelledRemotely++;
            manifest.shots[shotId] = {
              state: 'failed',
              attempt: shotState.attempt,
              error: 'cancelled remotely',
            };
          } else {
            manifest.shots[shotId] = { ...shotState, state: 'polling_stopped' };
          }
        }
        saveRenderJob(jobDir, { ...manifest, state: 'polling_stopped' });
        throw new VideoGenError(
          cancelledRemotely > 0
            ? `Stopped locally and cancelled ${cancelledRemotely} remote task(s). Any remaining tasks may still be running and billable; rerun the same render-input.json to resume them.`
            : `Stopped locally. Remote tasks may still be running and billable. Rerun the same render-input.json to resume after they finish.`,
          'render: polling_stopped',
        );
      }
      saveRenderJob(jobDir, { ...manifest, state: 'failed', error: toLogSummary(error) });
      throw error;
    }

    // 5. concat
    const shotMedia: {
      id: string;
      durationSec: number;
      videoCodec: string;
      audioLayout: string;
    }[] = [];
    if (opts.verifyMedia !== false) {
      const ffprobe = await resolveFfprobe(settings.ffmpegPath, opts.signal);
      if (!ffprobe.runnable)
        throw new VideoGenError(
          'ffprobe is required to verify downloaded shot media.',
          'render: ffprobe missing',
        );
      for (const shot of spec.shots) {
        const path = join(realShotsDir, shot.id, 'video.mp4');
        const streams = await probeStreams(ffprobe.path, path, opts.signal);
        const durationSec = await probeDuration(ffprobe.path, path, opts.signal);
        shotMedia.push({
          id: shot.id,
          durationSec,
          videoCodec: streams.videoCodec,
          audioLayout: streams.audioLayout,
        });
      }
    }
    manifest.state = 'concatenating';
    saveRenderJob(jobDir, manifest);
    const inputs = spec.shots.map((s) => join(realShotsDir, s.id, 'video.mp4'));
    let finalVideoPath = join(jobDir, 'final_video.mp4');
    let remotionShotTimes: Record<string, number> | undefined;
    opts.onUpdate?.(`Assembling ${inputs.length} clips…`);
    try {
      if (spec.assembly?.type === 'remotion') {
        const assets = {
          ...spec.assembly.assets,
          ...Object.fromEntries(spec.shots.map((shot, index) => [shot.id, inputs[index]!])),
        };
        const child = await runRemotion({
          specPath: join(jobDir, 'assembly', 'remotion-input.json'),
          cwd,
          settings,
          activeJobs: opts.activeJobs,
          trusted: Boolean(opts.trusted),
          frozenProjectHash: manifest.assemblyProjectHash,
          assets,
          shotIds: spec.shots.map((shot) => shot.id),
          ffmpegPath: opts.ffmpegPath,
          signal: opts.signal,
        });
        finalVideoPath = child.finalVideoPath;
        remotionShotTimes = child.shotTimesSec;
        remotionQc = { qcFrames: child.qcFrames, qcReportPath: child.qcReportPath };
      } else if (spec.assembly?.type === 'timeline') {
        const assemblyDir = join(jobDir, 'assembly');
        await mkdir(assemblyDir, { recursive: true });
        if (!(await realpath(assemblyDir)).startsWith(`${realJobDir}${sep}`))
          throw new VideoGenError(
            'Timeline assembly directory escapes the render job.',
            'render: assembly escape',
          );
        const timeline = timelineWithShotPaths(spec.assembly.timeline, realShotsDir);
        const timelinePath = join(assemblyDir, 'timeline-input.json');
        writeJsonAtomic(timelinePath, timeline);
        const child = await runTimeline({
          timelineSpecPath: timelinePath,
          cwd: await realpath(cwd),
          settings,
          activeJobs: opts.activeJobs,
          signal: opts.signal,
        });
        finalVideoPath = child.finalVideoPath;
      } else {
        await concat({
          inputs,
          outputPath: finalVideoPath,
          ffmpegPath: opts.ffmpegPath,
          signal: opts.signal,
        });
      }
    } catch (error) {
      const cancelled = error instanceof CancelledError || opts.signal?.aborted;
      saveRenderJob(jobDir, {
        ...manifest,
        state: cancelled ? 'polling_stopped' : 'failed',
        error: toLogSummary(error),
      });
      throw error;
    }

    if (opts.verifyMedia !== false) {
      const ffprobe = await resolveFfprobe(settings.ffmpegPath, opts.signal);
      const finalStreams = await probeStreams(ffprobe.path, finalVideoPath, opts.signal);
      const finalDurationSec = await probeDuration(ffprobe.path, finalVideoPath, opts.signal);
      if (
        !spec.assembly &&
        Math.abs(finalDurationSec - shotMedia.reduce((sum, item) => sum + item.durationSec, 0)) > 1
      )
        throw new VideoGenError(
          'QC: final duration differs from the sum of shot durations by more than 1s.',
          'render: duration qc',
        );
      if (
        !spec.assembly &&
        shotMedia.some((item) => item.audioLayout !== 'none') &&
        finalStreams.audioLayout === 'none'
      )
        throw new VideoGenError('QC: final video lost the source audio track.', 'render: audio qc');
      const qcDir = join(jobDir, 'qc');
      await mkdir(qcDir, { recursive: true });
      const realQc = await realpath(qcDir);
      if (!realQc.startsWith(`${realJobDir}${sep}`))
        throw new VideoGenError('QC directory escapes the render job.', 'render: qc escape');
      const qcHashes: Record<string, string> = {};
      const finalSamples: { timeSec: number; path: string }[] = [];
      if (spec.assembly?.type === 'timeline') {
        const child = loadTimelineJob(join(jobDir, 'assembly'));
        if (!child || child.state !== 'done')
          throw new VideoGenError(
            'Timeline assembly has no completed manifest.',
            'render: timeline qc',
          );
        let cursor = 0;
        for (const [index, segment] of spec.assembly.timeline.segments.entries()) {
          const duration = child.segments[segment.id]?.resolvedDurationSec;
          const visible = (duration ?? 0) - (segment.transitionTo?.durationSec ?? 0);
          if (!Number.isFinite(visible) || visible <= 0)
            throw new VideoGenError(
              `Timeline segment ${segment.id} has no valid duration.`,
              'render: timeline qc',
            );
          finalSamples.push({
            timeSec: cursor + visible / 2,
            path: join('qc', `final_part_${index + 1}.png`),
          });
          cursor += visible;
        }
      } else if (spec.assembly?.type === 'remotion') {
        for (const [index, shot] of spec.shots.entries()) {
          const timeSec = remotionShotTimes?.[shot.id];
          if (
            timeSec === undefined ||
            !Number.isFinite(timeSec) ||
            timeSec < 0 ||
            timeSec >= finalDurationSec
          )
            throw new VideoGenError(
              `Remotion has no valid timing for shot ${shot.id}.`,
              'render: remotion qc',
            );
          finalSamples.push({ timeSec, path: join('qc', `final_part_${index + 1}.png`) });
        }
      } else {
        let cursor = 0;
        for (const [index, shot] of shotMedia.entries()) {
          finalSamples.push({
            timeSec: cursor + shot.durationSec / 2,
            path: join('qc', `final_part_${index + 1}.png`),
          });
          cursor += shot.durationSec;
        }
      }
      const samples = [
        ...shotMedia.map((shot) => ({
          timeSec: shot.durationSec / 2,
          path: join('qc', `shot_${shot.id}.png`),
          video: join(realShotsDir, shot.id, 'video.mp4'),
        })),
        ...finalSamples.map((sample) => ({ ...sample, video: finalVideoPath })),
      ];
      for (const { timeSec, path: rel, video } of samples) {
        const dest = join(jobDir, rel);
        const temp = `${dest}.${randomUUID()}.png`;
        await runFfmpegCommand(
          opts.ffmpegPath,
          ['-ss', timeSec.toFixed(3), '-i', video, '-frames:v', '1', '-n', temp],
          opts.signal,
        );
        await rename(temp, dest);
        qcHashes[rel] = await hashFileSha256(dest, opts.signal);
      }
      const reportPath = join(qcDir, 'report.json');
      writeJsonAtomic(reportPath, {
        shots: shotMedia,
        ...(remotionQc ? { remotion: remotionQc } : {}),
        final: {
          durationSec: finalDurationSec,
          videoCodec: finalStreams.videoCodec,
          audioLayout: finalStreams.audioLayout,
          samples: finalSamples,
        },
      });
      qcHashes[join('qc', 'report.json')] = await hashFileSha256(reportPath, opts.signal);
      manifest.qcHashes = qcHashes;
    }
    manifest.state = 'done';
    manifest.finalVideoPath = finalVideoPath;
    manifest.finalVideoHash = await hashFileSha256(finalVideoPath);
    saveRenderJob(jobDir, manifest);
    return {
      jobId,
      finalVideoPath,
      shotsDone: spec.shots.length,
      degraded,
      qcFrames: [
        ...Object.keys(manifest.qcHashes ?? {})
          .filter((name) => name.endsWith('.png'))
          .map((name) => join(jobDir, name)),
        ...(remotionQc?.qcFrames ?? []),
      ],
      qcReportPath: manifest.qcHashes?.[join('qc', 'report.json')]
        ? join(jobDir, 'qc', 'report.json')
        : undefined,
      editableProjectDir: spec.assembly?.type === 'remotion' ? spec.assembly.projectDir : undefined,
    };
  } finally {
    release();
  }
}

/** Recover a snapshot's extension from the manifest's frameHashes (defaults to .png). */
function pickExt(
  manifest: RenderJobManifest,
  shotId: string,
  kind: 'firstFrame' | 'lastFrame',
): string {
  const prefix = join('shots', shotId, kind === 'firstFrame' ? 'first_frame' : 'last_frame');
  for (const relSnap of Object.keys(manifest.frameHashes)) {
    if (relSnap.startsWith(prefix)) return relSnap.slice(prefix.length);
  }
  return '.png';
}

export { errorMessageForUser };
