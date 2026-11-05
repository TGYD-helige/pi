import { describeMcpError } from '@amaster.ai/pi-shared';
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
  safeErrorText?: string,
  originalArgs?: Record<string, unknown>,
): {
  content: PiToolContent[];
  details: Record<string, unknown> | undefined;
  isError?: boolean;
} {
  if (result.isError || result.structuredContent?.status === 'refused') {
    const message = (result.content ?? [])
      .slice(0, 4)
      .filter((item) => item.type === 'text')
      .map((item) => item.text?.slice(0, 4096) ?? '')
      .join('\n')
      .slice(0, 4096);
    const failure = describeMcpError(
      'Computer tool',
      result,
      'The execution outcome is unknown. Read the current target state before retrying any action.',
    );
    const setup = browserSetupRecovery(result.structuredContent, message, toolName, originalArgs);
    if (setup) failure.error = setup.message;
    if (safeErrorText) failure.error = safeErrorText + (setup ? `\n${setup.message}` : '');
    console.error(`[pi-computer-use] upstream tool failed (category=${failure.errorCategory})`);
    const metadata = {
      ...safeFailureMetadata(result.structuredContent),
      ...(setup ? { code: setup.code, next_call: setup.nextCall } : {}),
    };
    const extra = buildEnrichment(toolName ?? '', { structuredContent: metadata, isError: true });
    return {
      content: [{ type: 'text', text: failure.error + (extra ? `\n${extra}` : '') }],
      details: { ...failure, ...metadata },
      isError: true,
    };
  }
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
  let remainingLines = DEFAULT_MAX_LINES - (enrichment ? enrichment.split('\n').length + 1 : 0);

  const textBlockOverhead = byteLength({ type: 'text', text: '' }) - byteLength('') + 1;
  for (const item of result.content ?? []) {
    if (item.type === 'image' && item.data) {
      // Keep image blocks valid; Pi's image pipeline applies its own decode/resize
      // limits, while this budget covers the text + details context payload.
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' });
      continue;
    }
    if (
      item.type !== 'text' ||
      !item.text ||
      remainingBytes <= textBlockOverhead ||
      remainingLines <= 0
    )
      continue;
    remainingBytes -= textBlockOverhead;

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
    const notice =
      remainingLines >= 3 && byteLength(noticeCandidate) <= remainingBytes ? noticeCandidate : '';
    const textBudget = Math.max(0, remainingBytes - byteLength(notice));
    const text = `${fitSerializedString(
      sourceText,
      textBudget,
      Math.max(1, remainingLines - (notice ? 2 : 0)),
    )}${notice}`;
    if (!text) continue;
    content.push({ type: 'text', text });
    remainingBytes -= byteLength(text);
    remainingLines -= text.split('\n').length + 1;
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

const ENRICHMENT_MAX_BYTES = 12 * 1024;
const ENRICHMENT_MAX_LINES = 240;
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

function structuredFieldLines(fields: Record<string, unknown>, existingText: string): string[] {
  if (
    existingText.includes(JSON.stringify(fields)) ||
    existingText.includes(JSON.stringify(fields, null, 2))
  )
    return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    let shortened = false;
    const rows = (Array.isArray(value) ? value : [value]).map((row) =>
      JSON.stringify(row, (name, field) => {
        const limit = key === 'outline' ? 512 : 120;
        if (
          ['name', 'title', 'label', 'text', 'value', 'url', 'outline'].includes(name || key) &&
          typeof field === 'string' &&
          field.length > limit
        ) {
          shortened = true;
          return `${field.slice(0, limit)} [truncated]`;
        }
        return field;
      }),
    );
    const text = rows.join('\n');
    const bounded = fitSerializedString(text, 3 * 1024, 40);
    const block = `${key}:\n${bounded}`;
    if (existingText.includes(block)) continue;
    lines.push(block);
    if (shortened || bounded !== text) {
      const hint =
        key === 'sessions'
          ? 'repeat list_sessions with a smaller limit; do not use next_cursor yet'
          : 'narrow the request before continuing through omitted results';
      lines.push(`[${key} truncated; ${hint}.]`);
    }
  }
  return lines;
}

function buildEnrichment(toolName: string, result: McpToolResult): string | undefined {
  const sc = result.structuredContent;
  if (!sc || typeof sc !== 'object') return undefined;
  const originalText = (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
  // Only suppress enrichment when the original text is small enough to survive truncation.
  const existingText =
    byteLength(originalText) < ENRICHMENT_MAX_BYTES &&
    originalText.split('\n').length < ENRICHMENT_MAX_LINES
      ? originalText
      : '';
  const parts = structuredFieldLines(
    {
      effect: sc.effect,
      delivery: sc.delivery,
      escalation: sc.escalation,
      evidence: sc.evidence,
      hint: sc.hint,
      next_call: sc.next_call,
    },
    existingText,
  );

  if (!result.isError) {
    switch (toolName) {
      case 'browser_prepare':
        parts.push(
          ...structuredFieldLines(
            {
              prepared_pid: sc.prepared_pid,
              attachment: sc.attachment,
              side_effects: sc.side_effects,
            },
            existingText,
          ),
        );
        break;
      case 'browser_dialog':
        parts.push(
          ...structuredFieldLines(
            { dialog_id: sc.dialog_id, present: sc.present, kind: sc.kind },
            existingText,
          ),
        );
        break;
      case 'install_extension':
        parts.push(
          ...structuredFieldLines(
            {
              version: sc.version,
              target: sc.target,
              publisher: sc.publisher,
              trust: sc.trust,
              license: sc.license,
              license_notices: sc.license_notices,
              source: sc.source,
              corresponding_source: sc.corresponding_source,
              download_size: sc.download_size,
              installed_size: sc.installed_size,
              destination: sc.destination,
              authorization: sc.authorization,
              installed: sc.installed,
              installed_version: sc.installed_version,
            },
            existingText,
          ),
        );
        break;
      case 'parse_visual_regions':
        parts.push(
          ...structuredFieldLines(
            { capture: sc.capture, warnings: sc.warnings, regions: sc.regions },
            existingText,
          ),
        );
        break;
      case 'list_sessions':
        parts.push(
          ...structuredFieldLines(
            { next_cursor: sc.next_cursor, sessions: sc.sessions },
            existingText,
          ),
        );
        break;
      case 'get_session':
      case 'get_session_state':
      case 'get_config':
      case 'get_agent_cursor_state':
      case 'verify_state':
        parts.push(...structuredFieldLines(sc, `${existingText}\n${parts.join('\n')}`));
        break;
    }
  }

  if (toolName === 'get_browser_state') {
    if (typeof sc.target_id === 'string' && !existingText.includes(`target_id=${sc.target_id}`)) {
      parts.push(`target_id=${sc.target_id}`);
    }
    if (sc.mode === 'snapshot') {
      parts.push(
        ...structuredFieldLines(
          {
            tab_id: sc.tab_id,
            snapshot_id: sc.snapshot_id,
            snapshot: sc.snapshot,
            truncated: sc.truncated,
            oopif: sc.oopif,
            screenshot: sc.screenshot,
            refs: sc.refs,
            content_refs: sc.content_refs,
            outline: sc.outline,
          },
          existingText,
        ),
      );
    }
    const tabs = asRecordArray(sc.tabs).sort(
      (a, b) => Number(b.active === true) - Number(a.active === true),
    );
    for (const tab of tabs) {
      if (typeof tab.tab_id !== 'string' || existingText.includes(`tab_id=${tab.tab_id}`)) continue;
      const title = typeof tab.title === 'string' ? tab.title.slice(0, 120) : '';
      const url = typeof tab.url === 'string' ? tab.url.slice(0, 200) : '';
      parts.push(
        `tab_id=${tab.tab_id} title=${JSON.stringify(title)} url=${JSON.stringify(url)} active=${tab.active === true}`,
      );
    }
  }

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
        const hint =
          reason === 'screen_locked'
            ? 'wake and unlock the Mac, then retry; do not send foreground input to the lock screen'
            : 'consult the tool description or get_guide for recovery before retrying';
        parts.push(`degraded_reason=${reason} - ${hint}`);
      }
    }
    const elementCount = typeof sc.element_count === 'number' ? sc.element_count : undefined;
    const elements = asRecordArray(sc.elements);
    if (
      !TREE_LINE.test(originalText) &&
      !(typeof sc.tree_diff === 'string' && sc.tree_diff.trim()) &&
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

function safeFailureMetadata(value: Record<string, unknown> = {}): Record<string, unknown> {
  const pick = (item: unknown, allowed: string[]) =>
    typeof item === 'string' && allowed.includes(item) ? item : undefined;
  const delivery = value.delivery as { mode?: unknown; delivered_count?: unknown } | undefined;
  const escalation = value.escalation as { target?: unknown; reason?: unknown } | undefined;
  const metadata: Record<string, unknown> = {
    effect: pick(value.effect, [
      'confirmed',
      'partial',
      'unverifiable',
      'suspected_noop',
      'refused',
    ]),
    delivery: {
      mode: pick(delivery?.mode, ['background', 'foreground', 'not_applicable', 'unknown']),
      ...(typeof delivery?.delivered_count === 'number' &&
      Number.isSafeInteger(delivery.delivered_count) &&
      delivery.delivered_count >= 0
        ? { delivered_count: delivery.delivered_count }
        : {}),
    },
    escalation: {
      target: pick(escalation?.target, ['pixel', 'foreground', 'page', 'session']),
      reason: pick(escalation?.reason, [
        'route_unavailable',
        'delivery_failed',
        'effect_unconfirmed',
        'suspected_noop',
        'permission_required',
      ]),
    },
  };
  for (const [key, item] of Object.entries(metadata)) {
    if (
      item === undefined ||
      (item &&
        typeof item === 'object' &&
        Object.values(item).every((field) => field === undefined))
    )
      delete metadata[key];
  }
  return metadata;
}

function browserSetupRecovery(
  value: unknown,
  text: string,
  toolName?: string,
  originalArgs?: Record<string, unknown>,
) {
  if (toolName !== 'get_browser_state' && !toolName?.startsWith('browser_')) return undefined;
  const object = (item: unknown): Record<string, unknown> | undefined =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : undefined;
  let root = object(value);
  if (!root) {
    try {
      root = object(JSON.parse(text));
    } catch {
      /* Raw errors need not be JSON. */
    }
  }
  const error = object(root?.refusal) ?? object(root?.error);
  const code = [
    root?.code,
    error?.code,
    text.match(/^(?:Error:\s*)?(browser_requires_setup|browser_consent_required)\b/)?.[1],
  ].find((item) => item === 'browser_requires_setup' || item === 'browser_consent_required');
  if (!code) return undefined;
  const detail = object(root?.detail) ?? object(error?.detail);
  const next = object(detail?.next_call) ?? object(root?.next_call);
  const args = object(next?.arguments);
  const pid = args?.pid;
  const windowId = args?.window_id;
  const existing = object(args?.strategy)?.kind === 'existing_profile';
  const session = originalArgs?.session;
  const validSession =
    session === undefined || (typeof session === 'string' && session.length <= 1024);
  const validId = (id: unknown): id is number =>
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  const nextCall =
    next?.tool === 'browser_prepare' &&
    existing &&
    validId(pid) &&
    validId(windowId) &&
    validSession
      ? {
          tool: 'browser_prepare',
          arguments: {
            pid,
            window_id: windowId,
            strategy: { kind: 'existing_profile' },
            ...(session !== undefined ? { session } : {}),
          },
        }
      : { tool: 'get_guide', arguments: { topic: 'browser' } };
  return {
    code,
    nextCall,
    message: `${code}: Browser inspection needs setup. With the required authorization, call computer_use_browser_prepare for the intended pid/window_id, keeping the same session and strategy {"kind":"existing_profile"}, then retry inspection. Use computer_use_get_guide with topic=browser if authorization or target IDs are unavailable.`,
  };
}
