import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { safeBasename, VideoGenError } from '../errors.js';
import { CancelledError } from '../providers/task.js';
import type { RemoteTaskHandle } from '../types.js';

/**
 * Job directory layout + manifest persistence.
 *
 * Discipline (per design review):
 * - ids are restricted to a safe alphabet — they become directory names, so
 *   separators and dot-segments are rejected outright;
 * - manifest updates are single-writer and atomic (temp file + rename);
 * - the manifest is the resume authority: remote task handles land here the
 *   moment submit() returns.
 */

/** Safe id alphabet: alnum start, then alnum/dash/underscore, max 64. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertSafeId(id: string, what: string): void {
  if (!SAFE_ID.test(id)) {
    throw new VideoGenError(
      `Invalid ${what} id — use 1-64 chars of letters, digits, dash, underscore, starting with a letter or digit.`,
      `store: unsafe ${what} id`,
    );
  }
}

export function newJobId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

export type RenderShotState = {
  /** 'ambiguous' = submit outcome unknown (possible paid task); resume refuses until resolved. */
  state: 'pending' | 'submitted' | 'done' | 'failed' | 'polling_stopped' | 'ambiguous';
  /** Monotonic submit attempt, used to keep provider idempotency keys unique on retries. */
  attempt?: number | undefined;
  handle?: RemoteTaskHandle | undefined;
  /** Orchestrator-computed identity for checking a persisted handle on resume. */
  requestFingerprint?: string | undefined;
  videoPath?: string | undefined;
  error?: string | undefined;
};

export type RenderJobManifest = {
  jobId: string;
  kind: 'render';
  state: 'rendering' | 'concatenating' | 'done' | 'failed' | 'polling_stopped';
  /** Fingerprint over spec + model + provider baseUrl; drift ⇒ refuse resume. */
  specFingerprint: string;
  /** Snapshot-relative path → SHA-256 of the frozen frame content. */
  frameHashes: Record<string, string>;
  shots: Record<string, RenderShotState>;
  finalVideoPath?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
};

export type SingleJobManifest = {
  jobId: string;
  kind: 'single';
  state:
    | 'ambiguous'
    | 'submitted'
    | 'polling'
    | 'downloading'
    | 'done'
    | 'failed'
    | 'polling_stopped';
  handle?: RemoteTaskHandle;
  /** Orchestrator-computed identity for checking a persisted handle on resume. */
  requestFingerprint?: string;
  videoPath?: string;
  error?: string;
  /**
   * Frozen task identity for safe resume: without these, a settings change
   * between submit and resume would poll the old task on the wrong endpoint.
   */
  modelId?: string;
  providerStyle?: string;
  providerBaseUrl?: string;
  /** Frozen content hashes of the submitted frame snapshots (decision 19②⑤⑧). */
  frameHashes?: Record<string, string> | undefined;
  updatedAt: string;
};

/**
 * Write JSON to `path` atomically: EXCLUSIVELY-created temp file (O_EXCL via
 * the 'wx' flag — a pre-placed symlink fails EEXIST instead of being
 * followed) + atomic rename. PID alone is NOT unpredictable, so a pre-placed
 * `${path}.tmp-${pid}` symlink is a real attack — this closes it.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  for (let i = 0; ; i++) {
    const tmp = `${path}.tmp-${process.pid}-${i}`;
    try {
      writeFileSync(tmp, body, { encoding: 'utf-8', flag: 'wx' });
      renameSync(tmp, path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
}

/**
 * Read a JSON manifest. ONLY ENOENT means "does not exist". Corrupted JSON,
 * permission errors, etc. must REFUSE — treating them as "absent" would
 * re-initialize the job and re-submit every paid shot.
 */
export function readJsonFile<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new VideoGenError(
      `Cannot read ${safeBasename(path)} — check permissions. Refusing to resume.`,
      'store: manifest unreadable',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new VideoGenError(
      `${safeBasename(path)} is corrupted (not valid JSON). Refusing to resume — move it aside and start a new job, or restore it from backup. Rerunning as-is would re-bill all shots.`,
      'store: manifest corrupted',
    );
  }
}

