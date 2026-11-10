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
import { findBuiltInModel } from './models.js';
import { requestFingerprint } from './request.js';
import { downloadFile } from './task.js';

/**
 * Alibaba DashScope video generation (HappyHorse and Wan 3.0).
 *
 *   POST {baseUrl}/api/v1/services/aigc/video-generation/video-synthesis
 *        (headers: X-DashScope-Async: enable)   → output.task_id
 *   GET  {baseUrl}/api/v1/tasks/{taskId}       → output.task_status / video_url
 *   POST {baseUrl}/api/v1/tasks/{taskId}/cancel (generic DashScope task API)
 *
 * HappyHorse family routing (Wan 3.0 keeps its model id unchanged):
 *   no images            → {family}-t2v
 *   firstFramePath       → {family}-i2v   (exactly ONE first frame, ratio follows image)
 *   referenceImagePaths  → {family}-r2v   (1-9 reference images, prompt uses [Image N])
 * firstFrame + references together are NOT supported (i2v and r2v are distinct
 * modes); only Wan 3.0 supports last-frame interpolation and parameters.audio.
 *
 * Workspace note: the default baseUrl is the classic dashscope.aliyuncs.com,
 * which needs NO workspace id. New Bailian workspaces use a per-workspace
 * hostname — set providers.dashscope.baseUrl to
 * https://{workspaceId}.cn-beijing.maas.aliyuncs.com — and aggregators speaking
 * this wire format just point customProviders at themselves.
 *
 * Docs: https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference
 * (and the image-to-video / reference-to-video siblings)
 */

