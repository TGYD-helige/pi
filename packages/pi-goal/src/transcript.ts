/**
 * Build a compact text transcript from agent messages for derive/evaluate.
 * Works backwards from the newest message so the most recent context survives
 * the char cap (same approach as pi-memory's serializer).
 */

interface MessageLike {
  role: string;
  content: unknown;
}

export interface TranscriptResult {
  /** Formatted transcript, oldest included message first. */
  text: string;
  /** Count of text-bearing messages omitted wholly or partially by the char cap. */
  omitted: number;
}

/**
 * Build the transcript and report how many text-bearing messages were dropped
 * to fit the cap. The evaluator uses `omitted` to decide whether to warn that
 * evidence may live in the truncated prefix (see buildTruncationNote).
 */
export function buildTranscriptWithMeta(messages: unknown[], maxChars: number): TranscriptResult {
  const lines: string[] = [];
  let total = 0;
  let included = 0;
  let textMessages = 0;
  let truncated = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MessageLike | undefined;
    if (!msg || typeof msg.role !== 'string') continue;
    const text = extractText(msg.content);
    if (!text) continue;
    textMessages += 1;
    const line = `[${msg.role}] ${text}`;
    const separator = lines.length ? 2 : 0;
    const remaining = Math.max(0, maxChars - total - separator);
    if (line.length > remaining && (lines.length > 0 || remaining === 0)) continue;
    const marker = '\n[message middle omitted]\n';
    const prefix = `[${msg.role}] `;
    const head = Math.max(prefix.length, Math.floor((remaining - marker.length) / 3));
    const tail = remaining - marker.length - head;
    const bounded =
      line.length > remaining && tail > 0
        ? `${line.slice(0, head)}${marker}${line.slice(-tail)}`
        : line.slice(0, remaining);
    if (bounded.length < line.length) truncated++;
    lines.unshift(bounded);
    total += bounded.length + separator;
    included += 1;
  }

  return { text: lines.join('\n\n'), omitted: Math.max(0, textMessages - included + truncated) };
}

export function buildTranscript(messages: unknown[], maxChars: number): string {
  return buildTranscriptWithMeta(messages, maxChars).text;
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('\n')
      .trim();
  }
  return '';
}
