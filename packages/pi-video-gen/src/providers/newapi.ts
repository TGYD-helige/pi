import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  AmbiguousSubmitError,
  httpStatusError,
  missingKeyError,
  networkError,
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
import { downloadFile } from './task.js';

/**
 * NewAPI video generation format (self-hosted OpenAI-compatible relay:
 * Kling / Jimeng / Gemini / Vidu channels behind one shape).
 *
 *   POST {baseUrl}/v1/video/generations           → 201 { id, task_id, status }
 *   GET  {baseUrl}/v1/video/generations/{task_id} → { status, url, error }
 *
 * Verified against the official docs (newapi.ai/zh/docs/api/ai-model/videos,
 * 2026-07 — createvideogeneration + getvideogeneration):
 * - NewAPI is self-hosted, so this wire format has NO default endpoint —
 *   baseUrl is mandatory and the config layer rejects resolution without it.
 *   Both the server root ("https://host") and the OpenAI-style
 *   "https://host/v1" forms are accepted (a trailing /v1 is normalized away).
 * - Top-level params per the docs: model/prompt (required), duration, fps,
 *   width/height, image (URL or Base64), metadata, n, response_format, seed,
 *   user. Everything channel-specific rides in `metadata` — following the
 *   doc examples we send aspect_ratio + resolution (Jimeng/Vidu style),
 *   image_tail (Kling style) and image_urls (Jimeng style) there.
 * - Submit returns BOTH `id` and `task_id`; the query endpoint keys on
 *   `task_id`, so we prefer it and fall back to `id`.
 * - Query status enum: queued | processing | in_progress | succeeded |
 *   failed; the mp4 URL arrives in `url` on success.
 * - No audio toggle and no client idempotency key are documented: a
 *   capability-driven generateAudio is NOT forwarded, and ambiguous submit
 *   failures get the "check the console before retrying" treatment (same as
 *   Ark/OpenRouter).
 *
 * TWO response shapes exist in the wild (verified against a live NewAPI
 * relay, 2026-07): channels proxied in the documented OpenAI-compatible way
 * answer FLAT ({status: "succeeded", url, error}), while channels routed
 * through NewAPI's task framework (Kling/Jimeng/Seedance-as-task) answer
 * with the framework ENVELOPE:
 *
 *   {code: "success", message,
 *    data: {task_id, status: "IN_PROGRESS"|"SUCCESS"|"FAILURE"|…, progress,
 *           fail_reason, result_url, data: {<raw upstream response>}}}
 *
 * i.e. uppercase framework statuses, the mp4 in `result_url` (or nested in
 * the upstream payload at `data.data.content.video_url` for Ark upstreams),
 * and the failure text in `fail_reason`. unwrapTaskRecord() peels the
 * envelope once and the status mapping is case-insensitive, so both shapes
 * parse identically.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

async function imageFileToDataUri(path: string): Promise<string> {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) {
    throw new VideoGenError(
      `Reference image must be png/jpg/webp: ${safeBasename(path)}`,
      'newapi: unsupported image extension',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new VideoGenError(
      `Reference image is not readable: ${safeBasename(path)}`,
      'newapi: image unreadable',
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** Server root for the API paths: trims trailing slashes and one trailing /v1. */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/**
 * Peel the NewAPI task-framework envelope `{code, message, data}` ONE layer
 * when present, returning the bare task record. Flat documented responses
 * (and the nested upstream payload at `record.data`, which must NOT be
 * peeled) pass through untouched: only a root `code` alongside an object
 * `data` marks the envelope.
 */
