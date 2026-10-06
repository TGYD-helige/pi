import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from '@earendil-works/pi-coding-agent';

const MAX_RESULT_BYTES = DEFAULT_MAX_BYTES - 2 * 1024;
const MAX_DETAILS_BYTES = 18 * 1024;
const SERIALIZATION_OVERHEAD_BYTES = 1_024;

export interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content?: McpContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type PiToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fitSerializedString(value: string, maxBytes: number, maxLines: number): string {
  let rawBudget = Math.max(0, maxBytes);
  while (rawBudget > 0) {
    const candidate = truncateHead(value, { maxBytes: rawBudget, maxLines }).content;
    if (byteLength(candidate) <= maxBytes) return candidate;
    rawBudget = Math.floor(rawBudget * 0.75);
  }
  return '';
}

export function boundStructuredContent(
  structuredContent: Record<string, unknown> | undefined,
  maxBytes = MAX_DETAILS_BYTES,
): Record<string, unknown> | undefined {
  if (!structuredContent || byteLength(structuredContent) <= maxBytes) {
    return structuredContent;
  }

  const bounded: Record<string, unknown> = { ...structuredContent, truncated: true };
  if (typeof bounded.tree_markdown === 'string') {
    delete bounded.tree_markdown;
    bounded.tree_markdown_omitted = true;
  }

  const elements = Array.isArray(bounded.elements) ? bounded.elements : undefined;
  if (elements) {
    bounded.total_elements = elements.length;
    let keep = elements.length;
    while (keep > 0 && byteLength({ ...bounded, elements: elements.slice(0, keep) }) > maxBytes) {
      keep = Math.floor(keep / 2);
    }
    bounded.elements = elements.slice(0, keep);
  }

  if (byteLength(bounded) <= maxBytes) return bounded;

  if (maxBytes <= 512) {
    return { truncated: true, original_bytes: byteLength(structuredContent) };
  }

  const serialized = JSON.stringify(structuredContent, null, 2);
  let previewBudget = maxBytes - 512;
  while (previewBudget > 0) {
    const preview = fitSerializedString(serialized, previewBudget, DEFAULT_MAX_LINES);
    const candidate = {
      truncated: true,
      original_bytes: byteLength(structuredContent),
      preview,
    };
    if (byteLength(candidate) <= maxBytes) return candidate;
    previewBudget = Math.floor(previewBudget * 0.75);
  }
  return { truncated: true, original_bytes: byteLength(structuredContent) };
}

