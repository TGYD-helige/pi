import {
  classifyError,
  describeToolError,
  readResponseBytes,
  SafeToolError,
} from '@amaster.ai/pi-shared';
import type { ResolvedProvider } from './types.js';

/**
 * Trust boundary for the whole extension. Raw provider bodies — and plain
 * `fs`/`fetch` errors, which embed absolute paths, errno strings, or signed
 * `?token=…` URLs — must reach NEITHER the user/LLM surface NOR a log. So every
 * EXPECTED failure is thrown as an `ImageGenError`, the only value whose text is
 * vetted body-free, carrying two curated views: `message` (LLM-facing, "what
 * happened + what to do") and `logSummary` (a terse provider/status/category
 * one-liner, e.g. `OpenAI HTTP 400 (bad-request)`). The sinks below surface
 * those views and redact anything else.
 */
export class ImageGenError extends SafeToolError {
  readonly logSummary: string;
  constructor(message: string, logSummary: string, cause?: unknown) {
    super('Media operation', cause ?? new Error(message));
    this.message = message;
    this.name = 'ImageGenError';
    this.logSummary = logSummary.split(/[\r\n]/, 1)[0] || 'image generation failed';
  }
}

/**
 * stderr sink: an ImageGenError's curated summary, else a fixed label. Anything
 * that isn't an ImageGenError is untrusted — an Error's `message` and its
 * (writable) `name` can carry a path, errno, signed URL, or a log-injection
 * newline, and a thrown non-Error is arbitrary — so we surface a constant string
 * and never read a single byte off the value.
 */
export function toLogSummary(error: unknown): string {
  if (error instanceof ImageGenError) return error.logSummary;
  return error instanceof Error ? 'unexpected error' : 'unexpected non-error throw';
}

/** user/LLM sink: an ImageGenError's vetted message, else a fixed sentence. */
export function errorMessageForUser(error: unknown): string {
  if (error instanceof ImageGenError) return error.message;
  if (classifyError(error).errorCategory !== 'request_failed')
    return describeToolError(
      'Image generation',
      error,
      'Check whether the provider completed the request before retrying.',
    ).error;
  return 'Image generation failed unexpectedly. Check whether the provider completed the request before retrying; report a pi-image-gen bug if it persists.';
}

/**
 * Reduce a URL to `scheme://host/path`, dropping the query (where signed
 * `?token=…` / `?X-Amz-Signature=…` credentials live), the fragment, and any
 * userinfo. Non-parseable input collapses to `<url>` so it can't smuggle bytes.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<url>';
  }
}

/** Fixed-safe provider label for stderr; custom display names are user-controlled. */
export function providerLogLabel(provider: ResolvedProvider): string {
  return provider.builtIn ? provider.name : 'Custom provider';
}

/** Missing-API-key error naming the exact env var / settings path to fix. */
export function missingKeyError(provider: ResolvedProvider): ImageGenError {
  return new ImageGenError(
    `Provider "${provider.id}" has no API key. Tell the user to set ${providerLocator(provider)}.`,
    `${providerLogLabel(provider)} missing API key`,
  );
}

/** Short, body-free category label for an HTTP status. */
function httpCategory(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status < 600) return 'server-error';
  if (status === 400 || status === 422) return 'bad-request';
  return 'http-error';
}

/**
 * Actionable, body-free error for a provider HTTP failure. The raw response body
 * (which can echo the prompt, credentials, a signed URL, or another tenant's
 * data) is never interpolated — only status + category leave this module.
 */
