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
 * MiniMax video generation API v2 (MiniMax-H3).
 *
 *   POST {baseUrl}/v2/video_generation              → { task_id }
 *   GET  {baseUrl}/v2/query/video_generation/{id}   → task.status / task.content.url
 *
 * Docs: https://platform.minimax.io/docs/api-reference/video-generation-v2-create
 * (China mirror: platform.minimaxi.com — same schema, host api.minimaxi.com).
 *
 * - Auth: `Authorization: Bearer {apiKey}`; keys are REGION-LOCKED — an
 *   international (minimax.io) key 401s on api.minimaxi.com and vice versa.
 * - The prompt and frames ride in a multimodal `content` array: one required
 *   `text` item plus `image_url` items carrying a `role`
 *   (first_frame / last_frame / reference_image). Images may be public URLs
 *   or base64 data URIs — we always send data URIs read from local files.
 * - `ratio`: REQUIRED and non-adaptive for text-to-video; IGNORED (forced
 *   adaptive) once a first frame is present; optional for reference-only.
 * - v2 has NO audio toggle, NO idempotency/external-task-id field and NO
 *   documented cancel endpoint — an ambiguous submit is parked for manual
 *   resolution, never auto-retried (same policy as dashscope/newapi).
 * - The result URL at task.content.url is a time-limited CDN link — download
 *   promptly. Tasks are queryable for 7 days.
 */

// International default; mainland-China accounts set baseUrl to
// https://api.minimaxi.com (keys do not work cross-region).
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io';

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
      'minimax: unsupported image extension',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new VideoGenError(
      `Reference image is not readable: ${safeBasename(path)}`,
      'minimax: image unreadable',
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function ambiguousSubmitError(error?: unknown): AmbiguousSubmitError {
  return new AmbiguousSubmitError(
    'Task creation failed with an ambiguous result (network error or server 5xx). The provider MAY have created a paid task — check the MiniMax console before retrying to avoid double billing.',
    'minimax submit: ambiguous outcome',
    error,
  );
}

type MinimaxTask = {
  id?: string;
  status?: string;
  error?: { code?: string; message?: string };
  content?: { url?: string };
};

function mapTask(task: MinimaxTask, handle: RemoteTaskHandle): RemoteTaskStatus {
  switch (task.status) {
    case 'queued':
      return { phase: 'pending' };
    case 'running':
      return { phase: 'running' };
    case 'succeeded': {
      const videoUrl = task.content?.url;
      if (!videoUrl) {
        throw new VideoGenError(
          'The task succeeded but returned no video URL. Report this with the task id.',
          'minimax inspect: succeeded without url',
        );
      }
      return { phase: 'succeeded', videoUrl };
    }
    case 'failed':
      return { phase: 'failed', message: task.error?.message ?? 'unknown provider error' };
    case 'cancelled':
      return { phase: 'failed', message: 'task was cancelled on the provider' };
    default:
      throw new VideoGenError(
        `The provider returned an unknown task status. Task id kept for support: ${handle.taskId}.`,
        'minimax inspect: unknown status',
      );
  }
}

export const minimaxAdapter: VideoProviderAdapter = {
  async submit(provider, remoteModelId, params, fetchImpl, signal): Promise<RemoteTaskHandle> {
    if (!provider.apiKey) {
      throw missingKeyError('minimax', 'MINIMAX_API_KEY', provider.apiKeyPath);
    }
    if (params.lastFramePath && !params.firstFramePath) {
      throw new VideoGenError(
        'MiniMax requires a first frame when a last frame is given. Add firstFrame or remove lastFrame.',
        'minimax: last frame without first frame',
      );
    }
    if (params.firstFramePath && params.referenceImagePaths?.length) {
      throw new VideoGenError(
        'MiniMax supports either first/last frames OR reference images, not both in one call.',
        'minimax: mixed frame and references',
      );
    }

    const content: Record<string, unknown>[] = [{ type: 'text', text: params.prompt }];
    const pushImage = async (role: string, path: string) => {
      content.push({
        type: 'image_url',
        image_url: { url: await imageFileToDataUri(path) },
        role,
      });
    };
    if (params.firstFramePath) await pushImage('first_frame', params.firstFramePath);
    if (params.lastFramePath) await pushImage('last_frame', params.lastFramePath);
    for (const path of params.referenceImagePaths ?? []) await pushImage('reference_image', path);

    const body: Record<string, unknown> = {
      model: remoteModelId,
      content,
      aigc_watermark: false,
    };
    if (params.resolution) body.resolution = params.resolution;
    if (params.durationSec != null) body.duration = params.durationSec;
    // A first frame forces ratio=adaptive server-side — sending one is ignored;
    // t2v requires a concrete ratio, reference-only takes it optionally.
    if (params.aspectRatio && !params.firstFramePath) body.ratio = params.aspectRatio;

    let res: Response;
    try {
      res = await fetchImpl(`${provider.baseUrl}/v2/video_generation`, {
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
      throw httpStatusError('minimax', 'submit', res.status);
    }

    let taskId: string | undefined;
    try {
      const json = (await res.json()) as { task_id?: string };
      taskId = json.task_id;
    } catch (error) {
      throw ambiguousSubmitError(error);
    }
    if (!taskId) {
      // 2xx but no id: the task MAY exist server-side — this is ambiguous,
      // not a clean failure, and must park the shot rather than re-submit.
      throw new AmbiguousSubmitError(
        'The provider accepted the request but returned no task id. Not retrying automatically; check the MiniMax console.',
        'minimax submit: no task id',
      );
    }
    return {
      taskId,
      submittedAt: new Date().toISOString(),
      requestFingerprint: requestFingerprint(remoteModelId, params),
    };
  },

  async inspect(provider, handle, fetchImpl, signal): Promise<RemoteTaskStatus> {
    if (!provider.apiKey) {
      throw missingKeyError('minimax', 'MINIMAX_API_KEY', provider.apiKeyPath);
    }

    let res: Response;
    try {
      res = await fetchImpl(
        `${provider.baseUrl}/v2/query/video_generation/${encodeURIComponent(handle.taskId)}`,
        {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: signal ?? null,
        },
      );
    } catch (error) {
      throw networkError('minimax', 'inspect', error);
    }
    if (!res.ok) throw httpStatusError('minimax', 'inspect', res.status);

    const json = (await res.json()) as { task?: MinimaxTask };
    if (!json.task || typeof json.task !== 'object') {
      throw new VideoGenError(
        'The provider returned a malformed task payload. Task id kept for support.',
        'minimax inspect: malformed payload',
      );
    }
    return mapTask(json.task, handle);
  },

  async downloadTo(
    provider,
    _handle,
    videoUrl,
    destPath,
    fetchImpl,
    signal,
  ): Promise<VideoFileMeta> {
    // MiniMax result URLs are time-limited CDN links; download promptly.
    return downloadFile({ url: videoUrl, destPath, fetchImpl, provider, signal });
  },

  // cancel: no documented task-cancellation endpoint on the v2 API.
};