export function toPiToolResult(
  result: McpToolResult,
  toolName?: string,
): {
  content: PiToolContent[];
  details: Record<string, unknown> | undefined;
  isError?: boolean;
} {
  const content: PiToolContent[] = [];
  const details = boundStructuredContent(result.structuredContent);
  const elementTokens = new Map<number, string>();
  if (toolName === 'get_window_state') {
    for (const element of asRecordArray(result.structuredContent?.elements)) {
      if (typeof element.element_index === 'number' && typeof element.element_token === 'string') {
        elementTokens.set(element.element_index, element.element_token);
      }
    }
  }
  const enrichment = fitSerializedString(
    toolName ? (buildEnrichment(toolName, result) ?? '') : '',
    ENRICHMENT_MAX_BYTES,
    ENRICHMENT_MAX_LINES,
  );
  const enrichmentBytes = enrichment ? byteLength(enrichment) : 0;
  let remainingBytes = Math.max(
    0,
    MAX_RESULT_BYTES - byteLength(details) - SERIALIZATION_OVERHEAD_BYTES - enrichmentBytes,
  );
  let remainingLines = DEFAULT_MAX_LINES - (enrichment ? enrichment.split('\n').length : 0);

  for (const item of result.content ?? []) {
    if (item.type === 'image' && item.data) {
      // Keep image blocks valid; Pi's image pipeline applies its own decode/resize
      // limits, while this budget covers the text + details context payload.
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' });
      continue;
    }
    if (item.type !== 'text' || !item.text || remainingBytes <= 0 || remainingLines <= 0) continue;

    const sourceText = item.text.replace(
      /^([ \t]*- \[(\d+)\])(.*)$/gm,
      (row, prefix, index, rest) => {
        const token = elementTokens.get(Number(index));
        return token && !rest.includes(`element_token=${token}`)
          ? `${prefix} element_token=${token}${rest}`
          : row;
      },
    );
    const initial = truncateHead(sourceText, {
      maxBytes: remainingBytes,
      maxLines: remainingLines,
    });
    const needsTruncation = initial.truncated || byteLength(initial.content) > remainingBytes;
    const noticeCandidate = needsTruncation
      ? `\n\n[pi-computer-use truncated output: ${initial.totalBytes} bytes, ${initial.totalLines} lines]`
      : '';
    const notice = byteLength(noticeCandidate) <= remainingBytes ? noticeCandidate : '';
    const textBudget = Math.max(0, remainingBytes - byteLength(notice));
    const text = `${fitSerializedString(
      sourceText,
      textBudget,
      Math.max(1, remainingLines - (notice ? 2 : 0)),
    )}${notice}`;
    if (!text) continue;
    content.push({ type: 'text', text });
    remainingBytes -= byteLength(text);
    remainingLines -= text.split('\n').length;
  }

  if (enrichment) content.push({ type: 'text', text: enrichment });

  if (content.length === 0) content.push({ type: 'text', text: 'Action executed.' });

  return {
    content,
    details,
    ...(result.isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Model-visible enrichment.
//
// Pi only sends `content` (text + images) to the LLM; `details`
// (structuredContent) is TUI-only. The cua-driver places several fields the
// model needs to act — snapshot_id, list_windows records, degraded_reason —
// exclusively in structuredContent, so they are rendered into bounded text
// here. Enrichment is idempotent (skipped when the driver text already
// carries the field) and defensive (schema drift degrades to pass-through).
// ---------------------------------------------------------------------------

const ENRICHMENT_MAX_BYTES = 4 * 1024;
const ENRICHMENT_MAX_LINES = 60;
const LIST_WINDOWS_MAX_RECORDS = 20;
// Matches the tree-row format the cua-driver 0.28.x MCP text output emits
// ("- [N] <role> ..."). Undocumented upstream format; a false positive only
// suppresses the max_elements hint, which is safe by design.
const TREE_LINE = /^[ \t]*- \[\d+\]/m;

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
    : [];
}

function windowRank(window: Record<string, unknown>): number {
  return (window.is_on_screen === true ? 2 : 0) + (window.on_current_space === true ? 1 : 0);
}

function formatWindowRecord(window: Record<string, unknown>): string | undefined {
  const windowId = window.window_id;
  if (typeof windowId !== 'number' && typeof windowId !== 'string') return undefined;
  const pid = typeof window.pid === 'number' ? String(window.pid) : '?';
  const app = typeof window.app_name === 'string' ? window.app_name : '?';
  const title =
    typeof window.title === 'string' && window.title ? ` "${window.title.slice(0, 40)}"` : '';
  const bounds =
    typeof window.bounds === 'object' && window.bounds !== null
      ? (window.bounds as Record<string, unknown>)
      : undefined;
  const geometry =
    bounds &&
    typeof bounds.x === 'number' &&
    typeof bounds.y === 'number' &&
    typeof bounds.width === 'number' &&
    typeof bounds.height === 'number'
      ? ` @${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
      : '';
  const flags = [
    window.is_on_screen ? 'on-screen' : 'off-screen',
    window.on_current_space === true
      ? 'current-space'
      : window.on_current_space === false
        ? 'other-space'
        : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return `window_id=${windowId} pid=${pid} ${app}${title}${geometry} ${flags}`.trim();
}

function buildEnrichment(toolName: string, result: McpToolResult): string | undefined {
  const sc = result.structuredContent;
  if (!sc || typeof sc !== 'object') return undefined;
  const existingText = (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
  const parts: string[] = [];

  if (toolName === 'get_window_state' || toolName === 'get_desktop_state') {
    if (
      typeof sc.capture_id === 'string' &&
      !existingText.includes(`capture_id=${sc.capture_id}`)
    ) {
      parts.push(
        `capture_id=${sc.capture_id} (source screenshot for pixel actions and visual parsing)`,
      );
    }
  }

  if (toolName === 'get_window_state') {
    const snapshotId = typeof sc.snapshot_id === 'string' ? sc.snapshot_id : undefined;
    if (snapshotId && !existingText.includes(`snapshot_id=${snapshotId}`)) {
      parts.push(`snapshot_id=${snapshotId} (use element_token for element addressing)`);
    }
    if (sc.degraded === true || typeof sc.degraded_reason === 'string') {
      const reason = typeof sc.degraded_reason === 'string' ? sc.degraded_reason : 'unknown';
      if (!existingText.includes(`degraded_reason=${reason}`)) {
        parts.push(
          `degraded_reason=${reason} - activate the window onto the current Space first (e.g. bring_to_front), then retry`,
        );
      }
    }
    const elementCount = typeof sc.element_count === 'number' ? sc.element_count : undefined;
    const elements = asRecordArray(sc.elements);
    if (
      !TREE_LINE.test(existingText) &&
      ((elementCount !== undefined && elementCount > 0) || elements.length > 0)
    ) {
      parts.push(
        'AX tree is not in the text above (large or TUI-only payload). Re-run get_window_state with max_elements:300-400 to include a bounded tree.',
      );
    }
  } else if (toolName === 'list_windows') {
    const windows = asRecordArray(sc.windows);
    if (windows.length > 0 && !existingText.includes('window_id=')) {
      const lines = windows
        .map((window, index) => ({ window, index }))
        .sort((a, b) => windowRank(b.window) - windowRank(a.window) || a.index - b.index)
        .slice(0, LIST_WINDOWS_MAX_RECORDS)
        .map(({ window }) => formatWindowRecord(window))
        .filter((line): line is string => line !== undefined);
      if (lines.length > 0) {
        parts.push(`window records (top ${lines.length} of ${windows.length}, on-screen first):`);
        parts.push(...lines);
      }
    }
  }

  return parts.length > 0 ? `[pi-computer-use model-visible]\n${parts.join('\n')}` : undefined;
}
