import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { FetchResponse, SearchResponse } from './providers/index.js';

const MAX_BYTES = 16 * 1024;
const errorSchema = Type.Object({ error: Type.String() });
export const searchOutputSchema = Type.Union([
  Type.Object({
    provider: Type.String(),
    query: Type.String(),
    answer: Type.Optional(Type.String()),
    results: Type.Array(
      Type.Object({
        title: Type.String(),
        url: Type.String(),
        content: Type.String(),
        score: Type.Optional(Type.Number()),
      }),
    ),
    truncated: Type.Boolean(),
  }),
  errorSchema,
]);
export const fetchOutputSchema = Type.Union([
  Type.Object({
    url: Type.String(),
    title: Type.String(),
    content: Type.String(),
    truncated: Type.Boolean(),
  }),
  errorSchema,
]);

export function boundText(text: string, maxBytes = MAX_BYTES): string {
  if (maxBytes < 2) return '';
  const lineLimited = truncateHead(text, {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxLines: 1000,
  }).content;
  const bytes = Buffer.from(lineLimited);
  // Bound lines first, then bytes; otherwise truncateHead drops oversized body lines entirely.
  const clip = (budget: number) =>
    bytes.length <= budget
      ? lineLimited
      : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, budget), {
          stream: true,
        });
  let budget = maxBytes;
  let result = clip(budget);
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    budget = Math.floor(budget / 2);
    result = clip(budget);
  }
  return result;
}

export function searchOutput(response: SearchResponse) {
  let truncated = response.results.length > 20;
  const clip = (text: string, bytes: number) => {
    const value = boundText(text, bytes);
    truncated ||= value !== text;
    return value;
  };
  const result = {
    provider: clip(response.provider, 256),
    query: clip(response.query, 1024),
    ...(response.answer !== undefined ? { answer: clip(response.answer, 4096) } : {}),
    results: response.results.slice(0, 20).map((item) => ({
      title: clip(item.title, 256),
      url: item.url,
      content: clip(item.content, 1024),
      ...(item.score !== undefined && Number.isFinite(item.score) ? { score: item.score } : {}),
    })),
    truncated,
  };
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && result.results.length) {
    result.results.pop();
    result.truncated = true;
  }
  return result;
}

export function fetchOutput(response: FetchResponse) {
  const title = boundText(response.title, 256);
  const budget = MAX_BYTES - Buffer.byteLength(JSON.stringify({ url: response.url, title })) - 128;
  if (budget < 2) throw new Error('Fetched URL metadata exceeds the output limit.');
  const content = boundText(response.content, budget);
  return {
    url: response.url,
    title,
    content,
    truncated:
      response.truncated === true || content !== response.content || title !== response.title,
  };
}
