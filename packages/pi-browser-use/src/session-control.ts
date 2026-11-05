import { describeToolError, SafeToolError } from '@amaster.ai/pi-shared';
import { StringEnum } from '@earendil-works/pi-ai';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';

export const SESSION_DESCRIPTION =
  'Retain the current live browser before waiting for human QR login, MFA, or another operation that must preserve the original page. Ordinary tasks do not need retention. Check status after resuming, re-list pages, and release retention when the handoff is complete or cancelled. Retention consumes resources and cannot extend website login deadlines.';

export const sessionParameters: ReturnType<typeof Type.Object> = Type.Object({
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
    const failure = describeToolError(
      'Browser session operation',
      error,
      'The action may have completed. Inspect the original page before retrying.',
    );
    if (error instanceof SafeToolError) failure.error = error.message;
    if (!control) failure.error = 'Browser session retention is not configured.';
    console.error(
      `[pi-browser-use] browser session control failed (category=${failure.errorCategory})`,
    );
    return {
      isError: true,
      content: [{ type: 'text' as const, text: failure.error }],
      structuredContent: failure,
      details: {},
    };
  }
}

export class BrowserSessionError extends SafeToolError {
  constructor(message: string, cause?: unknown) {
    super('Browser session', cause ?? new Error(message));
    this.message = message;
    this.name = 'BrowserSessionError';
  }
}

export function scriptValue(value: unknown): unknown {
  const result = CallToolResultSchema.parse(value);
  const text =
    result.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n') ?? '';
  const match = /```json\s*([\s\S]*?)\s*```/.exec(text);
  if (result.isError || !match)
    throw new BrowserSessionError('The original browser page could not be verified.');
  return JSON.parse(match[1]!);
}
