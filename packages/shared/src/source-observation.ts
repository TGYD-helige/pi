import { createHash, randomUUID } from 'node:crypto';

export type SourceObservationReceiptV1 = {
  version: 'source_observation_v1';
  observationId: string;
  runId: string;
  toolName: string;
  requestedLocator: string;
  finalLocator: string;
  capturedAt: string;
  mediaType: string | null;
  contentHash: string;
  observedChars: number | null;
  observedBytes: number | null;
  truncated: boolean;
};

export type SourceObservationInput = {
  runId: string;
  toolName: string;
  requestedLocator: string;
  finalLocator: string;
  mediaType: string | null;
  content: string | Uint8Array;
  truncated: boolean;
  observationId?: string;
  now?: Date;
};

export function sanitizeObservationLocator(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
  } catch {
    return '[redacted]';
  }
}

export function createSourceObservationReceipt(
  input: SourceObservationInput,
): SourceObservationReceiptV1 {
  const bytes =
    typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
  return {
    version: 'source_observation_v1',
    observationId: input.observationId ?? randomUUID(),
    runId: input.runId,
    toolName: input.toolName,
    requestedLocator: sanitizeObservationLocator(input.requestedLocator),
    finalLocator: sanitizeObservationLocator(input.finalLocator),
    capturedAt: (input.now ?? new Date()).toISOString(),
    mediaType: input.mediaType,
    contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    observedChars: typeof input.content === 'string' ? input.content.length : null,
    observedBytes: bytes.byteLength,
    truncated: input.truncated,
  };
}
