import { createHash } from 'node:crypto';
import { VideoGenError } from '../errors.js';
import type {
  GenerateVideoParams,
  ReferenceAsset,
  ReferenceAssetModality,
  VideoApiStyle,
  VideoModelCapabilities,
} from '../types.js';

const REFERENCE_ASSET_MODALITIES = new Set<ReferenceAssetModality>(['image', 'video', 'audio']);
const ASSET_ID = /^asset-[A-Za-z0-9_-]{1,128}$/;

/** Validate public JSON and normalize `asset://asset-...` to canonical `asset-...`. */
export function normalizeReferenceAssets(
  value: unknown,
  path = 'referenceAssets',
): ReferenceAsset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new VideoGenError(`${path} must be an array.`, 'request: bad reference assets');
  }
  return value.map((raw, index) => {
    const where = `${path}[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new VideoGenError(`${where} must be an object.`, 'request: bad reference asset');
    }
    const { modality, assetId: rawAssetId } = raw as Record<string, unknown>;
    if (
      typeof modality !== 'string' ||
      !REFERENCE_ASSET_MODALITIES.has(modality as ReferenceAssetModality)
    ) {
      throw new VideoGenError(
        `${where}.modality must be image, video, or audio.`,
        'request: bad reference asset modality',
      );
    }
    const assetId =
      typeof rawAssetId === 'string' ? rawAssetId.trim().replace(/^asset:\/\//, '') : '';
    if (!ASSET_ID.test(assetId)) {
      throw new VideoGenError(
        `${where}.assetId must be an Asset ID like "asset-..." or an URI like "asset://asset-..." from the current account/project.`,
        'request: bad reference asset id',
      );
    }
    return { modality: modality as ReferenceAssetModality, assetId };
  });
}

/** Pure capability preflight shared by single-clip and multi-shot orchestration. */
export function referenceAssetPreflightError(options: {
  providerStyle: VideoApiStyle;
  modelId: string;
  capabilities: VideoModelCapabilities;
  referenceAssets: ReferenceAsset[];
  localImageReferences: number;
}): string | undefined {
  const { providerStyle, modelId, capabilities, referenceAssets, localImageReferences } = options;
  const supported = providerStyle === 'ark' ? (capabilities.referenceAssetModalities ?? []) : [];
  if (referenceAssets.length > 0 && supported.length === 0) {
    return `The active ${providerStyle} provider/model (${modelId}) does not support trusted asset references. Remove referenceAssets or switch models.`;
  }
  const unsupported = referenceAssets.find((asset) => !supported.includes(asset.modality));
  if (unsupported) {
    return `The active model (${modelId}) does not support ${unsupported.modality} trusted assets. Supported modalities: ${supported.join(', ')}.`;
  }

  const counts: Record<ReferenceAssetModality, number> = {
    image:
      localImageReferences + referenceAssets.filter((asset) => asset.modality === 'image').length,
    video: referenceAssets.filter((asset) => asset.modality === 'video').length,
    audio: referenceAssets.filter((asset) => asset.modality === 'audio').length,
  };
  const limits: Record<ReferenceAssetModality, number> = {
    image: capabilities.maxReferenceImages,
    video: capabilities.maxReferenceVideos ?? 0,
    audio: capabilities.maxReferenceAudios ?? 0,
  };
  for (const modality of REFERENCE_ASSET_MODALITIES) {
    if (counts[modality] > limits[modality]) {
      return `Too many ${modality} references (${counts[modality]}) — ${modelId} accepts at most ${limits[modality]}.`;
    }
  }
  return undefined;
}

/** Stable identity shared by orchestration and every provider adapter. */
export function requestFingerprint(remoteModelId: string, params: GenerateVideoParams): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        model: remoteModelId,
        requestId: params.requestId,
        prompt: params.prompt,
        firstFramePath: params.firstFramePath,
        lastFramePath: params.lastFramePath,
        referenceImagePaths: params.referenceImagePaths,
        referenceAssets: params.referenceAssets,
        durationSec: params.durationSec,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        generateAudio: params.generateAudio,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