function unwrapTaskRecord(json: Record<string, unknown>): Record<string, unknown> {
  const data = json.data;
  if (json.code !== undefined && data != null && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return json;
}

function ambiguousSubmitError(error?: unknown): AmbiguousSubmitError {
  return new AmbiguousSubmitError(
    'Task creation failed with an ambiguous result (network error or server 5xx). The provider MAY have created a paid task — check the NewAPI logs/console before retrying to avoid double billing.',
    'newapi submit: ambiguous outcome',
    error,
  );
}

export const newapiAdapter: VideoProviderAdapter = {
  async submit(provider, remoteModelId, params, fetchImpl, signal): Promise<RemoteTaskHandle> {
    if (!provider.apiKey) throw missingKeyError('newapi', 'NEWAPI_API_KEY', provider.apiKeyPath);

    const body: Record<string, unknown> = { model: remoteModelId, prompt: params.prompt };
    if (params.durationSec != null) body.duration = params.durationSec;
    if (params.firstFramePath) {
      body.image = await imageFileToDataUri(params.firstFramePath);
    }

    const metadata: Record<string, unknown> = {};
    if (params.aspectRatio) metadata.aspect_ratio = params.aspectRatio;
    if (params.resolution) metadata.resolution = params.resolution;
    if (params.lastFramePath) {
      metadata.image_tail = await imageFileToDataUri(params.lastFramePath);
    }
    if (params.referenceImagePaths?.length) {
      metadata.image_urls = await Promise.all(
        params.referenceImagePaths.map((path) => imageFileToDataUri(path)),
      );
    }
    if (Object.keys(metadata).length > 0) body.metadata = metadata;

    let res: Response;
    try {
      res = await fetchImpl(`${serverRoot(provider.baseUrl)}/v1/video/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (error) {
      throw ambiguousSubmitError(error);
    }
    if (!res.ok) {
      if (res.status >= 500)
        throw ambiguousSubmitError(Object.assign(new Error(), { status: res.status }));
      throw httpStatusError('newapi', 'submit', res.status);
    }

    let taskId: string | undefined;
    try {
      const rec = unwrapTaskRecord((await res.json()) as Record<string, unknown>);
      taskId = (rec.task_id ?? rec.id) as string | undefined;
    } catch (error) {
      throw ambiguousSubmitError(error);
    }
    if (!taskId) {
      // 2xx but no id: the task MAY exist server-side — this is ambiguous,
      // not a clean failure, and must park the shot rather than re-submit.
      throw new AmbiguousSubmitError(
        'The provider accepted the request but returned no task id. Not retrying automatically; check the NewAPI logs/console.',
        'newapi submit: no task id',
      );
    }
    return {
      taskId,
      submittedAt: new Date().toISOString(),
      requestFingerprint: requestFingerprint(remoteModelId, params),
    };
  },

  async inspect(provider, handle, fetchImpl, signal): Promise<RemoteTaskStatus> {
    if (!provider.apiKey) throw missingKeyError('newapi', 'NEWAPI_API_KEY', provider.apiKeyPath);

    let res: Response;
    try {
      res = await fetchImpl(
        `${serverRoot(provider.baseUrl)}/v1/video/generations/${encodeURIComponent(handle.taskId)}`,
        {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: signal ?? null,
        },
      );
    } catch (error) {
      throw networkError('newapi', 'inspect', error);
    }
    if (!res.ok) throw httpStatusError('newapi', 'inspect', res.status);

    const rec = unwrapTaskRecord((await res.json()) as Record<string, unknown>) as {
      status?: string;
      url?: string;
      result_url?: string;
      fail_reason?: string;
      error?: string | { message?: string } | null;
      data?: { content?: { video_url?: string } };
    };
    // Case-insensitive: flat form uses lowercase, the task framework UPPERCASE.
    switch (rec.status?.toUpperCase()) {
      case 'QUEUED':
      case 'SUBMITTED':
        return { phase: 'pending' };
      case 'PROCESSING':
      case 'IN_PROGRESS':
        return { phase: 'running' };
      case 'SUCCEEDED':
      case 'SUCCESS':
      case 'COMPLETED': {
        const videoUrl = rec.result_url ?? rec.url ?? rec.data?.content?.video_url;
        if (!videoUrl) {
          throw new VideoGenError(
            'The task succeeded but returned no video URL. Report this with the task id.',
            'newapi inspect: succeeded without url',
          );
        }
        return { phase: 'succeeded', videoUrl };
      }
      case 'FAILED':
      case 'FAILURE':
      case 'CANCELLED':
      case 'EXPIRED': {
        const message =
          rec.fail_reason ||
          (typeof rec.error === 'string' ? rec.error : rec.error?.message) ||
          'unknown provider error';
        return { phase: 'failed', message };
      }
      default:
        throw new VideoGenError(
          `The provider returned an unknown task status. Task id kept for support: ${handle.taskId}.`,
          'newapi inspect: unknown status',
        );
    }
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

  // cancel: no documented task-cancellation endpoint in the NewAPI video format.
};
