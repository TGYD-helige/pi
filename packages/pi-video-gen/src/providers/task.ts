import { createWriteStream, existsSync } from 'node:fs';
import { lstat, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  describeToolError,
  hostFromUrl,
  safeFetch,
  trustedHostsFromUrls,
} from '@amaster.ai/pi-shared';
import {
  RemoteTaskFailedError,
  RetryableProviderError,
  safeBasename,
  VideoGenError,
} from '../errors.js';
import type { RemoteTaskStatus, VideoFileMeta } from '../types.js';

/**
 * Shared machinery for task-style video APIs: poll-with-limits, streaming
 * download with guards, and a sliding-window rate limiter. Adapters only build
 * requests and parse responses; everything here is signal-driven so a tool
 * cancellation propagates into polling loops and downloads.
 */

/**
 * Provider failure messages are UNTRUSTED input: they can be unbounded, carry
 * signed URLs, or attempt prompt injection into the LLM that reads the tool
 * result. Collapse to one line, drop URLs, cap length.
 */
export function sanitizeProviderMessage(raw: string): string {
  const oneLine = raw.split(/[\r\n]/, 1)[0] ?? '';
  const noUrls = oneLine.replace(/https?:\/\/\S+/g, '<url>');
  return noUrls.length > 200 ? `${noUrls.slice(0, 200)}…` : noUrls;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLL_ATTEMPTS = 300;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class CancelledError extends VideoGenError {
  constructor() {
    super('Cancelled.', 'cancelled', new DOMException('Cancelled', 'AbortError'));
  }
}

/**
 * Poll `check` until the task succeeds, fails, or the budget runs out.
 * Defaults to a 2s interval, 300 attempts, and at most 5 consecutive
 * transport errors.
 */
export async function pollTask(opts: {
  check: () => Promise<RemoteTaskStatus>;
  signal?: AbortSignal | undefined;
  intervalMs?: number | undefined;
  maxAttempts?: number | undefined;
  maxConsecutiveErrors?: number | undefined;
  onTick?: ((attempt: number, phase: string) => void) | undefined;
}): Promise<Extract<RemoteTaskStatus, { phase: 'succeeded' }>> {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;

  let consecutiveErrors = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new CancelledError();

    let status: RemoteTaskStatus;
    try {
      status = await opts.check();
      consecutiveErrors = 0;
    } catch (error) {
      if (error instanceof VideoGenError && error.logSummary === 'cancelled') throw error;
      if (!(error instanceof RetryableProviderError)) throw error;
      consecutiveErrors++;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new VideoGenError(
          'Lost contact with the video provider while polling (repeated network errors). The remote task may still be running and billable; check usage before retrying.',
          'poll: consecutive transport errors',
          error,
        );
      }
      await sleep(intervalMs, opts.signal);
      continue;
    }

    opts.onTick?.(attempt, status.phase);
    if (status.phase === 'succeeded') return status;
    if (status.phase === 'failed') {
      // Provider text is UNTRUSTED: it stays off the LLM channel entirely
      // (errors.ts contract). The sanitized one-liner goes to stderr/manifest
      // via logSummary; the user gets a vetted, actionable message.
      throw new RemoteTaskFailedError(
        'Video generation failed on the provider side. Retry once; if it persists, adjust the prompt or model. The job manifest records the (sanitized) provider reason.',
        'poll: task failed',
        sanitizeProviderMessage(status.message),
      );
    }
    await sleep(intervalMs, opts.signal);
  }

  throw new VideoGenError(
    'Video generation did not finish within the polling budget. The remote task may still complete later and be billable; check provider usage before retrying.',
    'poll: max attempts exceeded',
    new DOMException('Polling deadline exceeded', 'TimeoutError'),
  );
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB ceiling for 4K clips

/** MP4 files carry an `ftyp` box at offset 4; reject anything else (error pages, XML). */
function looksLikeMp4(header: Buffer): boolean {
  return header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp';
}

