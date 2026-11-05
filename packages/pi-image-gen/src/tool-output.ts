import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ImageGenResult } from './types.js';

export const imageOutputSchema = Type.Union([
  Type.Object({
    model: Type.String(),
    provider: Type.String(),
    images: Type.Array(
      Type.Object({
        path: Type.String(),
        mimeType: Type.String(),
        revisedPrompt: Type.Optional(Type.String()),
      }),
    ),
    truncated: Type.Boolean(),
    totalImages: Type.Integer(),
  }),
  Type.Object({
    error: Type.String(),
    errorCategory: Type.Optional(Type.String()),
    httpStatus: Type.Optional(Type.Integer()),
  }),
]);

function clipText(text: string, maxBytes: number, maxLines: number) {
  const lineLimited = truncateHead(text, { maxBytes: Number.MAX_SAFE_INTEGER, maxLines }).content;
  const bytes = Buffer.from(lineLimited);
  return bytes.length <= maxBytes
    ? lineLimited
    : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, maxBytes), {
        stream: true,
      });
}

export function imageOutput(result: ImageGenResult) {
  const model = clipText(result.model, 256, 10);
  const provider = clipText(result.provider, 256, 10);
  let truncated = model !== result.model || provider !== result.provider;
  const output = {
    model,
    provider,
    images: result.images.map((image) => {
      if (image.revisedPrompt === undefined) return { path: image.path, mimeType: image.mimeType };
      const prompt = clipText(image.revisedPrompt, 1024, 100);
      truncated ||= prompt !== image.revisedPrompt;
      return { path: image.path, mimeType: image.mimeType, revisedPrompt: prompt };
    }),
    truncated,
    totalImages: result.images.length,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 6 * 1024) {
    output.images = output.images.map(({ path, mimeType }) => ({ path, mimeType }));
    output.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(output)) > 6 * 1024 && output.images.length)
    output.images.pop();
  return output;
}
