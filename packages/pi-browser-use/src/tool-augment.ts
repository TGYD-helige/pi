// Extra hints appended to upstream tool descriptions.
// These steer the LLM toward correct usage (e.g. "call take_snapshot first").
const DESCRIPTION_HINTS: Record<string, string> = {
  fill_form:
    ' Fills multiple standard HTML form fields at once. Same limitations as fill — does not work on canvas/custom widgets.',
  fill: ' Fills standard HTML form fields (<input>, <textarea>, <select>) by uid. Does NOT work on custom/canvas-based widgets (e.g., Google Sheets cells, Notion blocks). If fill times out or fails, click the element first then use type_text to enter the text.',
  click_at:
    ' Clicks at exact pixel coordinates (x, y). Use when you have specific coordinates for visual elements.',
  click:
    ' Use the element uid from the accessibility tree snapshot (e.g., uid="87_4"). UIDs are invalidated after this action — call take_snapshot before using another uid.',
  hover: ' Use the element uid from the accessibility tree snapshot to hover over elements.',
  take_snapshot:
    ' Returns the accessibility tree with uid values for each element. Call this FIRST to see available elements, and AFTER every state-changing action (click, fill, press_key) before using any uid.',
  navigate_page: ' Navigate to the specified URL. Call take_snapshot after to see the new page.',
  new_page:
    ' Opens a new page/tab with the specified URL. Call take_snapshot after to see the new page.',
  press_key:
    ' Press a SINGLE keyboard key (e.g., "Enter", "Tab", "Escape", "ArrowDown", "a", "8"). ONLY accepts one key name — do NOT pass multi-character strings like "Hello" or "A1\\nEnter". To type text, use type_text instead of calling press_key for each character.',
};

/** Append usage hints to tool descriptions based on tool name keywords. */
export function augmentToolDescription(toolName: string, description: string): string {
  for (const [key, hint] of Object.entries(DESCRIPTION_HINTS)) {
    if (toolName.toLowerCase().includes(key)) {
      return description + hint;
    }
  }
  return description;
}

const OVERLAY_PATTERNS = [
  'not interactable',
  'obscured',
  'intercept',
  'blocked',
  'element is not visible',
  'element not found',
];

/**
 * Post-process tool output before returning to the LLM:
 * - Strip embedded page snapshots (token bloat) from non-snapshot tools
 * - Detect overlay/interactable issues on click actions
 * - Detect stale element references
 */
export function postProcessToolResult(toolName: string, result: string): string {
  let processed = result;

  // Strip embedded snapshots to prevent token bloat (except take_snapshot)
  if (toolName !== 'take_snapshot' && processed.includes('## Latest page snapshot')) {
    const parts = processed.split('## Latest page snapshot');
    processed = parts[0]!.trim();
  }

  // Detect overlay/interactable issues on click actions
  if (toolName === 'click' || toolName.includes('click')) {
    const isOverlayIssue = OVERLAY_PATTERNS.some((pattern) =>
      processed.toLowerCase().includes(pattern),
    );
    if (isOverlayIssue) {
      processed +=
        '\n\nThis action may have been blocked by an overlay, popup, or tooltip. ' +
        'Look for close/dismiss buttons in the accessibility tree and click them first.';
    }
  }

  // Detect stale element references
  if (processed.toLowerCase().includes('stale') || processed.toLowerCase().includes('detached')) {
    processed +=
      '\n\nThe element reference is stale. Call take_snapshot to get fresh element uids.';
  }

  return processed;
}

export function extractTextContent(content?: Array<{ type: string; text?: string }>): string {
  if (!content || !Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}
