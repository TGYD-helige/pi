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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

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
  const refused =
    result.structuredContent?.status === 'refused' ||
    result.structuredContent?.effect === 'refused';
  if (result.isError || refused) {
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
    const recovery = driverFailureRecovery(
      result.structuredContent,
      message,
      toolName,
      originalArgs,
    );
    if (refused) failure.error = 'Cua Driver refused the request.';
    if (recovery) failure.error = recovery.message;
    if (safeErrorText) failure.error = safeErrorText + (recovery ? `\n${recovery.message}` : '');
    console.error(`[pi-computer-use] upstream tool failed (category=${failure.errorCategory})`);
    const metadata = {
      ...safeFailureMetadata(result.structuredContent),
      ...(refused ? { status: 'refused' } : {}),
      ...(recovery
        ? {
            code: recovery.code,
            ...recovery.metadata,
            ...(recovery.nextCall ? { next_call: recovery.nextCall } : {}),
          }
        : {}),
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
      case 'browser_prepare': {
        const lifecycle = asRecord(sc.lifecycle);
        const idleSeconds = lifecycle?.idle_expires_in_seconds;
        parts.push(
          ...structuredFieldLines(
            {
              prepared_pid: sc.prepared_pid,
              attachment: sc.attachment,
              side_effects: sc.side_effects,
              lifecycle:
                lifecycle?.owner === 'session' &&
                typeof idleSeconds === 'number' &&
                Number.isSafeInteger(idleSeconds) &&
                idleSeconds >= 0 &&
                typeof lifecycle.process_ends_with_session === 'boolean' &&
                typeof lifecycle.profile_persists_after_session === 'boolean'
                  ? {
                      owner: lifecycle.owner,
                      idle_expires_in_seconds: idleSeconds,
                      process_ends_with_session: lifecycle.process_ends_with_session,
                      profile_persists_after_session: lifecycle.profile_persists_after_session,
                    }
                  : undefined,
            },
            existingText,
          ),
        );
        break;
      }
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
  const escalation = asRecord(value.escalation);
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
      recommended: pick(escalation?.recommended, ['foreground', 'page', 'px', 'ax']),
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

// Cua Driver's browser refusal codes and local guidance for messages that may contain private data.
const BROWSER_RECOVERY_HINTS: Record<string, string> = {
  background_unavailable:
    'The requested operation cannot run in the background. Use an available background route or ask for approval before bringing the browser to the foreground.',
  browser_action_unavailable:
    'The requested action is unavailable for this browser reference. Refresh the snapshot and select a reference that supports the action.',
  browser_binding_ambiguous:
    'The window matched more than one browser target. Recheck which native window is intended and continue only once it binds to a single target.',
  browser_ref_stale:
    'Refresh the page snapshot with computer_use_get_browser_state, keeping the same target, tab, and session. Omit the old continuation and scope_ref. Use newly returned refs before retrying the action.',
  browser_binding_stale:
    'Rediscover the browser target and tab with computer_use_get_browser_state using the intended native pid/window_id. Do not reuse the stale target or tab identifiers.',
  browser_consent_revoked:
    'Browser consent was revoked. Obtain authorization again before attempting to attach or act.',
  browser_endpoint_owner_mismatch:
    'Cua Driver could not verify that the DevTools endpoint belongs to the requested process. Rediscover the intended window before binding again.',
  browser_tab_required:
    'Use the tab_id from a prior bind for this target in the same session. If it is unavailable, call computer_use_get_browser_state with pid and window_id in that session, then use the returned target_id and tab_id.',
  browser_tab_not_found:
    'Rediscover the browser target and tab with computer_use_get_browser_state using the intended native pid/window_id. Do not reuse the stale target or tab identifiers.',
  browser_input_incomplete:
    'Some text may already have been entered. Inspect the current field value before sending more text; do not automatically repeat the full input.',
  browser_input_trust_unavailable:
    'The requested trusted input route is unavailable. Inspect the target and use only an input route explicitly authorized for this task.',
  browser_origin_outside_scope:
    'The current page is outside the approved scope. Stop browser input until the intended origin is authorized.',
  browser_reconnect_exhausted:
    'Cua Driver could not reconnect to the browser. Inspect the current browser state and bind again if the browser is available.',
  browser_route_unavailable:
    'Cua Driver could not use a browser route for this request. Check the intended browser and use computer_use_get_guide with topic=browser for setup guidance.',
  browser_wrong_target_refused:
    'Cua Driver could not verify the intended browser target. Rediscover it using the correct native pid and window_id before acting.',
};

const SAFE_MISSING_TAB_REASONS = [
  'snapshot mode requires a tab_id from a prior bind',
  'this operation requires an explicit tab_id from get_browser_state',
];

const DRIVER_RECOVERY_HINTS: Record<string, string> = {
  window_id_not_found:
    'The window ID is no longer available. Call computer_use_list_windows in the same session to find a current window ID before retrying.',
  window_owner_pid_mismatch:
    'The window belongs to a different process. Call computer_use_list_windows to confirm its owner before reading the window again.',
  stale_element_token:
    'The element token is stale. Call computer_use_get_window_state for the intended window in the same session, then use its fresh element_token.',
  session_ended:
    'The Driver session has ended. Call computer_use_start_session with the same session label to restart it. For an unnamed session, omit the label.',
  session_cleanup_pending:
    'Session cleanup is still in progress. Call computer_use_end_session again for the same session to confirm it finished.',
  session_cleanup_partial:
    'The session ended and some resources still need cleanup. Call computer_use_end_session again for the same session to retry cleanup.',
};

type DriverRecovery = {
  code: string;
  message: string;
  nextCall?: { tool: string; arguments: Record<string, unknown> };
  metadata?: Record<string, unknown>;
};

function driverFailureRecovery(
  value: unknown,
  text: string,
  toolName?: string,
  originalArgs?: Record<string, unknown>,
): DriverRecovery | undefined {
  let root = asRecord(value);
  if (!root) {
    try {
      root = asRecord(JSON.parse(text));
    } catch {
      /* Raw errors need not be JSON. */
    }
  }
  const error = asRecord(root?.refusal) ?? asRecord(root?.error);
  const session = originalArgs?.session;
  const validSession =
    session === undefined || (typeof session === 'string' && session.length <= 1024);
  const nativeCode = [error?.code, root?.code].find(
    (item): item is string =>
      typeof item === 'string' && Object.hasOwn(DRIVER_RECOVERY_HINTS, item),
  );
  // Some MCP proxies put the known session refusal inside a generic invocation failure.
  const wrappedSessionEnded =
    root?.code === 'tool_invocation_failed' &&
    typeof session === 'string' &&
    validSession &&
    toolName !== undefined &&
    text
      .split(/\r?\n/)
      .includes(
        `session has ended; tool call '${toolName}' was rejected. Call start_session with session '${session}' to start it again, or use a new session label.`,
      );
  if (nativeCode || wrappedSessionEnded) {
    const code = nativeCode ?? 'session_ended';
    const message = `${code}: ${DRIVER_RECOVERY_HINTS[code]}`;
    if (code === 'window_owner_pid_mismatch' && toolName === 'get_window_state') {
      const ownerPid = root?.owner_pid;
      const windowId = originalArgs?.window_id;
      if (isPositiveId(ownerPid) && isPositiveId(windowId) && root?.window_id === windowId) {
        const basicRead =
          validSession &&
          Object.keys(originalArgs ?? {}).every((key) =>
            ['pid', 'window_id', 'session'].includes(key),
          );
        return {
          code,
          message: `${code}: Window ${windowId} belongs to PID ${ownerPid}. Repeat computer_use_get_window_state with that PID, keeping the same window ID, session and read options.`,
          metadata: { owner_pid: ownerPid },
          ...(basicRead
            ? {
                nextCall: {
                  tool: 'get_window_state',
                  arguments: {
                    pid: ownerPid,
                    window_id: windowId,
                    ...(typeof session === 'string' ? { session } : {}),
                  },
                },
              }
            : {}),
        };
      }
    }
    if (code === 'session_cleanup_pending' || code === 'session_cleanup_partial') {
      return {
        code,
        message,
        metadata: {
          ...(typeof root?.cleanup_complete === 'boolean'
            ? { cleanup_complete: root.cleanup_complete }
            : {}),
          ...(typeof root?.cleanup_in_progress === 'boolean'
            ? { cleanup_in_progress: root.cleanup_in_progress }
            : {}),
        },
      };
    }
    return { code, message };
  }
  if (
    toolName !== 'get_browser_state' &&
    toolName !== 'page' &&
    !toolName?.startsWith('browser_')
  ) {
    return undefined;
  }
  const code = [
    error?.code,
    root?.code,
    text.match(/^(?:Error:\s*)?(browser_[a-z_]+)\b/)?.[1],
  ].find(
    (item): item is string =>
      typeof item === 'string' &&
      (item === 'browser_requires_setup' ||
        item === 'browser_consent_required' ||
        Object.hasOwn(BROWSER_RECOVERY_HINTS, item)),
  );
  if (!code) return undefined;
  if (Object.hasOwn(BROWSER_RECOVERY_HINTS, code)) {
    const hint =
      code === 'background_unavailable' && toolName === 'browser_prepare'
        ? 'Read the intended window with computer_use_get_window_state and use the accessibility tree with computer_use_set_value or computer_use_click and a fresh element_token. If the page controls are unavailable, ask for approval before bringing the browser to the foreground.'
        : BROWSER_RECOVERY_HINTS[code];
    const reason =
      code === 'browser_tab_required'
        ? SAFE_MISSING_TAB_REASONS.find((candidate) => candidate === error?.message)
        : undefined;
    return { code, message: reason ? `refused (${code}): ${reason}\n${hint}` : `${code}: ${hint}` };
  }
  const detail = asRecord(root?.detail) ?? asRecord(error?.detail);
  const next = asRecord(detail?.next_call) ?? asRecord(root?.next_call);
  const args = asRecord(next?.arguments);
  const pid = args?.pid;
  const windowId = args?.window_id;
  const existing = asRecord(args?.strategy)?.kind === 'existing_profile';
  const nextCall =
    next?.tool === 'browser_prepare' &&
    existing &&
    isPositiveId(pid) &&
    isPositiveId(windowId) &&
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
