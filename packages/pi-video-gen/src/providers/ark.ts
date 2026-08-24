import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  AmbiguousSubmitError,
  httpStatusError,
  missingKeyError,
  networkError,
  redactUrl,
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
 * Volcengine Ark video generation (ByteDance Seedance series).
 *
 *   POST {baseUrl}/contents/generations/tasks         → { id }
 *   GET  {baseUrl}/contents/generations/tasks/{id}    → { status, content.video_url }
 *
 * Seedance 2.0 takes structured params (resolution/ratio/duration/
 * generate_audio/watermark) alongside the content array.
 * Local reference images and provider-managed image/video/audio assets ride
 * in the content array with their modality-specific URL field and role.
 *
 * Docs: https://www.volcengine.com/docs/82379/1520757
 *
 * Idempotency note (per design review): Ark's task-creation idempotency
 * support (client token / idempotency key / task-list lookup) is UNVERIFIED
 * until the M0 probe reports. So submit() never silently retries: 4xx fails
 * fast (the request won't become valid), and network/5xx failures raise an
 * AMBIGUOUS error that tells the user to check the console for a possibly
 * created paid task before retrying.
 */

export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

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
      'ark: unsupported image extension',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new VideoGenError(
      `Reference image is not readable: ${safeBasename(path)}`,
      'ark: image unreadable',
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}

export { requestFingerprint as fingerprint };

/** Thrown when submit failed without a definitive server verdict (network/5xx). */
function ambiguousSubmitError(): AmbiguousSubmitError {
  return new AmbiguousSubmitError(
    'Task creation failed with an ambiguous result (network error or server 5xx). The provider MAY have created a paid task — check the Volcengine Ark console before retrying to avoid double billing.',
    'ark submit: ambiguous outcome',
  );
}

async function portraitPrivacyError(res: Response): Promise<VideoGenError | undefined> {
  let code: unknown;
  try {
    const json = (await res.json()) as { error?: { code?: unknown }; code?: unknown };
    code = json.error?.code ?? json.code;
  } catch {
    return undefined;
  }
  if (
    code !== 'InputImageSensitiveContentDetected.PrivacyInformation' &&
    code !== 'InputVideoSensitiveContentDetected.PrivacyInformation'
  ) {
    return undefined;
  }
  return new VideoGenError(
    'Seedance rejected an ordinary reference containing a recognizable real person. Select a preset avatar or an Active authorized-person Asset ID in the current Volcengine account/project, then pass it through referenceAssets.',
    `ark submit: ${code}`,
  );
}

export const arkAdapter: VideoProviderAdapter = {
  async submit(provider, remoteModelId, params, fetchImpl, signal): Promise<RemoteTaskHandle> {
    if (!provider.apiKey) throw missingKeyError('ark', 'ARK_API_KEY', provider.apiKeyPath);

    const content: Record<string, unknown>[] = [{ type: 'text', text: params.prompt }];
    if (params.firstFramePath) {
      content.push({
        type: 'image_url',
        image_url: { url: await imageFileToDataUri(params.firstFramePath) },
        role: 'first_frame',
      });
    }
    if (params.lastFramePath) {
      content.push({
        type: 'image_url',
        image_url: { url: await imageFileToDataUri(params.lastFramePath) },
        role: 'last_frame',
      });
    }
    for (const path of params.referenceImagePaths ?? []) {
      content.push({
        type: 'image_url',
        image_url: { url: await imageFileToDataUri(path) },
        role: 'reference_image',
      });
    }
    for (const asset of params.referenceAssets ?? []) {
      if (asset.modality === 'image') {
        content.push({
          type: 'image_url',
          image_url: { url: `asset://${asset.assetId}` },
          role: 'reference_image',
        });
      } else if (asset.modality === 'video') {
        content.push({
          type: 'video_url',
          video_url: { url: `asset://${asset.assetId}` },
          role: 'reference_video',
        });
      } else {
        content.push({
          type: 'audio_url',
          audio_url: { url: `asset://${asset.assetId}` },
          role: 'reference_audio',
        });
      }
    }

    const body: Record<string, unknown> = {
      model: remoteModelId,
      content,
      watermark: false,
    };
    if (params.resolution) body.resolution = params.resolution;
    if (params.aspectRatio) body.ratio = params.aspectRatio;
    if (params.durationSec != null) body.duration = params.durationSec;
    if (params.generateAudio != null) body.generate_audio = params.generateAudio;

    let res: Response;
    try {
      res = await fetchImpl(`${provider.baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: bearerHeaders(provider.apiKey),
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch {
      throw ambiguousSubmitError();
    }

    if (!res.ok) {
      if (res.status >= 500) throw ambiguousSubmitError();
      if (res.status === 400) {
        const privacyError = await portraitPrivacyError(res);
        if (privacyError) throw privacyError;
      }
      throw httpStatusError('ark', 'submit', res.status);
    }

    let taskId: string | undefined;
    try {
      const json = (await res.json()) as { id?: string };
      taskId = json.id;
    } catch {
      // Response said OK but wasn't JSON — treat as ambiguous rather than assume.
      throw ambiguousSubmitError();
    }
    if (!taskId) {
      // 2xx but no id: the task MAY exist server-side — this is ambiguous,
      // not a clean failure, and must park the shot rather than re-submit.
      throw new AmbiguousSubmitError(
        'The provider accepted the request but returned no task id. Not retrying automatically; check the Ark console.',
        'ark submit: no task id',
      );
    }

    return {
      taskId,
      submittedAt: new Date().toISOString(),
      requestFingerprint: requestFingerprint(remoteModelId, params),
    };
  },

  async inspect(provider, handle, fetchImpl, signal): Promise<RemoteTaskStatus> {
    if (!provider.apiKey) throw missingKeyError('ark', 'ARK_API_KEY', provider.apiKeyPath);

    let res: Response;
    try {
      res = await fetchImpl(
        `${provider.baseUrl}/contents/generations/tasks/${encodeURIComponent(handle.taskId)}`,
        {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: signal ?? null,
        },
      );
    } catch {
      throw networkError('ark', 'inspect');
    }
    if (!res.ok) throw httpStatusError('ark', 'inspect', res.status);

    const json = (await res.json()) as {
      status?: string;
      content?: { video_url?: string };
      error?: { message?: string };
    };
    switch (json.status) {
      case 'queued':
        return { phase: 'pending' };
      case 'running':
        return { phase: 'running' };
      case 'succeeded': {
        const videoUrl = json.content?.video_url;
        if (!videoUrl) {
          throw new VideoGenError(
            'The task succeeded but returned no video URL. Report this with the task id.',
            'ark inspect: succeeded without url',
          );
        }
        return { phase: 'succeeded', videoUrl };
      }
      case 'failed':
        return { phase: 'failed', message: json.error?.message ?? 'unknown provider error' };
      default:
        throw new VideoGenError(
          `The provider returned an unknown task status. Task id kept for support: ${handle.taskId}.`,
          'ark inspect: unknown status',
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
    try {
      return await downloadFile({ url: videoUrl, destPath, fetchImpl, provider, signal });
    } catch (error) {
      if (error instanceof VideoGenError) throw error;
      throw new VideoGenError(
        `Downloading the video failed (${redactUrl(videoUrl)}). The URL expires after 24h — rerun to regenerate.`,
        'ark download: failed',
      );
    }
  },

  // cancel: intentionally omitted — Ark task-cancellation support is unverified
  // until the M0 probe reports. Local stops are surfaced as `polling_stopped`.
};
