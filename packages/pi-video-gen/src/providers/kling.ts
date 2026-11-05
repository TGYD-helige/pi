import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  AmbiguousSubmitError,
  httpStatusError,
  missingKeyError,
  networkError,
  RemoteTaskNotFoundError,
  safeBasename,
  VideoGenError,
} from '../errors.js';
import type {
  RemoteTaskHandle,
  RemoteTaskStatus,
  VideoFileMeta,
  VideoProviderAdapter,
} from '../types.js';
import { requestFingerprint } from './request.js';
import { CancelledError, downloadFile } from './task.js';

/**
 * Kling (Kuaishou) video generation — official Kling API 2.0.
 *
 *   POST {baseUrl}/text-to-video/{model}          { prompt, settings, options }
 *   POST {baseUrl}/image-to-video/{model}         { contents, settings, options }
 *   GET  {baseUrl}/tasks?task_ids={id}            → data[0].status / outputs[].url
 *
 * Verified against the official docs (kling.ai/document-api, 2026-07):
 * - Auth: `Authorization: Bearer {apiKey}` — the older JWT ak/sk scheme is legacy.
 * - The model lives in the PATH (`kling-3.0-turbo`, `kling-3.0`), not the body.
 * - t2v takes a plain `prompt` string; i2v takes a `contents` array
 *   (prompt + first_frame [+ last_frame]). i2v follows the frame's ratio, so
 *   aspect_ratio is t2v-only.
 * - `options.external_task_id` is a client-provided, account-unique id that is
 *   QUERYABLE (GET /tasks?external_task_ids=…) — we set it to our request
 *   fingerprint, so an ambiguous submit failure can be resolved by lookup
 *   instead of blindly resubmitting a paid task. See recoverByExternalId().
 * - Kling 3.0 (Omni) adds last_frame, audio: "native"|"off", and 4k; the 3.0
 *   Turbo is first-frame-only and silent.
 * - Default base is api-singapore.klingai.com (the documented current domain);
 *   China-region accounts can point baseUrl at their regional endpoint.
 */

export const KLING_DEFAULT_BASE_URL = 'https://api-singapore.klingai.com';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

