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
      /^(?:Error:\s*)?(?:AbortError\b|(?:(?:the|this) )?(?:request|operation) (?:was )?(?:aborted|cancelled|canceled)\b)/i.test(
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

/** Keep only verified transport metadata before a provider serializes its exception. */
export function createModelErrorCapture() {
  let failure: ErrorClassification | undefined;
  const record = (error: unknown) => {
    const classified = classifyError(error);
    failure = classified.errorCategory !== 'request_failed' ? classified : undefined;
  };
  return {
    run<T>(request: () => T): T {
      failure = undefined;
      try {
        return request();
      } catch (error) {
        record(error);
        throw error;
      }
    },
    fetchOptions(api: unknown, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
      // These SDKs reject or ignore custom fetch; leave their transport unchanged.
      if (
        typeof api !== 'string' ||
        ['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(api)
      )
        return {};
      return {
        fetch: async (...args: Parameters<typeof globalThis.fetch>) => {
          try {
            const response = await fetchImpl(...args);
            failure =
              response.status >= 400 && response.status < 600
                ? { errorCategory: 'http_error', httpStatus: response.status }
                : undefined;
            return captureResponseBody(response, record);
          } catch (error) {
            record(error);
            throw error;
          }
        },
      };
    },
    error(
      operation: string,
      message: { stopReason?: string; errorMessage?: string },
      recoveryHint?: string,
    ): SafeToolError {
      const surviving = modelResponseError(operation, message, recoveryHint);
      return failure &&
        (failure.errorCategory === 'timeout' || surviving.errorCategory === 'request_failed')
        ? new SafeToolError(operation, Object.assign(new Error(), failure), recoveryHint)
        : surviving;
    },
  };
}

function captureResponseBody(response: Response, record: (error: unknown) => void): Response {
  if (!response.body || response.status < 200) return response;
  const reader = response.body.getReader();
  let stopped = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (stopped) return;
        if (chunk.done) {
          stopped = true;
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        if (stopped) return;
        stopped = true;
        record(error);
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      stopped = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const preserveMetadata = (target: Response): Response => {
    Object.defineProperties(target, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
      clone: { value: () => preserveMetadata(Response.prototype.clone.call(target)) },
    });
    return target;
  };
  return preserveMetadata(wrapped);
}
