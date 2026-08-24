import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open, readFile, rename } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import { StringEnum } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { runCompose } from './compose.js';
import {
  DEFAULT_VIDEO_MODEL_ID,
  listModelRegistry,
  loadVideoGenSettings,
  resolveModel,
  resolveOutputDir,
} from './config.js';
import {
  AmbiguousSubmitError,
  errorMessageForUser,
  missingKeyError,
  providerLabel,
  RemoteTaskFailedError,
  RemoteTaskNotFoundError,
  redactUrl,
  toLogSummary,
} from './errors.js';
import { resolveFfmpeg, resolveFfprobe, resolveGplFfmpeg } from './ffmpeg.js';
import { readApprovedFrame } from './frame-input.js';
import {
  ActiveJobs,
  assertSafeId,
  ensureSingleJobDir,
  loadRenderJob,
  loadSingleJob,
  newJobId,
  readJsonFile,
  resolveJobDirInsideOutput,
  type SingleJobManifest,
  saveRenderJob,
  saveSingleJob,
  singleJobDir,
  writeJsonAtomic,
} from './jobs/store.js';
import { assemblePrompt, validateFilmPrompt, validateShotPrompt } from './prompt.js';
import { arkAdapter } from './providers/ark.js';
import { dashscopeAdapter } from './providers/dashscope.js';
import { klingAdapter } from './providers/kling.js';
import { minimaxAdapter } from './providers/minimax.js';
import { newapiAdapter } from './providers/newapi.js';
import { openrouterAdapter } from './providers/openrouter.js';
import {
  normalizeReferenceAssets,
  referenceAssetPreflightError,
  requestFingerprint,
} from './providers/request.js';
import { CancelledError, pollTask, RateLimiter } from './providers/task.js';
import { runRender } from './render.js';
import { hasCjkFont } from './text-layer.js';
import { runTimeline } from './timeline-render.js';
import type {
  FilmPrompt,
  GenerateVideoParams,
  ReferenceAsset,
  RemoteTaskHandle,
  ResolvedProvider,
  ShotPrompt,
  VideoApiStyle,
  VideoGenSettings,
  VideoModelCapabilities,
  VideoProviderAdapter,
} from './types.js';

/** Registered provider wire adapters. */
const ADAPTERS: Partial<Record<VideoApiStyle, VideoProviderAdapter>> = {
  ark: arkAdapter,
  dashscope: dashscopeAdapter,
  kling: klingAdapter,
  minimax: minimaxAdapter,
  newapi: newapiAdapter,
  openrouter: openrouterAdapter,
};

const ENV_VAR_BY_STYLE: Record<VideoApiStyle, string> = {
  ark: 'ARK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  kling: 'KLING_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  newapi: 'NEWAPI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

type TextResult = {
  isError?: true;
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
};

function okResult(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: 'text', text: boundToolText(text) }], details: boundDetails(details) };
}

function errResult(text: string, details: Record<string, unknown> = {}): TextResult {
  return {
    isError: true,
    content: [{ type: 'text', text: boundToolText(text) }],
    details: boundDetails(details),
  };
}

function boundToolText(text: string): string {
  const result = truncateHead(text, { maxBytes: 47 * 1024, maxLines: 1_900 });
  return result.truncated ? `${result.content}\n\n[pi-video-gen output truncated]` : result.content;
}

function boundDetails(details: Record<string, unknown>): Record<string, unknown> {
  try {
    return Buffer.byteLength(JSON.stringify(details), 'utf-8') <= 2 * 1024
      ? details
      : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

/**
 * Parse `--key value` / `--key "quoted value"` flags for `/video-gen generate`.
 * Quoted values may escape their delimiter quote (and backslash) with `\`.
 */
function parseGenerateFlags(text: string): { flags: Record<string, string> } | { error: string } {
  const flags: Record<string, string> = {};
  const re = /--([a-z][a-z-]*)\s+("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g;
  let covered = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const gap = text.slice(covered, m.index).trim();
    if (gap !== '') {
      return { error: `Unrecognized text "${gap}" — use --key "value" flags.` };
    }
    const quoted = m[3] ?? m[4];
    const bare = m[5];
    // A bare value starting with a quote char means an unterminated quote — the
    // quoted alternative needed a closer, so `--visuals "wide` must not slide
    // through as the literal value `"wide` into a paid request.
    if (bare !== undefined && (bare.startsWith('"') || bare.startsWith("'"))) {
      return {
        error: `Unterminated quoted value for --${m[1]} (${bare}…). Close the quote, or escape it as \\${bare[0]}.`,
      };
    }
    flags[m[1]!] = quoted !== undefined ? quoted.replace(/\\(["'\\])/g, '$1') : (bare ?? '');
    covered = m.index + m[0].length;
  }
  const tail = text.slice(covered).trim();
  if (tail !== '') {
    return { error: `Unrecognized text "${tail}" — use --key "value" flags.` };
  }
  return { flags };
}

/** Capability-driven schema for video_generate (mirrors pi-image-gen's approach). */
function buildGenerateParams(caps: VideoModelCapabilities | null) {
  return Type.Object({
    prompt: Type.Optional(
      Type.Object(
        {
          scene: Type.Optional(
            Type.String({
              description:
                'Setting of the clip. REQUIRED when no firstFrame is passed (text-to-video).',
            }),
          ),
          visuals: Type.String({
            description:
              'Camera, framing, composition (e.g. "Slow push-in from medium shot to close-up, shallow depth of field").',
          }),
          action: Type.String({ description: 'In-frame action/movement.' }),
          effects: Type.Optional(
            Type.String({
              description:
                'Time-varying visuals a static frame cannot carry: transformations, lighting shifts, particles, atmosphere.',
            }),
          ),
          audio: Type.Optional(
            Type.String({
              description:
                'Audio cues when the active model has nativeAudio (e.g. "[Sound Effect] rain; [Speaker] Alice (soft): line").',
            }),
          ),
          visibleCharacters: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Ids of characters (from the characters param) appearing in this clip.',
            }),
          ),
        },
        {
          description:
            'Structured per-shot prompt. Fields are assembled into labeled sections ([Scene]/[Visuals]/[Action]/[Effects]/[Audio]) — write content, not a pre-joined string. Required for a fresh generation; omit when resuming an interrupted job via jobId.',
        },
      ),
    ),
    style: Type.Optional(
      Type.String({
        description:
          'Film-level look: genre, quality, render texture (e.g. "cinematic, 8K, shallow DoF, film grain"). REQUIRED when no firstFrame is passed.',
      }),
    ),
    characters: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          description: Type.String({ description: 'Appearance + outfit.' }),
        }),
        {
          description:
            'Reusable character registry; shots inline a character via prompt.visibleCharacters.',
        },
      ),
    ),
    consistency: Type.Optional(
      Type.String({
        description:
          'Consistency directive appended to the prompt (e.g. "Face, hair and outfit stay identical throughout, no morphing or drift").',
      }),
    ),
    negative: Type.Optional(
      Type.String({
        description: 'Negative directive (e.g. "no text, watermarks, or subtitles").',
      }),
    ),
    firstFrame: Type.Optional(
      Type.String({
        description:
          'Path to a regular png/jpg/webp first-frame image inside the session cwd. The path may be absolute or relative; symlinks and paths outside cwd are rejected.',
      }),
    ),
    ...(caps?.supportsFirstLastFrame
      ? {
          lastFrame: Type.Optional(
            Type.String({
              description:
                'Path to a regular png/jpg/webp last-frame image inside the session cwd for first+last-frame interpolation.',
            }),
          ),
        }
      : {}),
    ...(caps?.referenceAssetModalities?.length
      ? {
          referenceAssets: Type.Optional(
            Type.Array(
              Type.Object({
                modality: StringEnum(caps.referenceAssetModalities),
                assetId: Type.String({
                  description:
                    'Asset ID from the current provider account/project. Accepts asset-... or asset://asset-....',
                }),
              }),
              {
                description:
                  'Provider-managed trusted assets in prompt-numbering order. In the prompt refer to Image 1, Video 1, or Audio 1; never write the Asset ID.',
              },
            ),
          ),
        }
      : {}),
    durationSec: Type.Optional(
      Type.Integer({
        ...(caps ? { minimum: caps.durations[0], maximum: caps.durations[1] } : {}),
        description: caps
          ? `Clip duration in seconds, integer ${caps.durations[0]}-${caps.durations[1]} for the active model.`
          : 'Clip duration in seconds (model-dependent).',
      }),
    ),
    aspectRatio: caps
      ? Type.Optional(
          StringEnum(caps.aspectRatios, { description: 'Aspect ratio for the active model.' }),
        )
      : Type.Optional(Type.String({ description: 'Aspect ratio (model-dependent).' })),
    jobId: Type.Optional(
      Type.String({
        description:
          'Resume a previous single-clip job by id (from an interrupted call) instead of submitting a new paid task.',
      }),
    ),
  });
}