async function imageFileToDataUri(path: string): Promise<string> {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) {
    throw new VideoGenError(
      `Reference image must be png/jpg (Kling accepts no webp): ${safeBasename(path)}`,
      'kling: unsupported image extension',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new VideoGenError(
      `Reference image is not readable: ${safeBasename(path)}`,
      'kling: image unreadable',
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

type RecoverResult =
  | { outcome: 'found'; handle: RemoteTaskHandle }
  | { outcome: 'not-found' }
  | { outcome: 'unknown' };

/**
 * Shared ambiguous-outcome resolver with THREE honest results:
 * - found: the task exists — adopt its handle (no double billing);
 * - not-found: lookup CONFIRMED nothing was created — safe to retry;
 * - unknown: lookup itself failed/timed out — a paid task MAY exist;
 *   the message must warn, not reassure. On user-cancel the same
 *   distinction applies instead of a bare CancelledError.
 */
async function resolveAmbiguous(
  provider: { apiKey?: string | undefined; baseUrl: string },
  fp: string,
  taskType: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  cause?: unknown,
): Promise<RemoteTaskHandle> {
  const r = await tryRecoverByExternalId(provider, fp, taskType, fetchImpl);
  if (r.outcome === 'found') return r.handle;
  if (signal?.aborted) {
    if (r.outcome === 'not-found') throw new CancelledError();
    throw new AmbiguousSubmitError(
      'Cancelled before we could verify whether the task was created. A paid task MAY exist — check the Kling console for this external id before retrying, or you may be billed twice.',
      'kling submit: aborted, recovery unknown',
      signal?.reason ?? cause,
    );
  }
  if (r.outcome === 'not-found') {
    throw new VideoGenError(
      'Task creation failed, but a lookup by external id confirmed NO task was created — nothing was billed. Safe to retry once.',
      'kling submit: failed, verified not created',
      cause,
    );
  }
  throw new AmbiguousSubmitError(
    'Task creation failed with an ambiguous result and the idempotency lookup could not complete. A paid task MAY exist — check the Kling console before retrying to avoid double billing.',
    'kling submit: ambiguous, recovery unknown',
    cause,
  );
}

type KlingEnvelope<T> = { code?: number; message?: string; data?: T };

function checkEnvelope<T>(envelope: KlingEnvelope<T>, action: string): T {
  if (envelope.code !== 0) {
    throw new VideoGenError(
      `Kling ${action} rejected the request (code ${envelope.code ?? 'unknown'}). Check the model name and parameters.`,
      `kling ${action}: code ${envelope.code ?? 'unknown'}`,
    );
  }
  return envelope.data as T;
}

type KlingTask = {
  id?: string;
  status?: string;
  message?: string;
  outputs?: { type?: string; url?: string }[];
};

function mapTask(task: KlingTask, handle: RemoteTaskHandle): RemoteTaskStatus {
  switch (task.status) {
    case 'submitted':
      return { phase: 'pending' };
    case 'processing':
      return { phase: 'running' };
    case 'succeeded': {
      const videoUrl = task.outputs?.find((o) => o.type === 'video')?.url;
      if (!videoUrl) {
        throw new VideoGenError(
          'The task succeeded but returned no video URL. Report this with the task id.',
          'kling inspect: succeeded without url',
        );
      }
      return { phase: 'succeeded', videoUrl };
    }
    case 'failed':
      return { phase: 'failed', message: task.message ?? 'unknown provider error' };
    default:
      throw new VideoGenError(
        `The provider returned an unknown task status. Task id kept for support: ${handle.taskId}.`,
        'kling inspect: unknown status',
      );
  }
}

export const klingAdapter: VideoProviderAdapter = {
  async submit(provider, remoteModelId, params, fetchImpl, signal): Promise<RemoteTaskHandle> {
    if (!provider.apiKey) throw missingKeyError('kling', 'KLING_API_KEY', provider.apiKeyPath);

    const taskType = params.firstFramePath ? 'image-to-video' : 'text-to-video';
    const fp = requestFingerprint(remoteModelId, params);

    const settings: Record<string, unknown> = {};
    if (params.resolution) settings.resolution = params.resolution;
    if (params.durationSec != null) settings.duration = params.durationSec;
    if (params.generateAudio === true) settings.audio = 'native';

    const body: Record<string, unknown> = {
      settings,
      options: { external_task_id: fp, watermark_info: { enabled: false } },
    };
    if (taskType === 'text-to-video') {
      body.prompt = params.prompt;
      if (params.aspectRatio) settings.aspect_ratio = params.aspectRatio;
    } else {
      const contents: Record<string, unknown>[] = [{ type: 'prompt', text: params.prompt }];
      contents.push({ type: 'first_frame', url: await imageFileToDataUri(params.firstFramePath!) });
      if (params.lastFramePath) {
        contents.push({ type: 'last_frame', url: await imageFileToDataUri(params.lastFramePath) });
      }
      body.contents = contents;
    }

    let res: Response;
    try {
      res = await fetchImpl(`${provider.baseUrl}/${taskType}/${remoteModelId}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (error) {
      // Network failure = ambiguous. Recover via external-id lookup (fresh
      // timeout, never the caller's possibly-aborted signal).
      return resolveAmbiguous(provider, fp, taskType, fetchImpl, signal, error);
    }
    if (!res.ok) {
      if (res.status >= 500) {
        return resolveAmbiguous(
          provider,
          fp,
          taskType,
          fetchImpl,
          signal,
          Object.assign(new Error(), { status: res.status }),
        );
      }
      throw httpStatusError('kling', 'submit', res.status);
    }

    // Body read/parse failures are JUST as ambiguous as a dead connection —
    // the task may already exist. Recover the same way.
    let taskId: string | undefined;
    try {
      const json = (await res.json()) as KlingEnvelope<{ id?: string }>;
      taskId = checkEnvelope(json, 'submit').id;
    } catch (error) {
      if (error instanceof VideoGenError && error.logSummary.startsWith('kling submit: code'))
        throw error;
      return resolveAmbiguous(provider, fp, taskType, fetchImpl, signal, error);
    }
    if (!taskId) {
      // 2xx but no id: the task MAY exist server-side — this is ambiguous,
      // not a clean failure, and must park the shot rather than re-submit.
      throw new AmbiguousSubmitError(
        'The provider accepted the request but returned no task id. Not retrying automatically; check the Kling console.',
        'kling submit: no task id',
      );
    }
    return {
      taskId,
      submittedAt: new Date().toISOString(),
      requestFingerprint: fp,
      meta: { taskType },
    };
  },

  async inspect(provider, handle, fetchImpl, signal): Promise<RemoteTaskStatus> {
    if (!provider.apiKey) throw missingKeyError('kling', 'KLING_API_KEY', provider.apiKeyPath);

    let res: Response;
    try {
      res = await fetchImpl(
        `${provider.baseUrl}/tasks?task_ids=${encodeURIComponent(handle.taskId)}`,
        {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: signal ?? null,
        },
      );
    } catch (error) {
      throw networkError('kling', 'inspect', error);
    }
    if (!res.ok) throw httpStatusError('kling', 'inspect', res.status);

    const json = (await res.json()) as KlingEnvelope<KlingTask[]>;
    const tasks = checkEnvelope(json, 'inspect');
    const task = Array.isArray(tasks) ? tasks.find((t) => t.id === handle.taskId) : undefined;
    if (!task) {
      throw new RemoteTaskNotFoundError(
        `Task ${handle.taskId} not found on the provider (results are cleared after 30 days). Start a fresh generation.`,
        'kling inspect: task not found',
      );
    }
    return mapTask(task, handle);
  },

  async downloadTo(
    provider,
    _handle,
    videoUrl,
    destPath,
    fetchImpl,
    signal,
  ): Promise<VideoFileMeta> {
    return downloadFile({ url: videoUrl, destPath, fetchImpl, provider, signal });
  },

  // cancel: no documented task-cancellation endpoint on Kling API 2.0.
};

/**
 * Best-effort idempotency lookup with its OWN short timeout — the caller's
 * signal may already be aborted (that's why we're here), and the lookup must
 * still run to tell whether a paid task exists. Returns null on any failure;
 * callers decide between CancelledError (user aborted) and ambiguous error.
 */
/** Exported for tests: the lookup deadline is injectable (default 10s). */
export async function tryRecoverByExternalId(
  provider: { apiKey?: string | undefined; baseUrl: string },
  fp: string,
  taskType: string,
  fetchImpl: typeof fetch,
  timeoutMs = 10_000,
): Promise<RecoverResult> {
  try {
    const res = await fetchImpl(`${provider.baseUrl}/tasks?external_task_ids=${fp}`, {
      headers: { authorization: `Bearer ${provider.apiKey!}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { outcome: 'unknown' };
    let json: KlingEnvelope<KlingTask[]>;
    try {
      json = (await res.json()) as KlingEnvelope<KlingTask[]>;
    } catch {
      return { outcome: 'unknown' };
    }
    // STRICT shape: a provider-side error envelope ({code: 50001, message:
    // "busy"}) or a data payload that is not a task list tells us NOTHING
    // about task existence — it must read as 'unknown', never as the
    // confident 'not-found' (which green-lights a retry).
    if (json.code !== 0 || !Array.isArray(json.data)) return { outcome: 'unknown' };
    const existing = json.data.find((t) => t.id);
    if (!existing?.id) return { outcome: 'not-found' };
    return {
      outcome: 'found',
      handle: {
        taskId: existing.id,
        submittedAt: new Date().toISOString(),
        requestFingerprint: fp,
        meta: { taskType },
      },
    };
  } catch {
    return { outcome: 'unknown' };
  }
}
