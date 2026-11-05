export type ErrorCategory =
  | 'timeout'
  | 'cancelled'
  | 'http_error'
  | 'network_error'
  | 'request_failed'
  | 'configuration_error'
  | 'invalid_request'
  | 'invalid_response';
export interface ErrorClassification {
  errorCategory: ErrorCategory;
  httpStatus?: number;
}

/** Only allowlisted categories and numeric HTTP statuses cross the error boundary. */
export function classifyError(error: unknown): ErrorClassification {
  let value = error;
  let fallback: ErrorCategory = 'request_failed';
  for (let depth = 0; depth < 4 && value instanceof Error; depth++, value = value.cause) {
    const tagged = value as Error & Partial<ErrorClassification>;
    if (
      [
        'timeout',
        'cancelled',
        'http_error',
        'network_error',
        'request_failed',
        'configuration_error',
        'invalid_request',
        'invalid_response',
      ].includes(tagged.errorCategory ?? '')
    ) {
      return {
        errorCategory: tagged.errorCategory!,
        ...(typeof tagged.httpStatus === 'number' &&
        Number.isInteger(tagged.httpStatus) &&
        tagged.httpStatus >= 400 &&
        tagged.httpStatus < 600
          ? { httpStatus: tagged.httpStatus }
          : {}),
      };
    }
    const code = (value as NodeJS.ErrnoException).code;
    if (
      value.name === 'TimeoutError' ||
      (code as unknown) === -32001 ||
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code ?? '')
    )
      return { errorCategory: 'timeout' };
    if (value.name === 'AbortError') fallback = 'cancelled';
    const status =
      (value as Error & { status?: unknown; statusCode?: unknown }).status ??
      (value as Error & { statusCode?: unknown }).statusCode;
    const message = typeof value.message === 'string' ? value.message.slice(0, 1024) : '';
    // Providers can serialize exceptions before Agent sees them; retain only recognizable categories.
    if (
      /^(?:Error:\s*)?(?:TimeoutError\b|Timed out\b|Navigation timeout of \d+ ms exceeded\b|(?:the )?(?:request|operation|connection) (?:was )?(?:timed out|aborted due to timeout)\b)/i.test(
        message,
      )
    )
      return { errorCategory: 'timeout' };
    if (
      /^(?:Error:\s*)?(?:AbortError\b|(?:the )?(?:request|operation) (?:was )?(?:aborted|cancelled|canceled)\b)/i.test(
        message,
      )
    )
      fallback = 'cancelled';
    const httpStatus =
      typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
        ? status
        : Number(
            message.match(/(?:^|HTTP[ :]+|API error[ :]+)([45]\d{2})\b/)?.[1] ??
              message.match(/^Mem0 request failed \(([45]\d{2})\)\.$/)?.[1],
          );
    if (httpStatus) return { errorCategory: 'http_error', httpStatus };
    if (
      ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(
        code ?? '',
      )
    )
      return { errorCategory: 'network_error' };
  }
  return { errorCategory: fallback };
}

export function describeToolError(operation: string, error: unknown, recoveryHint?: string) {
  const classification = classifyError(error);
  if (error instanceof SafeToolError) return { error: error.message, ...classification };
  const { errorCategory, httpStatus } = classification;
  const reason =
    errorCategory === 'timeout'
      ? 'timed out'
      : errorCategory === 'cancelled'
        ? 'was cancelled'
        : errorCategory === 'network_error'
          ? 'failed because of a network error'
          : `failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}`;
  const hint =
    recoveryHint ??
    (httpStatus === 401 || httpStatus === 403
      ? 'Check the provider credentials and permissions.'
      : httpStatus === 429
        ? 'Rate limited; wait before retrying.'
        : 'Check provider availability and the request before retrying.');
  return { error: `${operation} ${reason}. ${hint}`, ...classification };
}

/** A sanitized exception retains classification without retaining the raw cause. */
export class SafeToolError extends Error implements ErrorClassification {
  readonly errorCategory: ErrorCategory;
  readonly httpStatus?: number;
  constructor(operation: string, error: unknown, recoveryHint?: string) {
    const failure = describeToolError(operation, error, recoveryHint);
    super(failure.error);
    this.name = 'SafeToolError';
    this.errorCategory = failure.errorCategory;
    if (failure.httpStatus) this.httpStatus = failure.httpStatus;
  }
}

/** Only use fixed, vetted validation messages here, never raw provider text. */
export class ValidationError extends SafeToolError {
  override readonly errorCategory: 'configuration_error' | 'invalid_request' | 'invalid_response';
  constructor(message: string, category: ValidationError['errorCategory'] = 'invalid_request') {
    super('Validation', undefined);
    this.name = 'ValidationError';
    this.message = message;
    this.errorCategory = category;
  }
}

/** Recover only the surviving category from an Agent terminal message. */
export function modelResponseError(
  operation: string,
  message: { stopReason?: string; errorMessage?: string },
  recoveryHint?: string,
): SafeToolError {
  const error = new Error(message.errorMessage?.slice(0, 1024) ?? '');
  if (message.stopReason === 'aborted') error.name = 'AbortError';
  return new SafeToolError(operation, error, recoveryHint);
}
