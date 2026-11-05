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
 * OpenRouter video generation (google/veo-3.1 and friends).
 *
 *   POST {baseUrl}/videos        → 202 { id, generation_id, polling_url, status }
 *   GET  {baseUrl}/videos/{id}   → { status, unsigned_urls[], error }
 *   GET  {unsigned_urls[0]}      → the mp4 itself
 *
 * Verified against the official docs (openrouter.ai/docs, 2026-07):
 * - Frames ride in `frame_images` with `frame_type: first_frame|last_frame`;
 *   extra references go in `input_references` (image/audio/video urls).
 * - `generate_audio` toggles native audio (default false upstream — we send it
 *   explicitly from the caller's capability decision).
 * - Status enum: pending | in_progress | completed | failed | cancelled |
 *   expired. completed ⇒ download from `unsigned_urls` immediately.
 * - No client idempotency key is documented, so ambiguous submit failures get
 *   the "check the console before retrying" treatment (same as Ark/DashScope).
 */

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

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
      'openrouter: unsupported image extension',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new VideoGenError(
      `Reference image is not readable: ${safeBasename(path)}`,
      'openrouter: image unreadable',
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function ambiguousSubmitError(error?: unknown): AmbiguousSubmitError {
  return new AmbiguousSubmitError(
    'Task creation failed with an ambiguous result (network error or server 5xx). The provider MAY have created a paid task — check OpenRouter activity before retrying to avoid double billing.',
    'openrouter submit: ambiguous outcome',
    error,
  );
}

export const openrouterAdapter: VideoProviderAdapter = {
  async submit(provider, remoteModelId, params, fetchImpl, signal): Promise<RemoteTaskHandle> {
    if (!provider.apiKey) {
      throw missingKeyError('openrouter', 'OPENROUTER_API_KEY', provider.apiKeyPath);
    }

    const body: Record<string, unknown> = { model: remoteModelId, prompt: params.prompt };
    if (params.durationSec != null) body.duration = params.durationSec;
    if (params.resolution) body.resolution = params.resolution;
    if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
    if (params.generateAudio != null) body.generate_audio = params.generateAudio;

    const frameImages: Record<string, unknown>[] = [];
    if (params.firstFramePath) {
      frameImages.push({
        type: 'image_url',
        image_url: { url: await imageFileToDataUri(params.firstFramePath) },
        frame_type: 'first_frame',
      });
    }
    if (params.lastFramePath) {
      frameImages.push({
        type: 'image_url',
        image_url: { url: await imageFileToDataUri(params.lastFramePath) },
        frame_type: 'last_frame',
      });
    }
    if (frameImages.length > 0) body.frame_images = frameImages;

    if (params.referenceImagePaths?.length) {
      body.input_references = await Promise.all(
        params.referenceImagePaths.map(async (path) => ({
          type: 'image_url',
          image_url: { url: await imageFileToDataUri(path) },
        })),
      );
    }

    let res: Response;
    try {
      res = await fetchImpl(`${provider.baseUrl}/videos`, {
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
      throw httpStatusError('openrouter', 'submit', res.status);
    }

    let taskId: string | undefined;
    try {
      const json = (await res.json()) as { id?: string };
      taskId = json.id;
    } catch (error) {
      throw ambiguousSubmitError(error);
    }
    if (!taskId) {
      // 2xx but no id: the task MAY exist server-side — this is ambiguous,
      // not a clean failure, and must park the shot rather than re-submit.
      throw new AmbiguousSubmitError(
        'The provider accepted the request but returned no task id. Not retrying automatically; check OpenRouter activity.',
        'openrouter submit: no task id',
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
      throw missingKeyError('openrouter', 'OPENROUTER_API_KEY', provider.apiKeyPath);
    }

    let res: Response;
    try {
      res = await fetchImpl(`${provider.baseUrl}/videos/${encodeURIComponent(handle.taskId)}`, {
        headers: { authorization: `Bearer ${provider.apiKey}` },
        signal: signal ?? null,
      });
    } catch (error) {
      throw networkError('openrouter', 'inspect', error);
    }
    if (!res.ok) throw httpStatusError('openrouter', 'inspect', res.status);

    const json = (await res.json()) as {
      status?: string;
      unsigned_urls?: string[];
      error?: string | { message?: string };
    };
    switch (json.status) {
      case 'pending':
        return { phase: 'pending' };
      case 'in_progress':
        return { phase: 'running' };
      case 'completed': {
        const videoUrl = json.unsigned_urls?.[0];
        if (!videoUrl) {
          throw new VideoGenError(
            'The task completed but returned no video URL. Report this with the task id.',
            'openrouter inspect: completed without url',
          );
        }
        return { phase: 'succeeded', videoUrl };
      }
      case 'failed':
      case 'cancelled':
      case 'expired': {
        const message =
          typeof json.error === 'string'
            ? json.error
            : (json.error?.message ?? `task ${json.status}`);
        return { phase: 'failed', message };
      }
      default:
        throw new VideoGenError(
          `The provider returned an unknown task status. Task id kept for support: ${handle.taskId}.`,
          'openrouter inspect: unknown status',
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

  // cancel: not covered by the submitted docs; local stops are polling_stopped.
};