export const DASHSCOPE_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';

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
      'dashscope: unsupported image extension',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new VideoGenError(
      `Reference image is not readable: ${safeBasename(path)}`,
      'dashscope: image unreadable',
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function ambiguousSubmitError(error?: unknown): AmbiguousSubmitError {
  return new AmbiguousSubmitError(
    'Task creation failed with an ambiguous result (network error or server 5xx). The provider MAY have created a paid task — check the DashScope console before retrying to avoid double billing.',
    'dashscope submit: ambiguous outcome',
    error,
  );
}

export const dashscopeAdapter: VideoProviderAdapter = {
  async submit(provider, remoteModelId, params, fetchImpl, signal): Promise<RemoteTaskHandle> {
    if (!provider.apiKey) {
      throw missingKeyError('dashscope', 'DASHSCOPE_API_KEY', provider.apiKeyPath);
    }
    const isWan3 = /^wan3\.0-video(?:-prime)?$/i.test(
      findBuiltInModel(remoteModelId)?.id ?? remoteModelId,
    );
    if (params.lastFramePath && !isWan3) {
      throw new VideoGenError(
        'HappyHorse does not support last-frame interpolation. Remove lastFramePath.',
        'dashscope: last frame unsupported',
      );
    }
    if (params.lastFramePath && !params.firstFramePath) {
      throw new VideoGenError(
        'A last frame requires a first frame.',
        'dashscope: last frame without first frame',
      );
    }
    if ((params.firstFramePath || params.lastFramePath) && params.referenceImagePaths?.length) {
      throw new VideoGenError(
        'Use either a first frame (and optional last frame) OR reference images, not both in one call.',
        'dashscope: mixed frame and references',
      );
    }

    // Model family routing: strip a trailing -t2v/-i2v/-r2v if the caller
    // passed one, then re-derive from the actual params.
    const family = remoteModelId.replace(/-(t2v|i2v|r2v)$/, '');
    const media: Record<string, unknown>[] = [];
    let model: string;
    if (params.referenceImagePaths?.length) {
      model = isWan3 ? remoteModelId : `${family}-r2v`;
      for (const path of params.referenceImagePaths) {
        media.push({ type: 'reference_image', url: await imageFileToDataUri(path) });
      }
    } else if (params.firstFramePath) {
      model = isWan3 ? remoteModelId : `${family}-i2v`;
      media.push({ type: 'first_frame', url: await imageFileToDataUri(params.firstFramePath) });
      if (params.lastFramePath)
        media.push({ type: 'last_frame', url: await imageFileToDataUri(params.lastFramePath) });
    } else {
      model = isWan3 ? remoteModelId : `${family}-t2v`;
    }

    const parameters: Record<string, unknown> = { watermark: false };
    if (isWan3 && params.generateAudio != null) parameters.audio = params.generateAudio;
    if (params.resolution) parameters.resolution = params.resolution;
    // i2v follows the frame's aspect ratio — ratio is rejected there.
    if (params.aspectRatio && (isWan3 || model !== `${family}-i2v`))
      parameters.ratio = params.aspectRatio;
    if (params.durationSec != null) parameters.duration = params.durationSec;

    const body = {
      model,
      input: { prompt: params.prompt, ...(media.length > 0 ? { media } : {}) },
      parameters,
    };

    let res: Response;
    try {
      res = await fetchImpl(
        `${provider.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${provider.apiKey}`,
            'content-type': 'application/json',
            'x-dashscope-async': 'enable',
          },
          body: JSON.stringify(body),
          signal: signal ?? null,
        },
      );
    } catch (error) {
      throw ambiguousSubmitError(error);
    }
    if (!res.ok) {
      if (res.status >= 500)
        throw ambiguousSubmitError(Object.assign(new Error(), { status: res.status }));
      throw httpStatusError('dashscope', 'submit', res.status);
    }

    let taskId: string | undefined;
    try {
      const json = (await res.json()) as { output?: { task_id?: string } };
      taskId = json.output?.task_id;
    } catch (error) {
      throw ambiguousSubmitError(error);
    }
    if (!taskId) {
      // 2xx but no id: the task MAY exist server-side — this is ambiguous,
      // not a clean failure, and must park the shot rather than re-submit.
      throw new AmbiguousSubmitError(
        'The provider accepted the request but returned no task id. Not retrying automatically; check the DashScope console.',
        'dashscope submit: no task id',
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
      throw missingKeyError('dashscope', 'DASHSCOPE_API_KEY', provider.apiKeyPath);
    }

    let res: Response;
    try {
      res = await fetchImpl(
        `${provider.baseUrl}/api/v1/tasks/${encodeURIComponent(handle.taskId)}`,
        {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: signal ?? null,
        },
      );
    } catch (error) {
      throw networkError('dashscope', 'inspect', error);
    }
    if (!res.ok) throw httpStatusError('dashscope', 'inspect', res.status);

    const json = (await res.json()) as {
      output?: { task_status?: string; video_url?: string; message?: string };
    };
    switch (json.output?.task_status) {
      case 'PENDING':
        return { phase: 'pending' };
      case 'RUNNING':
        return { phase: 'running' };
      case 'SUCCEEDED': {
        const videoUrl = json.output?.video_url;
        if (!videoUrl) {
          throw new VideoGenError(
            'The task succeeded but returned no video URL. Report this with the task id.',
            'dashscope inspect: succeeded without url',
          );
        }
        return { phase: 'succeeded', videoUrl };
      }
      case 'FAILED':
        return { phase: 'failed', message: json.output?.message ?? 'unknown provider error' };
      case 'CANCELED':
        return { phase: 'failed', message: 'task was cancelled on the provider' };
      case 'UNKNOWN':
        return { phase: 'failed', message: 'task unknown or expired (task ids live 24h)' };
      default:
        throw new VideoGenError(
          `The provider returned an unknown task status. Task id kept for support: ${handle.taskId}.`,
          'dashscope inspect: unknown status',
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
    // DashScope result URLs are signed OSS links (24h expiry); download promptly.
    return downloadFile({ url: videoUrl, destPath, fetchImpl, provider, signal });
  },

  /** Generic DashScope task cancellation: POST /api/v1/tasks/{id}/cancel. */
  async cancel(provider, handle, fetchImpl, signal): Promise<{ cancelled: boolean }> {
    if (!provider.apiKey) {
      throw missingKeyError('dashscope', 'DASHSCOPE_API_KEY', provider.apiKeyPath);
    }
    let res: Response;
    try {
      res = await fetchImpl(
        `${provider.baseUrl}/api/v1/tasks/${encodeURIComponent(handle.taskId)}/cancel`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: signal ?? null,
        },
      );
    } catch (error) {
      throw networkError('dashscope', 'cancel', error);
    }
    if (!res.ok) throw httpStatusError('dashscope', 'cancel', res.status);
    return { cancelled: true };
  },
};