/** Stream a potentially large artifact into SHA-256 without loading it into memory. */
export async function hashFileSha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw new CancelledError();
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** True only when the path is confirmed absent; other lookup failures remain unexpected. */
export async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export function singleJobDir(outputDir: string, jobId: string): string {
  assertSafeId(jobId, 'job');
  return join(outputDir, 'single', jobId);
}

/**
 * Create a single-job directory only after the shared `single` parent has
 * resolved inside outputDir. This prevents a pre-placed parent symlink from
 * creating the job directory outside the configured root.
 */
export function ensureSingleJobDir(outputDir: string, jobId: string): string {
  assertSafeId(jobId, 'job');
  mkdirSync(outputDir, { recursive: true });
  const realOutput = realpathSync(outputDir);
  const singleRoot = join(realOutput, 'single');
  mkdirSync(singleRoot, { recursive: true });
  const realSingleRoot = realpathSync(singleRoot);
  if (!realSingleRoot.startsWith(`${realOutput}${sep}`)) {
    throw new VideoGenError(
      'The single-job directory resolves outside the configured video-gen output directory. Refusing to write it.',
      'store: single root escapes output',
    );
  }
  const dir = join(realSingleRoot, jobId);
  mkdirSync(dir, { recursive: true });
  return resolveJobDirInsideOutput(realOutput, dir);
}

/** Resolve an existing job to its canonical path and keep it below the configured output root. */
export function resolveJobDirInsideOutput(outputDir: string, jobDir: string): string {
  let realOutput: string;
  let realJob: string;
  try {
    realOutput = realpathSync(outputDir);
    realJob = realpathSync(jobDir);
  } catch {
    throw new VideoGenError('The job directory does not exist.', 'store: job path missing');
  }
  if (!realJob.startsWith(`${realOutput}${sep}`)) {
    throw new VideoGenError(
      'The job directory resolves outside the configured video-gen output directory. Refusing to read or write it.',
      'store: job path escapes output',
    );
  }
  return realJob;
}

export function manifestPathFor(jobDir: string): string {
  return join(jobDir, 'manifest.json');
}

export function loadSingleJob(outputDir: string, jobId: string): SingleJobManifest | undefined {
  const path = manifestPathFor(singleJobDir(outputDir, jobId));
  const manifest = readJsonFile<unknown>(path);
  if (manifest === undefined) return undefined;
  const m = manifest as Partial<SingleJobManifest> | undefined;
  const validStates = new Set([
    'ambiguous',
    'submitted',
    'polling',
    'downloading',
    'done',
    'failed',
    'polling_stopped',
  ]);
  if (
    !m ||
    m.kind !== 'single' ||
    typeof m.jobId !== 'string' ||
    typeof m.state !== 'string' ||
    !validStates.has(m.state) ||
    typeof m.updatedAt !== 'string'
  ) {
    throw new VideoGenError(
      'manifest.json is not a valid single manifest (wrong shape). Refusing to resume.',
      'store: single manifest shape invalid',
    );
  }
  // The manifest must belong to THIS directory's job: a mismatched embedded
  // jobId would route locks, state updates and downloads into ANOTHER job.
  if (m.jobId !== jobId) {
    throw new VideoGenError(
      `manifest.json inside job "${jobId}" declares jobId "${m.jobId}" — the job is corrupted. Refusing to resume.`,
      'store: jobId mismatch',
    );
  }
  const handleRequired = new Set([
    'submitted',
    'polling',
    'downloading',
    'done',
    'polling_stopped',
  ]);
  if (
    (handleRequired.has(m.state) || m.handle !== undefined) &&
    (!m.handle ||
      typeof m.handle !== 'object' ||
      typeof m.handle.taskId !== 'string' ||
      typeof m.handle.submittedAt !== 'string' ||
      typeof m.handle.requestFingerprint !== 'string')
  ) {
    throw new VideoGenError(
      'manifest.json has a broken handle for the single job. Refusing to resume.',
      'store: single manifest handle invalid',
    );
  }
  if (
    m.handle &&
    (typeof m.requestFingerprint !== 'string' ||
      m.requestFingerprint === '' ||
      m.handle.requestFingerprint !== m.requestFingerprint)
  ) {
    throw new VideoGenError(
      'manifest.json has a task handle that does not match the frozen request fingerprint. Refusing to resume.',
      'store: single handle fingerprint mismatch',
    );
  }
  return m as SingleJobManifest;
}

