import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

export const SESSION_DESCRIPTION =
  'Retain the current live browser before waiting for human QR login, MFA, or another operation that must preserve the original page. Ordinary tasks do not need retention. Check status after resuming, re-list pages, and release retention when the handoff is complete or cancelled. Retention consumes resources and cannot extend website login deadlines.';

export const sessionParameters = Type.Object({
  action: StringEnum(['retain', 'status', 'release'] as const),
});

export type SessionAction = 'retain' | 'status' | 'release';

export async function sessionToolResult(
  action: unknown,
  control?: (action: SessionAction, signal?: AbortSignal) => Promise<object>,
  signal?: AbortSignal,
) {
  try {
    if (!['retain', 'status', 'release'].includes(String(action))) {
      throw new BrowserSessionError('Expected retain, status, or release.');
    }
    if (!control) throw new Error('Browser session retention is not configured.');
    const status = await control(action as SessionAction, signal);
    return { content: [{ type: 'text' as const, text: JSON.stringify(status) }], details: status };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (control && !(error instanceof BrowserSessionError))
      console.error('[pi-browser-use] browser session control failed');
    // Only our own bounded messages may reach the model.
    const message =
      error instanceof BrowserSessionError
        ? error.message
        : !control
          ? 'Browser session retention is not configured.'
          : 'Browser session operation failed.';
    return { isError: true, content: [{ type: 'text' as const, text: message }], details: {} };
  }
}

export class BrowserSessionError extends Error {}