export default function piVideoGenExtension(pi: ExtensionAPI): void {
  let settings: VideoGenSettings = {};
  let rateLimiter = new RateLimiter();
  const activeJobs = new ActiveJobs();

  const reloadSettings = (ctx: ExtensionContext) => {
    settings = loadVideoGenSettings(ctx.cwd, isProjectTrusted(ctx));
    rateLimiter = new RateLimiter(
      settings.rateLimit?.maxRequestsPerMinute,
      settings.rateLimit?.maxRequestsPerDay,
    );
  };

  const sha256hex = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

  /**
   * Freeze a frame into the job directory with an exclusive-create copy and
   * record its content hash — a paid task must be provably tied to the exact
   * image BYTES submitted, not just a path (decision 19②⑤⑧).
   */
  const snapshotFrame = async (
    jobDir: string,
    sourcePath: string,
    label: string,
    cwd: string,
  ): Promise<{ rel: string; hash: string }> => {
    const bytes = await readApprovedFrame(sourcePath, cwd);
    const ext = extname(sourcePath) || '.png';
    const rel = join('assets', `${label}${ext}`);
    const dest = join(jobDir, rel);
    mkdirSync(join(jobDir, 'assets'), { recursive: true });
    let tmp = '';
    for (let i = 0; ; i++) {
      const candidate = `${dest}.tmp-${process.pid}-${i}`;
      try {
        const file = await open(candidate, 'wx');
        try {
          await file.writeFile(bytes);
        } finally {
          await file.close();
        }
        tmp = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    await rename(tmp, dest);
    return { rel, hash: sha256hex(await readFile(dest)) };
  };

  /** Tool-facing params (LLM names) — mapped explicitly to the internal shape. */
  type GenerateToolParams = FilmPrompt & {
    /** Required for a fresh generation; unused on resume (jobId). */
    prompt?: ShotPrompt | undefined;
    firstFrame?: string | undefined;
    lastFrame?: string | undefined;
    referenceImages?: string[] | undefined;
    referenceAssets?: ReferenceAsset[] | undefined;
    durationSec?: number | undefined;
    aspectRatio?: string | undefined;
    jobId?: string | undefined;
  };

  /** Shared single-clip flow for the tool's execute() and `/video-gen generate`. */
  const runGenerate = async (
    toolParams: GenerateToolParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    const resolved = resolveModel(settings);
    if (!resolved) {
      return errResult(
        `Cannot resolve model "${settings.defaultModel ?? DEFAULT_VIDEO_MODEL_ID}" against the built-in registry. Run /video-gen models to see available ids and aliases, or fix "pi-video-gen.defaultModel" in settings.`,
      );
    }
    const caps = resolved.entry.capabilities;
    const adapter = ADAPTERS[resolved.provider.style];
    if (!adapter) {
      return errResult(
        `Provider adapter "${resolved.provider.style}" is unavailable in this build. Run /video-gen models or reinstall pi-video-gen.`,
      );
    }
    if (!resolved.provider.apiKey) {
      return errResult(
        missingKeyError(
          resolved.provider.style,
          ENV_VAR_BY_STYLE[resolved.provider.style],
          resolved.provider.apiKeyPath,
        ).message,
      );
    }
    // Trim-normalized once — validation, capability checks and the submit
    // mapping must all agree on whether a frame is present.
    const firstFrame = toolParams.firstFrame?.trim();
    const lastFrame = toolParams.lastFrame?.trim();
    let referenceAssets: ReferenceAsset[] = [];
    try {
      referenceAssets = normalizeReferenceAssets(toolParams.referenceAssets);
    } catch (error) {
      return errResult(errorMessageForUser(error));
    }
    // Structured prompt validation happens only on fresh submits — the resume
    // path (jobId) re-polls a frozen request and never re-reads the prompt.
    if (!toolParams.jobId) {
      const promptError =
        validateFilmPrompt(toolParams, 'video_generate') ??
        validateShotPrompt(
          toolParams,
          toolParams.prompt,
          { hasFirstFrame: !!firstFrame },
          'prompt',
        );
      if (promptError) {
        return errResult(promptError);
      }
    }
    if (lastFrame && !caps.supportsFirstLastFrame) {
      return errResult(
        `The active model (${resolved.entry.id}) does not support last-frame interpolation. Remove lastFrame, or switch models (/video-gen models).`,
      );
    }
    if (
      toolParams.durationSec != null &&
      (!Number.isInteger(toolParams.durationSec) ||
        toolParams.durationSec < caps.durations[0] ||
        toolParams.durationSec > caps.durations[1])
    ) {
      if (!Number.isInteger(toolParams.durationSec)) {
        return errResult(
          `durationSec must be a whole number of seconds (${caps.durations[0]}-${caps.durations[1]} for ${resolved.entry.id}) — got ${toolParams.durationSec}.`,
        );
      }
      return errResult(
        `durationSec must be ${caps.durations[0]}-${caps.durations[1]}s for ${resolved.entry.id} (got ${toolParams.durationSec}).`,
      );
    }
    // Reject empty-string ratio before the truthy capability check — "" would
    // skip the check yet survive `??` into the fingerprint and paid request.
    if (toolParams.aspectRatio !== undefined && toolParams.aspectRatio.trim() === '') {
      return errResult('aspectRatio must be a non-empty string when passed (e.g. "16:9").');
    }
    if (toolParams.aspectRatio && !caps.aspectRatios.includes(toolParams.aspectRatio)) {
      return errResult(
        `aspectRatio must be one of ${caps.aspectRatios.join(', ')} for ${resolved.entry.id} (got ${toolParams.aspectRatio}).`,
      );
    }
    const referenceError = referenceAssetPreflightError({
      providerStyle: resolved.provider.style,
      modelId: resolved.entry.id,
      capabilities: caps,
      referenceAssets,
      localImageReferences:
        (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0) + (toolParams.referenceImages?.length ?? 0),
    });
    if (referenceError) return errResult(referenceError);

    const outputDir = resolveOutputDir(settings, ctx.cwd);

    // Resume path: a job id means "keep polling the persisted handle", never re-submit.
    if (toolParams.jobId) {
      assertSafeId(toolParams.jobId, 'job');
      const manifest = loadSingleJob(outputDir, toolParams.jobId);
      if (manifest?.state === 'ambiguous') {
        return errResult(
          `Job "${toolParams.jobId}" has an ambiguous submit — a paid task MAY exist. Check the provider console before starting another generation; this job will not submit again automatically.`,
          { jobId: toolParams.jobId },
        );
      }
      // Terminal states have no business re-polling: a finished job returns
      // its clip; a failed one refuses (permanent failures don't heal).
      if (manifest?.state === 'done' && manifest.videoPath && existsSync(manifest.videoPath)) {
        return okResult(
          `Video clip already rendered: ${manifest.videoPath}. Job id: ${manifest.jobId}.`,
          {
            jobId: manifest.jobId,
            videoPath: manifest.videoPath,
          },
        );
      }
      if (manifest?.state === 'failed') {
        return errResult(
          `Job ${toolParams.jobId} already failed permanently (its manifest records the reason). Start a fresh generation instead of resuming.`,
        );
      }
      if (!manifest?.handle) {
        return errResult(
          `No resumable job found with id "${toolParams.jobId}". The manifest is missing or has no task handle; start a fresh generation instead.`,
        );
      }
      if (
        !manifest.requestFingerprint ||
        manifest.handle.requestFingerprint !== manifest.requestFingerprint
      ) {
        return errResult(
          `Job ${toolParams.jobId} has a task handle that does not match its frozen request fingerprint. Refusing to poll it; inspect or discard the manifest.`,
          { jobId: toolParams.jobId },
        );
      }
      // Frozen task identity, fail-CLOSED: a manifest without identity
      // fields predates the freeze and cannot be resumed safely (settings may
      // have changed since) — no silent fallback to the current endpoint.
      if (!manifest.modelId || !manifest.providerStyle || !manifest.providerBaseUrl) {
        return errResult(
          `Job ${toolParams.jobId} was created before task-identity freezing and cannot be resumed safely. Start a new job (or delete .video-gen/single/${toolParams.jobId} under your video-gen output directory to clear it).`,
        );
      }
      // Settings must still point at the same endpoint — polling the old task
      // id against a reconfigured provider hits the wrong URL.
      if (
        manifest.modelId !== resolved.remoteId ||
        manifest.providerStyle !== resolved.provider.style ||
        manifest.providerBaseUrl !== resolved.provider.baseUrl
      ) {
        return errResult(
          `Job ${toolParams.jobId} was created with model "${manifest.modelId ?? resolved.remoteId}" on ${manifest.providerStyle ?? resolved.provider.style} (${manifest.providerBaseUrl ? redactUrl(manifest.providerBaseUrl) : 'default endpoint'}), but current settings resolve to "${resolved.remoteId}" on ${resolved.provider.style} (${redactUrl(resolved.provider.baseUrl)}). Restore the previous settings to resume it, or start a new job.`,
        );
      }
      const jobDir = resolveJobDirInsideOutput(outputDir, singleJobDir(outputDir, manifest.jobId));
      const frozenInput = readJsonFile<
        Partial<GenerateVideoParams> & { model?: string | undefined }
      >(join(jobDir, 'input.json'));
      if (
        !frozenInput ||
        frozenInput.model !== manifest.modelId ||
        frozenInput.requestId !== manifest.jobId ||
        typeof frozenInput.prompt !== 'string' ||
        requestFingerprint(frozenInput.model, frozenInput as GenerateVideoParams) !==
          manifest.requestFingerprint
      ) {
        return errResult(
          `Job ${toolParams.jobId} no longer matches its frozen input snapshot. Refusing to poll a task whose request identity cannot be verified.`,
          { jobId: toolParams.jobId },
        );
      }
      // Frozen frame verification: resume only if the snapshots are intact.
      if (manifest.frameHashes) {
        for (const [rel, expected] of Object.entries(manifest.frameHashes)) {
          const snapPath = join(singleJobDir(outputDir, manifest.jobId), rel);
          let actual: string | undefined;
          try {
            actual = sha256hex(await readFile(snapPath));
          } catch {
            actual = undefined;
          }
          if (actual !== expected) {
            return errResult(
              `Frame snapshot ${rel} changed or is missing — the frozen input is no longer trustworthy. Start a new job.`,
            );
          }
        }
      }

      const release = activeJobs.acquire(jobDir);
      try {
        return await finishJob(manifest, resolved.provider, adapter, outputDir, signal, onUpdate);
      } finally {
        release();
      }
    }

    const jobId = newJobId('gen');
    const jobDir = ensureSingleJobDir(outputDir, jobId);
    // Map tool params → internal params, applying model defaults. (A raw cast
    // here silently DROPPED firstFrame/lastFrame and defaulted resolution,
    // duration, ratio and audio — turning paid requests into silent t2v.)
    const params: GenerateVideoParams = {
      // prompt is present here: fresh submits were validated above, and the
      // resume branch (jobId) has already returned.
      prompt: assemblePrompt(toolParams, toolParams.prompt!),
      firstFramePath: firstFrame ? resolve(ctx.cwd, firstFrame) : undefined,
      lastFramePath: lastFrame ? resolve(ctx.cwd, lastFrame) : undefined,
      referenceImagePaths: toolParams.referenceImages?.map((p) => resolve(ctx.cwd, p)),
      referenceAssets,
      durationSec: toolParams.durationSec ?? resolved.entry.defaultDurationSec,
      aspectRatio: toolParams.aspectRatio ?? resolved.entry.defaultAspectRatio,
      resolution: resolved.entry.defaultResolution,
      generateAudio: caps.nativeAudio,
    };
    params.requestId = jobId;
    const release = activeJobs.acquire(jobDir);
    try {
      // Freeze every frame input into the job BEFORE the paid submit — the
      // task must be tied to exact image BYTES, not a mutable path.
      const frameHashes: Record<string, string> = {};
      try {
        if (params.firstFramePath) {
          const snap = await snapshotFrame(jobDir, params.firstFramePath, 'first_frame', ctx.cwd);
          frameHashes[snap.rel] = snap.hash;
          params.firstFramePath = join(jobDir, snap.rel);
        }
        if (params.lastFramePath) {
          const snap = await snapshotFrame(jobDir, params.lastFramePath, 'last_frame', ctx.cwd);
          frameHashes[snap.rel] = snap.hash;
          params.lastFramePath = join(jobDir, snap.rel);
        }
        if (params.referenceImagePaths?.length) {
          const frozenRefs: string[] = [];
          for (let i = 0; i < params.referenceImagePaths.length; i++) {
            const snap = await snapshotFrame(
              jobDir,
              params.referenceImagePaths[i]!,
              `ref_${i}`,
              ctx.cwd,
            );
            frameHashes[snap.rel] = snap.hash;
            frozenRefs.push(join(jobDir, snap.rel));
          }
          params.referenceImagePaths = frozenRefs;
        }
      } catch {
        return errResult(
          'A reference frame is not readable. Use an image_generate result inside the session cwd, or an existing png/jpg/webp file under cwd.',
        );
      }

      writeJsonAtomic(`${jobDir}/input.json`, { model: resolved.remoteId, ...params });
      await rateLimiter.acquire(signal);
      const expectedFingerprint = requestFingerprint(resolved.remoteId, params);
      // Persist a fail-closed state BEFORE the paid request. A crash or an
      // AmbiguousSubmitError leaves a job that refuses automatic resubmission.
      saveSingleJob(outputDir, {
        jobId,
        kind: 'single',
        state: 'ambiguous',
        modelId: resolved.remoteId,
        providerStyle: resolved.provider.style,
        providerBaseUrl: resolved.provider.baseUrl,
        requestFingerprint: expectedFingerprint,
        frameHashes, // frozen bytes are provable even if the response is lost
        updatedAt: new Date().toISOString(),
      });
      onUpdate?.(okResult('Submitting video task…'));
      const handle = await adapter.submit(
        resolved.provider,
        resolved.remoteId,
        params,
        fetch,
        signal,
      );
      saveSingleJob(outputDir, {
        jobId,
        kind: 'single',
        state: 'submitted',
        handle,
        requestFingerprint: expectedFingerprint,
        modelId: resolved.remoteId,
        providerStyle: resolved.provider.style,
        providerBaseUrl: resolved.provider.baseUrl,
        frameHashes,
        updatedAt: new Date().toISOString(),
      });
      return await finishJob(
        loadSingleJob(outputDir, jobId)!,
        resolved.provider,
        adapter,
        outputDir,
        signal,
        onUpdate,
      );
    } catch (error) {
      return handleGenerateError(error, outputDir, jobId);
    } finally {
      release();
    }
  };

  /** Poll an existing handle to completion and download the clip. */
  const finishJob = async (
    manifest: SingleJobManifest,
    provider: ResolvedProvider,
    adapter: VideoProviderAdapter,
    outputDir: string,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    const handle = manifest.handle as RemoteTaskHandle;
    const jobDir = resolveJobDirInsideOutput(outputDir, singleJobDir(outputDir, manifest.jobId));
    try {
      onUpdate?.(okResult(`Task ${handle.taskId} submitted; polling…`));
      saveSingleJob(outputDir, { ...manifest, state: 'polling' });
      const succeeded = await pollTask({
        check: () => adapter.inspect(provider, handle, fetch, signal),
        signal,
        onTick: (attempt, phase) => {
          if (attempt % 15 === 0) {
            onUpdate?.(okResult(`Still ${phase}… (${attempt * 2}s elapsed)`));
          }
        },
      });

      const videoPath = `${jobDir}/video.mp4`;
      saveSingleJob(outputDir, { ...manifest, state: 'downloading' });
      onUpdate?.(okResult('Task finished; downloading clip…'));
      const meta = await adapter.downloadTo(
        provider,
        handle,
        succeeded.videoUrl,
        videoPath,
        fetch,
        signal,
      );

      saveSingleJob(outputDir, { ...manifest, state: 'done', videoPath: meta.path });
      pi.appendEntry('video-gen:last-job', {
        jobId: manifest.jobId,
        kind: 'single',
        videoPath: meta.path,
      });
      return okResult(
        `Video clip ready: ${meta.path} (${(meta.bytes / 1_000_000).toFixed(1)} MB). Job id: ${manifest.jobId}.`,
        { jobId: manifest.jobId, videoPath: meta.path, bytes: meta.bytes, taskId: handle.taskId },
      );
    } catch (error) {
      if (error instanceof CancelledError || signal?.aborted) {
        if (adapter.cancel) {
          try {
            const cancelled = await adapter.cancel(
              provider,
              handle,
              fetch,
              AbortSignal.timeout(10_000),
            );
            if (cancelled.cancelled) {
              const next = {
                ...manifest,
                state: 'failed' as const,
                error: 'cancelled remotely',
              };
              delete next.handle;
              saveSingleJob(outputDir, next);
              return errResult(`Remote task ${handle.taskId} was cancelled.`, {
                jobId: manifest.jobId,
                taskId: handle.taskId,
              });
            }
          } catch {
            console.error('[pi-video-gen] remote cancel failed');
          }
        }
        saveSingleJob(outputDir, { ...manifest, state: 'polling_stopped' });
        return errResult(
          `Stopped locally. NOTE: the remote task ${handle.taskId} may still be running and billable — local stop does not cancel it (Ark task-cancellation support is unverified). Resume polling with video_generate jobId "${manifest.jobId}" once it should have finished.`,
          { jobId: manifest.jobId, taskId: handle.taskId },
        );
      }
      return handleGenerateError(error, outputDir, manifest.jobId);
    }
  };

  const handleGenerateError = (error: unknown, outputDir: string, jobId: string): TextResult => {
    console.error(`[pi-video-gen] generate failed: ${toLogSummary(error)}`);
    const existing = loadSingleJob(outputDir, jobId);
    if (existing && existing.state !== 'done') {
      const terminal = error instanceof RemoteTaskFailedError;
      const ambiguous =
        error instanceof AmbiguousSubmitError || error instanceof RemoteTaskNotFoundError;
      const next: SingleJobManifest = {
        ...existing,
        state: ambiguous
          ? 'ambiguous'
          : existing.handle && !terminal
            ? 'polling_stopped'
            : 'failed',
        error: error instanceof RemoteTaskFailedError ? error.providerMessage : toLogSummary(error),
      };
      if (terminal) delete next.handle;
      saveSingleJob(outputDir, next);
    }
    return errResult(
      error instanceof RemoteTaskNotFoundError
        ? `Job ${jobId} is no longer visible to the provider, but the paid task may still exist. Its handle was preserved and this job will not resubmit automatically; check the provider console before starting another generation.`
        : errorMessageForUser(error),
      { jobId },
    );
  };

  /** Shared C0 compose flow for the tool's execute() and `/video-gen compose`. */
  const runComposeTool = async (
    p: { composeSpecPath: string },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    try {
      const name = p.composeSpecPath.split(/[\\/]/).pop() ?? '';
      if (name === 'timeline-input.json') {
        // Timeline compose (C1–C4): mixed media + overlays + TTS, local render.
        const result = await runTimeline({
          timelineSpecPath: p.composeSpecPath,
          cwd: ctx.cwd,
          settings,
          activeJobs,
          signal,
          onUpdate: (msg) => onUpdate?.(okResult(msg)),
        });
        pi.appendEntry('video-gen:last-job', {
          jobId: result.jobId,
          kind: 'timeline',
          finalVideoPath: result.finalVideoPath,
        });
        return okResult(
          `Promo video ready: ${result.finalVideoPath} (${result.segments} segments, ${result.durationSec.toFixed(1)}s). QC frames: ${result.qcFrames.join(', ')}. Job: ${result.jobId}.`,
          result as unknown as Record<string, unknown>,
        );
      }
      // C0: lossless concat of existing clips.
      const result = await runCompose({
        composeSpecPath: p.composeSpecPath,
        cwd: ctx.cwd,
        settings,
        activeJobs,
        signal,
        onUpdate: (msg) => onUpdate?.(okResult(msg)),
      });
      pi.appendEntry('video-gen:last-job', {
        jobId: result.jobId,
        kind: 'compose',
        finalVideoPath: result.finalVideoPath,
      });
      return okResult(
        `Final video ready: ${result.finalVideoPath} (${result.clipCount} clips, lossless concat${result.resumed ? ', resumed' : ''}). Job: ${result.jobId}.`,
        result as unknown as Record<string, unknown>,
      );
    } catch (error) {
      console.error(`[pi-video-gen] video_compose failed: ${toLogSummary(error)}`);
      return errResult(errorMessageForUser(error));
    }
  };

  /** Shared multi-shot render flow for the tool's execute() and `/video-gen render`. */
  const runRenderTool = async (
    p: { renderSpecPath: string; allowDegradations?: string[] | undefined },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    try {
      const resolved = resolveModel(settings);
      if (!resolved) {
        return errResult(
          `Cannot resolve model "${settings.defaultModel ?? DEFAULT_VIDEO_MODEL_ID}". Run /video-gen models, or fix pi-video-gen.defaultModel.`,
        );
      }
      const adapter = ADAPTERS[resolved.provider.style];
      if (!adapter) {
        return errResult(
          `Provider adapter "${resolved.provider.style}" is unavailable in this build. Run /video-gen models or reinstall pi-video-gen.`,
        );
      }
      if (!resolved.provider.apiKey) {
        return errResult(
          missingKeyError(
            resolved.provider.style,
            ENV_VAR_BY_STYLE[resolved.provider.style],
            resolved.provider.apiKeyPath,
          ).message,
        );
      }
      const ffmpeg = resolveFfmpeg(settings.ffmpegPath);
      if (!ffmpeg.runnable) {
        return errResult(
          `ffmpeg is not runnable (tried source: ${ffmpeg.source}). Set pi-video-gen.ffmpegPath in GLOBAL settings or FFMPEG_PATH, then /video-gen doctor.`,
        );
      }
      const result = await runRender({
        renderSpecPath: p.renderSpecPath,
        allowDegradations: p.allowDegradations,
        settings,
        cwd: ctx.cwd,
        resolved,
        adapter,
        activeJobs,
        rateLimiter,
        ffmpegPath: ffmpeg.path,
        signal,
        onUpdate: (msg) => onUpdate?.(okResult(msg)),
      });
      const degradedNote =
        result.degraded.length > 0 ? ` Degradations applied: ${result.degraded.join('; ')}.` : '';
      pi.appendEntry('video-gen:last-job', {
        jobId: result.jobId,
        kind: 'render',
        finalVideoPath: result.finalVideoPath,
      });
      return okResult(
        `Final video ready: ${result.finalVideoPath} (${result.shotsDone} shots). Job: ${result.jobId}.${degradedNote}`,
        result as unknown as Record<string, unknown>,
      );
    } catch (error) {
      console.error(`[pi-video-gen] video_render failed: ${toLogSummary(error)}`);
      return errResult(errorMessageForUser(error));
    }
  };

  const capabilitiesText = (): string => {
    const info = listModelRegistry(settings);
    const resolved = resolveModel(settings);
    const lines = [
      `Active model: ${info.activeId}${info.activeResolved ? '' : ' (NOT resolvable — check pi-video-gen.defaultModel)'}`,
    ];
    if (resolved) {
      const c = resolved.entry.capabilities;
      lines.push(
        `Provider: ${resolved.provider.style} (key ${resolved.provider.apiKey ? 'ready' : 'MISSING'})`,
        `Durations: ${c.durations[0]}-${c.durations[1]}s; Resolutions: ${c.resolutions.join('/')}; Aspect ratios: ${c.aspectRatios.join(', ')}`,
        `Native audio: ${c.nativeAudio ? 'yes' : 'no'}; First+last frame: ${c.supportsFirstLastFrame ? 'yes' : 'no'}; Max reference images: ${c.maxReferenceImages}`,
        `Trusted asset references: ${resolved.provider.style === 'ark' ? c.referenceAssetModalities?.join(', ') || 'none' : 'none'}; Max videos: ${c.maxReferenceVideos ?? 0}; Max audios: ${c.maxReferenceAudios ?? 0}`,
      );
    }
    lines.push('Registered models:');
    for (const m of info.models) {
      lines.push(
        `- ${m.id} [${m.provider}] aliases: ${m.aliases.join(', ')} (key ${m.keyReady ? 'ready' : 'missing'})`,
      );
    }
    return lines.join('\n');
  };

  const registerTools = () => {
    const active = resolveModel(settings);
    const caps = active?.entry.capabilities ?? null;
    const schemaCaps =
      caps && active?.provider.style !== 'ark'
        ? { ...caps, referenceAssetModalities: undefined }
        : caps;

    pi.registerTool({
      name: 'video_generate',
      label: 'Generate Video Clip',
      description:
        'Generate a single short video clip (one shot) from a structured prompt, optionally anchored by first/last frames or provider-managed trusted assets. Paid, slow (minutes per clip). For multi-shot videos, use the video-gen skill workflow instead of calling this repeatedly.',
      parameters: buildGenerateParams(schemaCaps),
      promptSnippet:
        'Generate one short video clip (paid, minutes) from a structured prompt via the active video model',
      promptGuidelines: [
        "Before composing prompts for a video task, call video_capabilities to learn the active model's duration range, aspect ratios, audio support, and first/last-frame support — do not assume.",
        'Fill the structured prompt fields; never a pre-joined string. visuals + action are always required; style + scene are required when no firstFrame anchors the clip; use effects for transformations or lighting shifts a static frame cannot carry.',
        'Video generation is paid and slow. State the expected clip count and duration to the user and get explicit confirmation before the first call.',
        'Only pass lastFrame when the user needs first+last-frame interpolation and the active model supports it.',
        'For Seedance references containing recognizable real people, use a preset-avatar or authorized-person Asset ID from the current account/project. Pass it through referenceAssets and refer to it in the prompt as Image 1, Video 1, or Audio 1 — never as the Asset ID.',
        'Treat user approval as scoped to the exact asset list, provider/account context, model, clip count, and duration; ask again when any of those change.',
        'If a call is interrupted, resume with the returned jobId instead of submitting a new task (avoids double billing); prompt is not needed on resume.',
        'If submit is reported as ambiguous, do not start another generation until the provider console confirms that no paid task exists.',
      ],
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        try {
          return await runGenerate(params as GenerateToolParams, ctx, signal, onUpdate);
        } catch (error) {
          console.error(`[pi-video-gen] video_generate failed: ${toLogSummary(error)}`);
          return errResult(errorMessageForUser(error));
        }
      },
    });

    pi.registerTool({
      name: 'video_compose',
      label: 'Compose Video Clips',
      description:
        'Local video assembly, no paid models. Two specs: <jobDir>/compose-input.json (C0: lossless concat of 2+ existing mp4 clips, ffprobe stream precheck) or <jobDir>/timeline-input.json (C1+: promo from mixed images/video clips + overlays + TTS + transitions + soft or burned subtitles, rendered locally).',
      parameters: Type.Object({
        composeSpecPath: Type.String({
          description:
            'Path to <jobDir>/compose-input.json (C0) or <jobDir>/timeline-input.json (promo timeline). The parent directory must live under the video-gen output dir and acts as the job. Rerunning the same path resumes identical input; revisions require a NEW job directory.',
        }),
      }),
      promptSnippet:
        'Assemble video locally — lossless clip concat (C0) or a mixed image/video promo timeline with TTS and soft/burned subtitles, no paid models',
      promptGuidelines: [
        'Two modes: <jobDir>/compose-input.json (C0: concat 2+ compatible mp4 clips) or <jobDir>/timeline-input.json (promo: mixed images/video + overlays + TTS + xfade + soft/burned subtitles, all local).',
        'For C0: every ordered stream across all clips must match (codec/resolution/fps/timebase/pix_fmt/sample-rate/audio layout) — mismatches are reported via ffprobe, never silently transcoded. Do NOT use for AI video generation (use video_generate/video_render).',
        'For timeline: each segment contains exactly one image or video. Video uses numeric durationSec with optional trimStartSec, fit, and sourceAudio; image may use auto duration and motion.',
        'Reuse existing images/screenshots/clips first and generate only missing visuals with image_generate. Put Chinese titles in overlay and use subtitles.mode "burn" when narration subtitles must appear directly in the frames.',
        'Timeline TTS failures stop by default. Set ttsFailureMode "silent-subtitles" in timeline-input.json only after the user explicitly accepts silent audio with preserved subtitles.',
        'Narration is not fully local: require an explicit voice such as "edge-tts:zh-CN-YunyangNeural" only after disclosing that narration text is sent to Microsoft Edge TTS.',
        'Local compute — no paid-model confirmation needed, but tell the user the segment/clip count and planned duration before calling.',
        'The spec is immutable per job directory: rerunning the same path resumes identical input; changing input means a NEW job directory.',
      ],
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return runComposeTool(params as { composeSpecPath: string }, ctx, signal, onUpdate);
      },
    });

    pi.registerTool({
      name: 'video_render',
      label: 'Render Multi-Shot Video',
      description:
        'Render a multi-shot video from <jobDir>/render-input.json: each shot requires a local first frame or at least one provider-managed trusted asset. Submits one paid task per shot (resuming persisted handles on rerun), downloads clips, and concatenates them into final_video.mp4.',
      parameters: Type.Object({
        renderSpecPath: Type.String({
          description:
            'Path to <jobDir>/render-input.json. The parent directory must live under the video-gen output dir and acts as the (immutable) job. Rerunning the same path resumes; revisions require a NEW job directory.',
        }),
        allowDegradations: Type.Optional(
          Type.Array(StringEnum(['first-frame-only'] as const), {
            description: 'Explicit user-approved downgrades for capability mismatches.',
          }),
        ),
      }),
      promptSnippet:
        'Render a prepared multi-shot video spec (paid, long-running) into a final mp4',
      promptGuidelines: [
        'Call ONLY after the user explicitly confirmed rendering: exact local frames/trusted assets ready, shot count, durations, provider/account context, and cost magnitude stated.',
        'For each shot, either generate required local frames via image_generate and record their returned paths, or pass current-account provider assets in referenceAssets. Recognizable real-person references sent to Seedance must use preset-avatar or authorized-person assets.',
        'render-input.json carries structured prompts: film-level style/characters/consistency/negative, per-shot prompt.{scene,visuals,action,effects,audio,visibleCharacters} — the plugin assembles the labeled prompt text; never pre-join a prompt string.',
        'The spec is immutable per job directory: rerunning the same path resumes identical input; revisions go in a NEW job directory.',
        'Interrupting stops locally only — remote tasks may keep billing; rerun the same spec path to resume after they finish.',
      ],
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return runRenderTool(
          params as { renderSpecPath: string; allowDegradations?: string[] },
          ctx,
          signal,
          onUpdate,
        );
      },
    });

    pi.registerTool({
      name: 'video_capabilities',
      label: 'Video Model Capabilities',
      description:
        "Read-only: list the active video model's capabilities (duration range, resolutions, aspect ratios, native audio, first/last-frame support, trusted asset modalities) and the registered models. Call before composing video prompts or shot books.",
      parameters: Type.Object({}),
      promptSnippet: 'Show active video model capabilities and registered models',
      async execute() {
        return okResult(capabilitiesText());
      },
    });
  };

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    reloadSettings(ctx);
    registerTools();
  });

  pi.registerCommand('video-gen', {
    description:
      'pi-video-gen: /video-gen [generate --visuals ".." --action ".." [--style .. --scene .. --asset-images asset-...]|render <spec>|compose <spec>|recover <jobId>|models|reload|doctor]',
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (sub === 'generate') {
        const parsed = parseGenerateFlags((args ?? '').trim().slice('generate'.length));
        if ('error' in parsed || Object.keys(parsed.flags).length === 0) {
          ctx.ui.notify(
            `${'error' in parsed ? `${parsed.error} ` : ''}Usage: /video-gen generate --visuals "..." --action "..." [--style "..."] [--scene "..."] [--effects "..."] [--audio "..."] [--consistency "..."] [--negative "..."] [--first-frame <path>] [--last-frame <path>] [--asset-images <id,id>] [--asset-videos <id,id>] [--asset-audios <id,id>] [--duration <sec>] [--ratio <ratio>]`,
            'error',
          );
          return;
        }
        const f = parsed.flags;
        const known = new Set([
          'style',
          'scene',
          'visuals',
          'action',
          'effects',
          'audio',
          'consistency',
          'negative',
          'first-frame',
          'last-frame',
          'asset-images',
          'asset-videos',
          'asset-audios',
          'duration',
          'ratio',
        ]);
        const unknown = Object.keys(f).filter((k) => !known.has(k));
        if (unknown.length > 0) {
          ctx.ui.notify(`Unknown flag(s): ${unknown.map((k) => `--${k}`).join(', ')}.`, 'error');
          return;
        }
        const durationSec = f.duration !== undefined ? Number(f.duration) : undefined;
        if (durationSec !== undefined && !Number.isInteger(durationSec)) {
          ctx.ui.notify(
            `--duration must be an integer number of seconds (got "${f.duration}").`,
            'error',
          );
          return;
        }
        const referenceAssets: ReferenceAsset[] = [];
        for (const [flag, modality] of [
          ['asset-images', 'image'],
          ['asset-videos', 'video'],
          ['asset-audios', 'audio'],
        ] as const) {
          if (f[flag] === undefined) continue;
          const ids = f[flag]!.split(',')
            .map((id) => id.trim())
            .filter(Boolean);
          if (ids.length === 0) {
            ctx.ui.notify(`--${flag} must contain at least one Asset ID.`, 'error');
            return;
          }
          referenceAssets.push(...ids.map((assetId) => ({ modality, assetId })));
        }
        const result = await runGenerate(
          {
            style: f.style,
            consistency: f.consistency,
            negative: f.negative,
            prompt: {
              scene: f.scene,
              visuals: f.visuals ?? '',
              action: f.action ?? '',
              effects: f.effects,
              audio: f.audio,
            },
            firstFrame: f['first-frame'],
            lastFrame: f['last-frame'],
            referenceAssets,
            durationSec,
            aspectRatio: f.ratio,
          },
          ctx,
          ctx.signal,
        );
        ctx.ui.notify(result.content[0]!.text, result.isError ? 'error' : 'info');
        return;
      }

      if (sub === 'reload') {
        reloadSettings(ctx);
        registerTools();
        ctx.ui.notify('pi-video-gen settings reloaded.', 'info');
        return;
      }

      if (sub === 'compose') {
        const specPath = (args ?? '').trim().slice('compose'.length).trim();
        if (!specPath) {
          ctx.ui.notify(
            'Usage: /video-gen compose <jobDir/compose-input.json|timeline-input.json>',
            'error',
          );
          return;
        }
        const result = await runComposeTool({ composeSpecPath: specPath }, ctx, ctx.signal);
        ctx.ui.notify(result.content[0]!.text, result.isError ? 'error' : 'info');
        return;
      }

      if (sub === 'render') {
        const specPath = tokens[1];
        if (!specPath) {
          ctx.ui.notify('Usage: /video-gen render <jobDir/render-input.json>', 'error');
          return;
        }
        const result = await runRenderTool({ renderSpecPath: specPath }, ctx, ctx.signal);
        ctx.ui.notify(result.content[0]!.text, result.isError ? 'error' : 'info');
        return;
      }

      if (sub === 'recover') {
        // Manual resolution of ambiguous shots. Paths:
        //   reset → nothing was created, re-render the shot from scratch
        //   adopt → the task exists remotely, track it and resume polling
        const jobId = tokens[1];
        if (!jobId) {
          ctx.ui.notify(
            'Usage: /video-gen recover <jobId> [shotId reset|adopt <taskId>]\nWithout arguments, lists ambiguous shots of the job.',
            'error',
          );
          return;
        }
        try {
          assertSafeId(jobId, 'job');
        } catch {
          ctx.ui.notify(`Invalid job id "${jobId}".`, 'error');
          return;
        }
        const outputDir = resolveOutputDir(settings, ctx.cwd);
        const requestedJobDir = join(outputDir, jobId);
        let manifest: ReturnType<typeof loadRenderJob>;
        try {
          manifest = loadRenderJob(requestedJobDir);
        } catch (error) {
          ctx.ui.notify(errorMessageForUser(error), 'error');
          return;
        }
        if (!manifest) {
          ctx.ui.notify(
            `No render job found with id "${jobId}" under the video-gen output directory.`,
            'error',
          );
          return;
        }
        let jobDir: string;
        try {
          jobDir = resolveJobDirInsideOutput(outputDir, requestedJobDir);
          manifest = loadRenderJob(jobDir);
        } catch (error) {
          ctx.ui.notify(errorMessageForUser(error), 'error');
          return;
        }
        if (!manifest) {
          ctx.ui.notify(`No render job found with id "${jobId}".`, 'error');
          return;
        }

        // tokens: recover <jobId> [shotId] [reset|adopt <taskId>]
        const shotId = tokens[2];
        if (!shotId) {
          const blocked = Object.entries(manifest.shots).filter(
            ([, st]) => st.state === 'ambiguous',
          );
          if (blocked.length === 0) {
            ctx.ui.notify(`Job ${jobId} has no ambiguous shots.`, 'info');
            return;
          }
          const lines = [
            `Job ${jobId}: ${blocked.length} ambiguous shot(s) — a paid task MAY exist per shot.`,
          ];
          for (const [shotId] of blocked) {
            lines.push(
              `  ${shotId}: check the provider console, then either`,
              `    /video-gen recover ${jobId} ${shotId} reset            (nothing was created → re-render)`,
              `    /video-gen recover ${jobId} ${shotId} adopt <taskId>  (task exists → resume polling)`,
            );
          }
          ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }

        // Form: /video-gen recover <jobId> <shotId> reset|adopt <taskId>
        const action = tokens[3];
        if (!action) {
          ctx.ui.notify(
            `Usage: /video-gen recover ${jobId} <shotId> reset|adopt <taskId>`,
            'error',
          );
          return;
        }
        try {
          assertSafeId(shotId, 'shot');
        } catch {
          ctx.ui.notify(`Invalid shot id "${shotId}".`, 'error');
          return;
        }
        let release: (() => void) | undefined;
        try {
          release = activeJobs.acquire(jobDir);
          // Re-read under the lock: the job may have advanced since the list/read above.
          manifest = loadRenderJob(jobDir);
          if (!manifest) {
            ctx.ui.notify(`No render job found with id "${jobId}".`, 'error');
            return;
          }
          const shot = manifest.shots[shotId];
          if (!shot) {
            ctx.ui.notify(`No shot "${shotId}" in job ${jobId}.`, 'error');
            return;
          }
          if (shot.state !== 'ambiguous') {
            ctx.ui.notify(
              `Shot "${shotId}" is not ambiguous (state: ${shot.state}). Nothing to resolve.`,
              'info',
            );
            return;
          }

          if (action === 'reset') {
            manifest.shots[shotId] = { state: 'pending', attempt: shot.attempt };
            saveRenderJob(jobDir, manifest);
            ctx.ui.notify(
              `Shot "${shotId}" reset to pending. Rerun video_render with the same render-input.json to re-render it.`,
              'info',
            );
            return;
          }
          if (action === 'adopt') {
            const taskId = tokens[4];
            if (!taskId) {
              ctx.ui.notify(`Usage: /video-gen recover ${jobId} ${shotId} adopt <taskId>`, 'error');
              return;
            }
            manifest.shots[shotId] = {
              state: 'submitted',
              attempt: shot.attempt,
              handle: {
                taskId,
                submittedAt: new Date().toISOString(),
                requestFingerprint: 'manual-adopt',
              },
              requestFingerprint: 'manual-adopt',
            };
            saveRenderJob(jobDir, manifest);
            ctx.ui.notify(
              `Shot "${shotId}" now tracks remote task ${taskId}. Rerun video_render with the same render-input.json to resume polling and download.`,
              'info',
            );
            return;
          }
          ctx.ui.notify(`Unknown recover action "${action}" — use reset or adopt.`, 'error');
        } catch (error) {
          ctx.ui.notify(errorMessageForUser(error), 'error');
        } finally {
          release?.();
        }
        return;
      }

      if (sub === 'models') {
        ctx.ui.notify(boundToolText(capabilitiesText()), 'info');
        return;
      }

      if (sub === 'doctor') {
        const result = runDoctor(ctx);
        ctx.ui.notify(result.content[0]!.text, 'info');
        return;
      }

      ctx.ui.notify(
        'pi-video-gen commands:\n  /video-gen generate --visuals ".." --action ".." [--style ".." --scene ".."]  Generate a single clip\n  /video-gen render <spec>      Render a multi-shot video\n  /video-gen compose <spec>     Concat clips or render an image/TTS timeline\n  /video-gen recover <jobId>    Resolve ambiguous shots (reset/adopt)\n  /video-gen models             List registered models\n  /video-gen reload             Reload settings\n  /video-gen doctor             Check environment (ffmpeg, CJK fonts, keys, image_generate, output dir)',
        'info',
      );
    },
  });

  function runDoctor(ctx: ExtensionContext): TextResult {
    const checks: string[] = [];

    // 1. video provider key + model resolution
    const resolved = resolveModel(settings);
    if (!resolved) {
      checks.push(
        `❌ defaultModel "${settings.defaultModel ?? DEFAULT_VIDEO_MODEL_ID}" not in registry — fix pi-video-gen.defaultModel`,
      );
    } else {
      const label = providerLabel(resolved.provider.style);
      checks.push(`✅ model: ${resolved.entry.id} [${resolved.provider.style}]`);
      checks.push(
        resolved.provider.apiKey
          ? `✅ ${label} API key configured`
          : `❌ ${label} API key missing — set apiKey for the active provider in global or agent-dir Pi settings`,
      );
    }

    // 2. ffmpeg (multi-shot concat; resolution chain: settings → env → bundled → PATH)
    const ffmpeg = resolveFfmpeg(settings.ffmpegPath);
    checks.push(
      ffmpeg.runnable
        ? `✅ ffmpeg found (source: ${ffmpeg.source})`
        : `❌ ffmpeg not runnable (source tried: ${ffmpeg.source}) — reinstall pi-video-gen to restore its platform package, or set pi-video-gen.ffmpegPath in global/agent-dir settings`,
    );
    const ffprobe = resolveFfprobe(settings.ffmpegPath);
    checks.push(
      ffprobe.runnable
        ? `✅ ffprobe found (source: ${ffprobe.source})`
        : `⚠️ ffprobe not runnable (source tried: ${ffprobe.source}) — needed for video_compose stream prechecks`,
    );
    const h264Ffmpeg = resolveGplFfmpeg(settings.ffmpegPath);
    checks.push(
      h264Ffmpeg.runnable
        ? `✅ libx264 encoder available (source: ${h264Ffmpeg.source})`
        : '⚠️ libx264 encoder unavailable — timeline output.codec "h264" will not work; use "mpeg4" or configure a compatible ffmpeg',
    );

    // 3. local CJK font (required by Sharp/SVG timeline overlays)
    checks.push(
      hasCjkFont()
        ? '✅ CJK font available for local text overlays'
        : '❌ CJK font missing — install PingFang, Microsoft YaHei, Noto Sans CJK, or WenQuanYi before rendering Chinese overlays',
    );

    // 4. image_generate presence (image stages live in pi-image-gen)
    try {
      const all = pi.getAllTools?.() ?? [];
      const active = pi.getActiveTools?.() ?? [];
      const registered = all.some((t) => t.name === 'image_generate');
      const enabled = active.includes('image_generate');
      checks.push(
        registered && enabled
          ? `✅ image_generate registered and active (pi-image-gen)`
          : `⚠️ image_generate ${registered ? 'registered but inactive' : 'not found'} — multi-shot workflows need pi-image-gen installed; check its config with /image-gen list`,
      );
    } catch {
      checks.push('⚠️ could not query registered tools on this runtime');
    }

    // 5. output dir writable
    const outputDir = resolveOutputDir(settings, ctx.cwd);
    try {
      mkdirSync(outputDir, { recursive: true });
      const probeDir = mkdtempSync(join(outputDir, '.doctor-probe-'));
      try {
        writeFileSync(join(probeDir, 'probe'), 'ok', { encoding: 'utf-8', flag: 'wx' });
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
      checks.push(`✅ output dir writable: ${outputDir}`);
    } catch {
      checks.push(`❌ output dir not writable: ${outputDir}`);
    }

    // 6. trust status
    checks.push(
      isProjectTrusted(ctx)
        ? '✅ project trusted (project-level pi-video-gen settings: whitelisted keys only)'
        : 'ℹ️ project not trusted — project-level .pi/settings.json is ignored',
    );

    return okResult(checks.join('\n'));
  }
}