export function classifyHttpError(res: Response, provider: ResolvedProvider): ImageGenError {
  const where = providerLocator(provider);
  const summary = `${providerLogLabel(provider)} HTTP ${res.status} (${httpCategory(res.status)})`;
  const err = (message: string) =>
    new ImageGenError(message, summary, Object.assign(new Error(), { status: res.status }));

  if (res.status === 401 || res.status === 403) {
    return err(
      `${provider.name} rejected the API key (HTTP ${res.status}). Tell the user to verify ${where}. Do not retry — this will keep failing until the key is fixed.`,
    );
  }
  if (res.status === 404) {
    return err(
      `${provider.name} returned 404 at this baseUrl. Tell the user to verify ${providerBaseUrlLocator(provider)} — the model id may be wrong, or this gateway doesn't expose the image API.`,
    );
  }
  if (res.status === 429) {
    return err(
      `${provider.name} rate-limited the request (HTTP 429). Wait a few seconds before retrying, or suggest a different provider/model.`,
    );
  }
  if (res.status >= 500 && res.status < 600) {
    return err(
      `${provider.name} had a server-side failure (HTTP ${res.status}). This is likely transient — one retry is reasonable, but if it keeps failing tell the user the provider is down.`,
    );
  }
  if (res.status === 400 || res.status === 422) {
    return err(
      `${provider.name} rejected the request (HTTP ${res.status}) — likely a bad parameter or unsupported model id. Tell the user the model name or size may not be supported by this provider.`,
    );
  }
  return err(`${provider.name} returned HTTP ${res.status}.`);
}

/** Release an unread HTTP error body, then throw its body-free classification. */
export async function throwHttpError(res: Response, provider: ResolvedProvider): Promise<never> {
  const error = classifyHttpError(res, provider);
  await cancelResponseBody(res);
  throw error;
}

async function cancelResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Preserve the useful HTTP classification if best-effort connection cleanup fails.
  }
}

/** Structured cancellation check; the writable name is compared, never logged. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Short, body-free category label for a non-HTTP (network/parse) error. */
function networkCategory(error: unknown): string {
  const category = classifyError(error).errorCategory;
  if (category === 'timeout') return 'timeout';
  if (category === 'cancelled') return 'cancelled';
  if (category === 'network_error') return 'unreachable';
  const msg =
    error instanceof Error
      ? error.message.slice(0, 1024)
      : typeof error === 'string'
        ? error.slice(0, 1024)
        : '';
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(msg)) return 'unreachable';
  return 'network-error';
}

/**
 * Actionable, body-free error for a non-HTTP failure (timeout / DNS / abort).
 * The underlying message is used ONLY to classify the failure — it can carry the
 * full request URL (incl. a signed `?token=…`) or host internals, so it is never
 * reproduced. Only the provider name + derived category leave this module.
 */
export function describeNetworkError(error: unknown, provider: ResolvedProvider): ImageGenError {
  const category = networkCategory(error);
  const summary = `${providerLogLabel(provider)} request failed (${category})`;
  const err = (message: string) =>
    new ImageGenError(
      message,
      summary,
      Object.assign(new Error(), {
        errorCategory:
          category === 'unreachable' || category === 'network-error' ? 'network_error' : category,
      }),
    );
  if (category === 'cancelled') {
    return err(`Request to ${provider.name} was cancelled.`);
  }
  if (category === 'timeout') {
    return err(
      `Request to ${provider.name} timed out. The provider was too slow — try a smaller \`n\`, a different model, or check ${providerBaseUrlLocator(provider)}.`,
    );
  }
  if (category === 'unreachable') {
    return err(
      `Cannot reach ${provider.name}. Tell the user to check network connectivity or verify ${providerBaseUrlLocator(provider)}.`,
    );
  }
  return err(`${provider.name} request failed because of a network error.`);
}

/** Read a successful provider body, converting mid-stream failures without echoing raw text. */
export async function readBodyText(res: Response, provider: ResolvedProvider): Promise<string> {
  try {
    if (!res.body) return await res.text();
    return new TextDecoder().decode(await readResponseBytes(res, 128 * 1024 * 1024));
  } catch (error) {
    if (error instanceof Error && /size ceiling/i.test(error.message)) {
      throw new ImageGenError(
        `${provider.name} returned a response that exceeds the size ceiling.`,
        `${providerLogLabel(provider)} response too large`,
      );
    }
    throw describeNetworkError(error, provider);
  }
}