/**
 * Stream `url` to `destPath` with guards: temp file in the same directory,
 * byte ceiling, mp4 magic-byte check, atomic rename into place.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min overall deadline

export async function downloadFile(opts: {
  url: string;
  destPath: string;
  fetchImpl: typeof fetch;
  /** The provider this download belongs to — its baseUrl host is trusted for SSRF. */
  provider: { baseUrl: string };
  signal?: AbortSignal | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<VideoFileMeta> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  // EXCLUSIVELY-created temp (O_EXCL 'wx' — a pre-placed symlink fails
  // EEXIST instead of being followed) + atomic rename at the end.
  let tmpPath = '';
  for (let i = 0; ; i++) {
    const candidate = `${opts.destPath}.tmp-${process.pid}-${i}`;
    if (existsSync(candidate)) continue;
    tmpPath = candidate;
    break;
  }
  // Overall deadline, combined with the caller's cancellation signal — a
  // never-ending response stream must not park the foreground tool forever.
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);

  // Destination symlink defense: refuse anything pre-existing at the final
  // name that is not a regular file (belt-and-suspenders — the unique temp
  // name + atomic rename already prevent following links).
  {
    const st = await lstat(opts.destPath).catch(() => null);
    if (st && (st.isSymbolicLink() || !st.isFile())) {
      throw new VideoGenError(
        `Refusing to write ${safeBasename(opts.destPath)} — it already exists and is not a regular file (symlink?). Remove it and retry.`,
        'download: destination not a file',
      );
    }
  }

  // The video URL comes from the configured provider. Trust the configured
  // baseUrl host outright (operator intent), plus the returned media host when
  // it is a DNS name — under fake-ip DNS such hosts resolve to 198.18/16 and
  // the proxy dials the real address upstream. An IP-literal media host (a
  // loopback/private address the provider returned) keeps the full guard.
  const mediaHost = hostFromUrl(opts.url);
  const trustedHosts = trustedHostsFromUrls(
    opts.provider.baseUrl,
    mediaHost && !isIP(mediaHost.replace(/^\[|\]$/g, '')) ? opts.url : undefined,
  );
  let res: Response;
  try {
    res = await safeFetch(opts.url, { signal }, { trustedHosts });
  } catch (error) {
    if (error instanceof Error && /public HTTP|redirect limit/i.test(error.message)) {
      throw new VideoGenError(error.message, 'download: unsafe URL');
    }
    if (opts.signal?.aborted) throw new CancelledError();
    const failure = describeToolError(
      'Video download',
      signal.aborted ? signal.reason : error,
      'The paid task is preserved. Resume this job to retry the download; do not regenerate.',
    );
    throw new VideoGenError(
      failure.error,
      `download: ${failure.errorCategory}`,
      signal.aborted ? signal.reason : error,
    );
  }
  if (!res.ok || !res.body) {
    throw new VideoGenError(
      `Downloading the finished video failed with HTTP ${res.status}. The paid task is preserved. Inspect the task and resume the download; do not regenerate.`,
      `download: HTTP ${res.status}`,
      Object.assign(new Error(), { status: res.status }),
    );
  }

  let bytes = 0;
  let headerBytes = 0;
  const headerChunks: Buffer[] = [];
  const counting = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new VideoGenError('Video file exceeds the size ceiling.', 'download: too large'));
        return;
      }
      if (headerBytes < 16) {
        headerChunks.push(Buffer.from(chunk.subarray(0, 16)));
        headerBytes += chunk.length;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      counting,
      createWriteStream(tmpPath, { flags: 'wx' }),
    );
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    if (error instanceof VideoGenError) throw error;
    if (opts.signal?.aborted) throw new CancelledError();
    if (signal.aborted) {
      throw new VideoGenError(
        'Downloading the video timed out. Retry once — the clip is large or the connection slow.',
        'download: timeout',
        signal.reason,
      );
    }
    throw new VideoGenError(
      'Downloading the finished video failed mid-stream. Retry once.',
      'download: stream error',
    );
  }

  const header = Buffer.concat(headerChunks);
  if (!looksLikeMp4(header)) {
    await unlink(tmpPath).catch(() => {});
    throw new VideoGenError(
      'The provider returned a file that is not an mp4. Not saving it; check the model and prompt.',
      'download: not mp4',
    );
  }

  await rename(tmpPath, opts.destPath);
  return { path: opts.destPath, bytes };
}

/**
 * Process-local sliding-window rate limiter (per provider). Daily caps are
 * tracked for the process lifetime only — good enough to protect a single
 * render run; persistent quota accounting is the provider dashboard's job.
 */
export class RateLimiter {
  private readonly calls: number[] = [];

  constructor(
    private readonly maxPerMinute?: number,
    private readonly maxPerDay?: number,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      const minuteAgo = now - 60_000;
      const dayAgo = now - 86_400_000;
      while (this.calls.length > 0 && this.calls[0]! < dayAgo) this.calls.shift();

      const inLastMinute = this.calls.filter((t) => t >= minuteAgo).length;
      const minuteOk = this.maxPerMinute == null || inLastMinute < this.maxPerMinute;
      const dayOk = this.maxPerDay == null || this.calls.length < this.maxPerDay;
      if (minuteOk && dayOk) {
        this.calls.push(now);
        return;
      }
      const waitMs = minuteOk ? 60_000 : Math.max(1000, 60_000 - (now - (this.calls[0] ?? now)));
      await sleep(Math.min(waitMs, 60_000), signal);
    }
  }
}
