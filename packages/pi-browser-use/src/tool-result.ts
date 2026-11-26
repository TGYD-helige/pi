import {
  agentToolErrorResult,
  boundStructuredContent,
  describeMcpError,
} from '@amaster.ai/pi-shared';
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
  structuredContent?:
    | ReturnType<typeof boundStructuredContent>
    | ReturnType<typeof agentToolErrorResult>['structuredContent'];
} {
  if (result.isError) {
    // The driver puts its diagnostic on the last line of a potentially private response.
    const tail = result.content?.find((item) => item.type === 'text')?.text?.slice(-257) ?? '';
    const reported = result.structuredContent?.errorMessage;
    const text =
      typeof reported === 'string' && reported.length <= 256
        ? reported
        : tail
            .slice(tail.lastIndexOf('\n') + 1)
            .replace(/^Error: /, '')
            .trimEnd();
    // Forward only fixed driver messages and verified identifier shapes.
    if (
      /^No snapshot found for page (?:[0-9]+|\?)\. Use take_snapshot to capture one\.$/.test(text)
    ) {
      return agentToolErrorResult({
        code: 'browser_snapshot_required',
        message:
          originalName === 'click'
            ? 'Click was rejected before execution.'
            : 'The current page has no snapshot.',
        cause: { source: 'chrome-devtools-mcp', message: text },
      });
    }
    if (
      text === 'No page selected' ||
      text === 'No page found' ||
      text === 'The selected page has been closed. Call list_pages to see open pages.'
    ) {
      return agentToolErrorResult({
        code: 'browser_page_unavailable',
        message: 'The requested browser page is unavailable.',
        cause: { source: 'chrome-devtools-mcp', message: text },
        ...(text.startsWith('No page')
          ? { recovery: 'Call browser_list_pages to find an open page.' }
          : {}),
      });
    }
    if (
      /^(?:Element uid "[0-9_]{1,64}" not found on page [0-9]+\.|Element with uid [0-9_]{1,64} no longer exists on the page\.)$/.test(
        text,
      )
    ) {
      return agentToolErrorResult({
        code: 'browser_element_stale',
        message: 'The element reference could not be resolved.',
        cause: { source: 'chrome-devtools-mcp', message: text },
        recovery: 'Call browser_take_snapshot and choose the element’s current uid.',
      });
    }
    const failure = describeMcpError(
      'Browser tool',
      result,
      'The action may have completed. Inspect the current page before retrying.',
    );
    console.error(`[pi-browser-use] upstream tool failed (category=${failure.errorCategory})`);
    return {
      content: [{ type: 'text', text: failure.error }],
      structuredContent: failure,
      isError: true,
    };
  }
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
    ...(result.structuredContent
      ? { structuredContent: boundStructuredContent(result.structuredContent) }
      : {}),
  };
}