/**
 * Structurally validate a parsed render manifest. Valid JSON with a broken
 * SHAPE (wrong kind, missing fingerprint/hashes/shots) must refuse — the
 * fresh branch would otherwise treat it as "no job" and re-bill every shot.
 */
function validateRenderManifest(raw: unknown, path: string): RenderJobManifest {
  const m = raw as Partial<RenderJobManifest> | undefined;
  const broken =
    !m ||
    m.kind !== 'render' ||
    typeof m.jobId !== 'string' ||
    typeof m.specFingerprint !== 'string' ||
    m.specFingerprint === '' ||
    typeof m.frameHashes !== 'object' ||
    m.frameHashes == null ||
    Array.isArray(m.frameHashes) ||
    typeof m.shots !== 'object' ||
    m.shots == null ||
    Array.isArray(m.shots);
  if (broken) {
    throw new VideoGenError(
      `${safeBasename(path)} is not a valid render manifest (wrong shape). Refusing to resume — move it aside and start a new job. Rerunning as-is would re-bill all shots.`,
      'store: manifest shape invalid',
    );
  }
  // Every recorded hash must be valid. Exact coverage cannot be inferred from
  // the manifest alone because asset-only shots have no local frames;
  // runRender compares this map with the immutable spec before any submit.
  const frameHashEntries = Object.entries(m.frameHashes!);
  const hashesInvalid = frameHashEntries.some(
    ([, hash]) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash),
  );
  if (hashesInvalid) {
    throw new VideoGenError(
      `${safeBasename(path)} has an invalid frame hash. Refusing to resume — the frozen frames cannot be verified.`,
      'store: frameHashes invalid',
    );
  }

  // Per-shot validation: a shot marked 'submitted' WITHOUT its remote handle
  // would be re-submitted on resume — a paid duplicate. Refuse truncated
  // entries outright; the operator fixes or discards the manifest.
  const VALID_STATES = new Set([
    'pending',
    'submitted',
    'done',
    'failed',
    'polling_stopped',
    'ambiguous',
  ]);
  const HANDLE_REQUIRED = new Set(['submitted', 'done', 'polling_stopped']);
  for (const [shotId, shot] of Object.entries(m.shots as Record<string, RenderShotState>)) {
    const badShot =
      !shot ||
      typeof shot !== 'object' ||
      !VALID_STATES.has(shot.state) ||
      (shot.attempt !== undefined && (!Number.isSafeInteger(shot.attempt) || shot.attempt < 1)) ||
      (HANDLE_REQUIRED.has(shot.state) && typeof shot.handle?.taskId !== 'string') ||
      (shot.handle !== undefined &&
        (typeof shot.requestFingerprint !== 'string' ||
          (shot.requestFingerprint !== 'manual-adopt' &&
            shot.handle.requestFingerprint !== shot.requestFingerprint)));
    if (badShot) {
      throw new VideoGenError(
        `${safeBasename(path)} has a broken entry for shot "${shotId}" (invalid state, attempt, or task handle). Refusing to resume — fix or discard the manifest.`,
        'store: manifest shot invalid',
      );
    }
  }
  return m as RenderJobManifest;
}

export type ComposeJobManifest = {
  jobId: string;
  kind: 'compose';
  state: 'concatenating' | 'done' | 'failed' | 'cancelled';
  /** Fingerprint over spec content + per-clip SHA-256. */
  fingerprint: string;
  clipHashes: Record<string, string>;
  finalVideoPath?: string | undefined;
  finalVideoHash?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
};

