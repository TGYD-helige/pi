import { boundStructuredContent } from '@amaster.ai/pi-shared';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import { extractTextContent, postProcessToolResult } from './tool-augment.js';

/** Convert upstream MCP result into pi-agent content, applying text post-processing. */
export function toToolContent(
  result: {
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  },
  originalName: string,
): {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
  structuredContent?: ReturnType<typeof boundStructuredContent>;
} {
  const textContent = extractTextContent(result.content);
  const processed = postProcessToolResult(originalName, textContent);

  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  > = [];

  if (processed !== textContent) {
    content.push({ type: 'text', text: processed });
  } else if (result.content) {
    for (const item of result.content) {
      if (item.type === 'text' && item.text) {
        content.push({ type: 'text', text: item.text });
      }
    }
  }

  const text = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  const bounded = truncateHead(text, { maxBytes: 50 * 1024 - 128, maxLines: 1998 });
  if (bounded.truncated) {
    content.length = 0;
    content.push({
      type: 'text',
      text: `${bounded.content}\n[Browser output truncated; request a smaller result.]`,
    });
  }

  if (result.content) {
    for (const item of result.content) {
      if (item.type === 'image' && item.data) {
        content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    content,
    ...(result.isError ? { isError: true } : {}),
    ...(result.structuredContent
      ? { structuredContent: boundStructuredContent(result.structuredContent) }
      : {}),
  };
}
