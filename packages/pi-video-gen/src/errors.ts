import { classifyError, describeToolError, SafeToolError } from '@amaster.ai/pi-shared';
import type { VideoApiStyle } from './types.js';

/**
 * Trust boundary for the whole extension, modeled on pi-image-gen's errors.ts.
 * Raw provider bodies — and plain `fs`/`fetch` errors, which embed absolute
 * paths, errno strings, or signed `?token=…` URLs — must reach NEITHER the
 * user/LLM surface NOR a log. Every EXPECTED failure is thrown as a
 * `VideoGenError`, the only value whose text is vetted body-free, carrying two
 * curated views: `message` (LLM-facing) and `logSummary` (stderr-facing).
 */
export class VideoGenError extends SafeToolError {
  readonly logSummary: string;
  constructor(message: string, logSummary: string, cause?: unknown) {
    super('Media operation', cause ?? new Error(message));
    this.message = message;
    this.name = 'VideoGenError';
    this.logSummary = logSummary.split(/[\r\n]/, 1)[0] || 'video generation failed';
  }
}

/**
 * Marker for "the submit may (or may not) have created a paid remote task".
 * Render orchestration must NOT auto-resubmit on this — the shot is parked in
 * an `ambiguous` state until the user confirms the provider side is clean.
 */
export class AmbiguousSubmitError extends VideoGenError {
  constructor(message: string, logSummary: string, cause?: unknown) {
    super(message, logSummary, cause);
    if (this.errorCategory === 'timeout') this.message = `The request timed out. ${message}`;
  }
}

/** Marker for inspect failures that are safe and useful to retry locally. */
export class RetryableProviderError extends VideoGenError {}

/** Marker for a remote task that reached a definitive terminal failure. */
export class RemoteTaskFailedError extends VideoGenError {
  readonly providerMessage: string;
  constructor(message: string, logSummary: string, providerMessage: string) {
    super(message, logSummary);
    this.providerMessage = providerMessage;
  }
}

/** Marker for a persisted task handle the provider definitively cannot find. */
export class RemoteTaskNotFoundError extends VideoGenError {}

/** stderr sink: a VideoGenError's curated summary, else a fixed label. */
export function toLogSummary(error: unknown): string {
  if (error instanceof VideoGenError) return error.logSummary;
  return error instanceof Error ? 'unexpected error' : 'unexpected non-error throw';
}

/** user/LLM sink: a VideoGenError's vetted message, else a fixed sentence. */
export function errorMessageForUser(error: unknown): string {
  if (error instanceof VideoGenError) return error.message;
  if (classifyError(error).errorCategory !== 'request_failed')
    return describeToolError(
      'Video generation',
      error,
      'Inspect the saved job and provider task before retrying; do not submit another generation automatically.',
    ).error;
  return 'Video generation failed unexpectedly. Inspect the saved job and provider task before retrying; report a pi-video-gen bug if it persists.';
}

/**
 * Reduce a URL to `scheme://host/path`, dropping the query (where signed
 * credentials live), the fragment, and any userinfo.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<url>';
  }
}

/** Return a filename without leaking POSIX or Windows parent directories. */
export function safeBasename(path: string): string {
  return path.split(/[\\/]/).pop() || 'file';
}

const PROVIDER_LABELS: Record<VideoApiStyle, string> = {
  ark: 'Volcengine Ark',
  kling: 'Kling',
  dashscope: 'DashScope',
  openrouter: 'OpenRouter',
  newapi: 'NewAPI',
  minimax: 'MiniMax',
};

export function providerLabel(style: VideoApiStyle): string {
  return PROVIDER_LABELS[style];
}

/** Missing-API-key error naming the exact settings path / env var to fix. */
export function missingKeyError(
  style: VideoApiStyle,
  envVar: string,
  apiKeyPath = `pi-video-gen.providers.${style}.apiKey`,
): VideoGenError {
  return new VideoGenError(
    `No API key configured for ${providerLabel(style)}. Set "${apiKeyPath}" in global or agent-dir Pi settings — "${`$\{${envVar}}`}" interpolation is supported — then retry.`,
    `${providerLabel(style)}: missing api key`,
  );
}

/** HTTP status error with NO response body attached (bodies may carry secrets). */
export function httpStatusError(
  style: VideoApiStyle,
  action: string,
  status: number,
): VideoGenError {
  const hint =
    status === 401 || status === 403
      ? ' Check the API key.'
      : status === 429
        ? ' Rate limited — lower concurrency or wait.'
        : '';
  const ErrorType =
    action === 'inspect' && status === 404
      ? RemoteTaskNotFoundError
      : status === 429 || status >= 500
        ? RetryableProviderError
        : VideoGenError;
  return new ErrorType(
    `${providerLabel(style)} ${action} failed with HTTP ${status}.${hint}`,
    `${providerLabel(style)} ${action} HTTP ${status}`,
    Object.assign(new Error(), { status }),
  );
}

/** Network-level failure (no HTTP status). Message stays free of error.message paths. */
export function networkError(style: VideoApiStyle, action: string, error?: unknown): VideoGenError {
  const networkCause =
    classifyError(error).errorCategory === 'request_failed'
      ? Object.assign(new Error(), { code: 'UND_ERR_SOCKET' })
      : error;
  const failure = describeToolError(
    `${providerLabel(style)} ${action}`,
    networkCause,
    'Inspect the saved task before retrying; do not submit another generation.',
  );
  return new RetryableProviderError(
    failure.error,
    `${providerLabel(style)} ${action} ${failure.errorCategory}`,
    networkCause,
  );
}