export type TimelineSegmentState = {
  narrationDurationSec?: number | undefined;
  narrationDegraded?: boolean | undefined;
  resolvedDurationSec?: number | undefined;
};

export type TimelineJobManifest = {
  jobId: string;
  kind: 'timeline';
  state: 'working' | 'done' | 'failed' | 'cancelled';
  /** Fingerprint over spec + per-image SHA-256 + voice/output params. */
  fingerprint: string;
  imageHashes: Record<string, string>;
  artifactHashes: Record<string, string>;
  segments: Record<string, TimelineSegmentState>;
  finalVideoPath?: string | undefined;
  finalVideoHash?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSha256Values(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
  );
}

export function loadTimelineJob(jobDir: string): TimelineJobManifest | undefined {
  const path = join(jobDir, 'manifest.json');
  const raw = readJsonFile<unknown>(path);
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || raw.kind !== 'timeline') {
    throw new VideoGenError(
      `This directory already holds a "${isRecord(raw) ? (raw.kind ?? 'unknown') : 'unknown'}" job manifest. Choose a different job directory.`,
      'store: foreign manifest',
    );
  }
  const manifest = raw as Partial<TimelineJobManifest>;
  const validStates = new Set(['working', 'done', 'failed', 'cancelled']);
  const segmentsValid =
    isRecord(manifest.segments) &&
    Object.values(manifest.segments).every(
      (segment) =>
        isRecord(segment) &&
        (segment.narrationDurationSec === undefined ||
          (typeof segment.narrationDurationSec === 'number' &&
            Number.isFinite(segment.narrationDurationSec) &&
            segment.narrationDurationSec >= 0)) &&
        (segment.resolvedDurationSec === undefined ||
          (typeof segment.resolvedDurationSec === 'number' &&
            Number.isFinite(segment.resolvedDurationSec) &&
            segment.resolvedDurationSec >= 0)) &&
        (segment.narrationDegraded === undefined || typeof segment.narrationDegraded === 'boolean'),
    );
  if (
    typeof manifest.jobId !== 'string' ||
    typeof manifest.state !== 'string' ||
    !validStates.has(manifest.state) ||
    typeof manifest.fingerprint !== 'string' ||
    manifest.fingerprint === '' ||
    !hasSha256Values(manifest.imageHashes) ||
    !hasSha256Values(manifest.artifactHashes) ||
    !segmentsValid ||
    (manifest.finalVideoHash !== undefined &&
      (typeof manifest.finalVideoHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(manifest.finalVideoHash))) ||
    (manifest.state === 'done' &&
      (typeof manifest.finalVideoPath !== 'string' ||
        typeof manifest.finalVideoHash !== 'string')) ||
    typeof manifest.updatedAt !== 'string'
  ) {
    throw new VideoGenError(
      'manifest.json is not a valid timeline manifest (wrong shape). Refusing to resume.',
      'store: timeline manifest shape invalid',
    );
  }
  if (manifest.jobId !== jobDir.split(/[\\/]/).pop()) {
    throw new VideoGenError(
      `manifest.json declares jobId "${manifest.jobId}" but lives in "${jobDir.split(/[\\/]/).pop()}" — refusing to resume.`,
      'store: timeline jobId mismatch',
    );
  }
  return manifest as TimelineJobManifest;
}

export function saveTimelineJob(jobDir: string, manifest: TimelineJobManifest): void {
  mkdirSync(jobDir, { recursive: true });
  writeJsonAtomic(join(jobDir, 'manifest.json'), {
    ...manifest,
    updatedAt: new Date().toISOString(),
  });
}