/**
 * Body-free error for a failed image download (a caller-supplied URL or the
 * provider CDN URL, either of which may embed a signed `?token=…`). The URL is
 * always redacted and no raw fetch text / HTTP body is interpolated. `what` is a
 * fixed caller label. Pass `{ httpStatus }` for a non-OK response, or
 * `{ rejected }` with the raw thrown value for a fetch rejection (classify only).
 */
export function describeDownloadError(
  what: string,
  url: string,
  cause: { httpStatus: number } | { rejected: unknown },
): ImageGenError {
  const where = redactUrl(url);
  if ('httpStatus' in cause) {
    return new ImageGenError(
      `Failed to download ${what} from ${where} (HTTP ${cause.httpStatus}). Tell the user to verify the URL is reachable.`,
      `${what} download failed (HTTP ${cause.httpStatus})`,
    );
  }
  const category = networkCategory(cause.rejected);
  return new ImageGenError(
    category === 'timeout'
      ? `Downloading ${what} from ${where} timed out. Retry the download when connectivity recovers.`
      : category === 'cancelled'
        ? `Downloading ${what} from ${where} was cancelled.`
        : `Could not reach ${where} to download ${what}. Tell the user to verify the URL is reachable.`,
    `${what} download failed (${category})`,
    Object.assign(new Error(), {
      errorCategory:
        category === 'unreachable' || category === 'network-error' ? 'network_error' : category,
    }),
  );
}

/** Release an unread download error body, then throw its body-free classification. */
export async function throwDownloadHttpError(
  what: string,
  url: string,
  res: Response,
): Promise<never> {
  const error = describeDownloadError(what, url, { httpStatus: res.status });
  await cancelResponseBody(res);
  throw error;
}

/**
 * Body-free error for a filesystem write failure (creating the output dir or
 * writing an image file). The raw fs error embeds the absolute path + errno, so
 * we classify by its `.code` (validated against an errno shape) into an
 * actionable, path-free hint. `what` is a fixed caller label.
 */
export function describeWriteError(what: string, error: unknown): ImageGenError {
  const rawCode = (error as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof rawCode === 'string' && /^E[A-Z]+$/.test(rawCode) ? rawCode : undefined;
  const reason =
    code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? 'permission was denied'
      : code === 'ENOSPC'
        ? 'the disk is full'
        : code === 'ENOTDIR' || code === 'ENOENT'
          ? 'the path is invalid'
          : 'of a filesystem error';
  return new ImageGenError(
    `Could not ${what} because ${reason}. Tell the user to check the configured output directory (pi-image-gen.outputDir or the tool's outputDir) points at a writable path.`,
    `${what} failed (${code ?? 'fs-error'})`,
  );
}

/** Body-free error for a cancelled operation (`what` is a fixed caller label). */
export function cancelledError(what: string): ImageGenError {
  return new ImageGenError(
    `${what} was cancelled.`,
    `${what} cancelled`,
    new DOMException('Cancelled', 'AbortError'),
  );
}

/**
 * Settings path where the user should fix the apiKey: the env var for built-ins,
 * the JSON path for customProviders. Also used to name the key in HTTP-401 hints.
 */
function providerLocator(provider: ResolvedProvider): string {
  if (provider.builtIn) {
    const envVar = BUILT_IN_ENV_VAR[provider.id] ?? `${provider.id.toUpperCase()}_API_KEY`;
    return `the ${envVar} env var (or pi-image-gen.providers.${provider.id}.apiKey in settings.json)`;
  }
  return `pi-image-gen.customProviders.${provider.id}.apiKey in settings.json`;
}

function providerBaseUrlLocator(provider: ResolvedProvider): string {
  if (provider.builtIn) {
    return `pi-image-gen.providers.${provider.id}.baseUrl`;
  }
  return `pi-image-gen.customProviders.${provider.id}.baseUrl`;
}

const BUILT_IN_ENV_VAR: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ark: 'ARK_API_KEY',
};
