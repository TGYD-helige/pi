import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
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
import { concatVideos } from './ffmpeg.js';
import { readApprovedFrame } from './frame-input.js';
import {
  type ActiveJobs,
  assertSafeId,
  loadRenderJob,
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
  prompt: ShotPrompt;
  firstFramePath?: string | undefined;
  lastFramePath?: string | undefined;
  referenceAssets?: ReferenceAsset[] | undefined;
  durationSec?: number | undefined;
};

export type RenderInput = FilmPrompt & {
  title?: string | undefined;
  aspectRatio?: string | undefined;
  shots: RenderShotInput[];
};

export type RenderRunResult = {
  jobId: string;
  finalVideoPath: string;
  shotsDone: number;
  degraded: string[];
};

let snapshotCounter = 0;

function sha256hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function specFingerprint(specRaw: string, resolved: ResolvedModel): string {
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

/** Manual validation with agent-fixable error messages (better than a schema dump). */
function parseRenderSpec(raw: string): RenderInput {
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
  resolved: ResolvedModel;
  adapter: VideoProviderAdapter;
  activeJobs: ActiveJobs;
  rateLimiter: RateLimiter;
  ffmpegPath: string;
  signal?: AbortSignal | undefined;
  onUpdate?: ((msg: string) => void) | undefined;
  concatImpl?: typeof concatVideos | undefined;
}): Promise<RenderRunResult> {
  const { settings, cwd, resolved, adapter } = opts;
  const caps = resolved.entry.capabilities;
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
  const wantsLastFrame = spec.shots.filter((s) => s.lastFramePath).map((s) => s.id);
  if (wantsLastFrame.length > 0 && !caps.supportsFirstLastFrame) {
    if (opts.allowDegradations?.includes('first-frame-only')) {
      for (const shot of spec.shots) shot.lastFramePath = undefined;
      degraded.push(`first-frame-only (dropped last frames for: ${wantsLastFrame.join(', ')})`);
    } else {
      throw new VideoGenError(
        `Shots ${wantsLastFrame.join(', ')} request last-frame interpolation, but ${resolved.entry.id} does not support it. Options: switch model (/video-gen models), remove lastFramePath from those shots, or explicitly pass allowDegradations: ["first-frame-only"].`,
        'render: flf unsupported',
      );
    }
  }
  if (spec.aspectRatio && !caps.aspectRatios.includes(spec.aspectRatio)) {
    throw new VideoGenError(
      `aspectRatio must be one of ${caps.aspectRatios.join(', ')} for ${resolved.entry.id} (got ${spec.aspectRatio}).`,
      'render: bad ratio',
    );
  }
  for (const shot of spec.shots) {
    const referenceError = referenceAssetPreflightError({
      providerStyle: resolved.provider.style,
      modelId: resolved.entry.id,
      capabilities: caps,
      referenceAssets: shot.referenceAssets ?? [],
      localImageReferences: (shot.firstFramePath ? 1 : 0) + (shot.lastFramePath ? 1 : 0),
    });
    if (referenceError) {
      throw new VideoGenError(`Shot "${shot.id}": ${referenceError}`, 'render: invalid references');
    }
    const d = shot.durationSec ?? resolved.entry.defaultDurationSec;
    if (d < caps.durations[0] || d > caps.durations[1]) {
      throw new VideoGenError(
        `Shot "${shot.id}" durationSec ${d}s is outside ${caps.durations[0]}-${caps.durations[1]}s for ${resolved.entry.id}.`,
        'render: bad duration',
      );
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
    const fingerprint = specFingerprint(specRaw, resolved);
    let manifest = loadRenderJob(jobDir);

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
      manifest = {
        jobId,
        kind: 'render',
        state: 'rendering',
        specFingerprint: fingerprint,
        frameHashes,
        shots: Object.fromEntries(spec.shots.map((s) => [s.id, { state: 'pending' as const }])),
        updatedAt: new Date().toISOString(),
      };
      saveRenderJob(jobDir, manifest);
    }

    // 4. per-shot render loop (resume-aware)
    const concat = opts.concatImpl ?? concatVideos;
    const renderShot = async (shot: RenderShotInput): Promise<void> => {
      const shotState = manifest!.shots[shot.id]!;
      const videoPath = join(realShotsDir, shot.id, 'video.mp4');
      if (shotState.state === 'done' && existsSync(videoPath)) return;

      const firstSnap = shot.firstFramePath
        ? join(jobDir, 'shots', shot.id, `first_frame${pickExt(manifest!, shot.id, 'firstFrame')}`)
        : undefined;
      const lastSnap = shot.lastFramePath
        ? join(jobDir, 'shots', shot.id, `last_frame${pickExt(manifest!, shot.id, 'lastFrame')}`)
        : undefined;
      const attempt = shotState.attempt ?? 1;
      const params: GenerateVideoParams = {
        prompt: assemblePrompt(spec, shot.prompt),
        requestId: `${jobId}:${shot.id}:${attempt}`,
        firstFramePath: firstSnap,
        lastFramePath: lastSnap,
        referenceAssets: shot.referenceAssets,
        durationSec: shot.durationSec ?? resolved.entry.defaultDurationSec,
        aspectRatio: spec.aspectRatio ?? resolved.entry.defaultAspectRatio,
        resolution: resolved.entry.defaultResolution,
        generateAudio: caps.nativeAudio,
      };
      let activeFingerprint = requestFingerprint(resolved.remoteId, params);

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
        const submittedFingerprint = requestFingerprint(resolved.remoteId, params);
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
          handle = await adapter.submit(
            resolved.provider,
            resolved.remoteId,
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
        check: () => adapter.inspect(resolved.provider, handle!, fetch, opts.signal),
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
      await adapter.downloadTo(
        resolved.provider,
        handle,
        succeeded.videoUrl,
        videoPath,
        fetch,
        opts.signal,
      );
      manifest!.shots[shot.id] = {
        state: 'done',
        attempt: currentAttempt,
        handle,
        requestFingerprint: shotState.requestFingerprint ?? activeFingerprint,
        videoPath,
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
          if (adapter.cancel) {
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
    manifest.state = 'concatenating';
    saveRenderJob(jobDir, manifest);
    const inputs = spec.shots.map((s) => join(realShotsDir, s.id, 'video.mp4'));
    const finalVideoPath = join(jobDir, 'final_video.mp4');
    opts.onUpdate?.(`Concatenating ${inputs.length} clips…`);
    try {
      await concat({
        inputs,
        outputPath: finalVideoPath,
        ffmpegPath: opts.ffmpegPath,
        signal: opts.signal,
      });
    } catch (error) {
      const cancelled = error instanceof CancelledError || opts.signal?.aborted;
      saveRenderJob(jobDir, {
        ...manifest,
        state: cancelled ? 'polling_stopped' : 'failed',
        error: toLogSummary(error),
      });
      throw error;
    }

    manifest.state = 'done';
    manifest.finalVideoPath = finalVideoPath;
    saveRenderJob(jobDir, manifest);
    return { jobId, finalVideoPath, shotsDone: spec.shots.length, degraded };
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