export function loadComposeJob(jobDir: string): ComposeJobManifest | undefined {
  const path = join(jobDir, 'manifest.json');
  const raw = readJsonFile<unknown>(path);
  if (raw === undefined) return undefined;
  // FAIL CLOSED: a directory that already holds a render/single manifest (or
  // any non-compose kind) is NOT a fresh compose job — treating it as one
  // would overwrite and destroy paid task recovery state.
  if (!isRecord(raw) || raw.kind !== 'compose') {
    throw new VideoGenError(
      `This directory already holds a "${isRecord(raw) ? (raw.kind ?? 'unknown') : 'unknown'}" job manifest. Choose a different job directory for compose — refusing to overwrite another job's state.`,
      'store: foreign manifest',
    );
  }
  const manifest = raw as Partial<ComposeJobManifest>;
  const validStates = new Set(['concatenating', 'done', 'failed', 'cancelled']);
  if (
    typeof manifest.jobId !== 'string' ||
    typeof manifest.state !== 'string' ||
    !validStates.has(manifest.state) ||
    typeof manifest.fingerprint !== 'string' ||
    manifest.fingerprint === '' ||
    !hasSha256Values(manifest.clipHashes) ||
    (manifest.finalVideoHash !== undefined &&
      (typeof manifest.finalVideoHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(manifest.finalVideoHash))) ||
    (manifest.state === 'done' &&
      (typeof manifest.finalVideoPath !== 'string' ||
        typeof manifest.finalVideoHash !== 'string')) ||
    typeof manifest.updatedAt !== 'string'
  ) {
    throw new VideoGenError(
      'manifest.json is not a valid compose manifest (wrong shape). Refusing to resume.',
      'store: compose manifest shape invalid',
    );
  }
  if (manifest.jobId !== jobDir.split(/[\\/]/).pop()) {
    throw new VideoGenError(
      `manifest.json declares jobId "${manifest.jobId}" but lives in "${jobDir.split(/[\\/]/).pop()}" — refusing to resume.`,
      'store: compose jobId mismatch',
    );
  }
  return manifest as ComposeJobManifest;
}

export function saveComposeJob(jobDir: string, manifest: ComposeJobManifest): void {
  mkdirSync(jobDir, { recursive: true });
  writeJsonAtomic(join(jobDir, 'manifest.json'), {
    ...manifest,
    updatedAt: new Date().toISOString(),
  });
}

export function loadRenderJob(jobDir: string): RenderJobManifest | undefined {
  const path = join(jobDir, 'manifest.json');
  const raw = readJsonFile<RenderJobManifest>(path);
  if (raw === undefined) return undefined;
  const manifest = validateRenderManifest(raw, path);
  // The parent directory IS the job identity: a manifest copied here from
  // another job would hijack the original job's remote handles.
  const dirName = jobDir.split(/[\\/]/).pop();
  if (manifest.jobId !== dirName) {
    throw new VideoGenError(
      `manifest.json declares jobId "${manifest.jobId}" but lives in "${dirName}" — the job is corrupted or misplaced. Refusing to resume.`,
      'store: render jobId mismatch',
    );
  }
  return manifest;
}

export function saveRenderJob(jobDir: string, manifest: RenderJobManifest): void {
  writeJsonAtomic(join(jobDir, 'manifest.json'), {
    ...manifest,
    updatedAt: new Date().toISOString(),
  });
}

export function saveSingleJob(outputDir: string, manifest: SingleJobManifest): void {
  const realDir = ensureSingleJobDir(outputDir, manifest.jobId);
  writeJsonAtomic(manifestPathFor(realDir), { ...manifest, updatedAt: new Date().toISOString() });
}

/**
 * Guard against concurrent writes to the same job directory. Process-local:
 * two tool executions in one extension instance cannot interleave manifest
 * updates for the same job.
 */
export class ActiveJobs {
  private readonly active = new Set<string>();

  /** Mark a job dir active; throws if already active. Returns a release fn. */
  acquire(jobDir: string): () => void {
    if (this.active.has(jobDir)) {
      throw new VideoGenError(
        'That job is already running in this session. Wait for it to finish (or cancel it) before rerunning.',
        'store: job already active',
      );
    }
    this.active.add(jobDir);
    return () => {
      this.active.delete(jobDir);
    };
  }
}
