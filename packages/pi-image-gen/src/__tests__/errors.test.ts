import { classifyError } from '@amaster.ai/pi-shared';
import { describe, expect, it } from 'vitest';
import {
  cancelledError,
  classifyHttpError,
  describeDownloadError,
  describeNetworkError,
  describeWriteError,
  errorMessageForUser,
  ImageGenError,
  missingKeyError,
  readBodyText,
  redactUrl,
  throwHttpError,
  toLogSummary,
} from '../errors.js';
import type { ResolvedProvider } from '../types.js';

const builtIn: ResolvedProvider = {
  id: 'openai',
  api: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  name: 'OpenAI',
  builtIn: true,
};

const custom: ResolvedProvider = {
  id: 'amaster',
  api: 'openai',
  baseUrl: 'https://credits.amaster.ai/',
  apiKey: 'sk-test',
  name: 'amaster',
  builtIn: false,
};

function fakeRes(status: number): Response {
  return new Response('', { status });
}

// A prompt / secret echoed back in a response body — the thing that must reach
// NEITHER the user/LLM-facing message NOR the log summary.
const PROMPT_ECHO = 'prompt was: a photo of a user secret 42';

describe('classifyHttpError', () => {
  it('401 → key locator for built-in points at the env var', () => {
    const { message } = classifyHttpError(fakeRes(401), builtIn);
    expect(message).toMatch(/OPENAI_API_KEY/);
    expect(message).toMatch(/Do not retry/);
  });

  it('401 → key locator for custom points at customProviders settings path', () => {
    const { message } = classifyHttpError(fakeRes(401), custom);
    expect(message).toMatch(/customProviders\.amaster\.apiKey/);
  });

  it('429 mentions rate limiting', () => {
    const { message } = classifyHttpError(fakeRes(429), builtIn);
    expect(message).toMatch(/rate-limited/i);
  });

  it('5xx flagged as transient', () => {
    const { message } = classifyHttpError(fakeRes(503), builtIn);
    expect(message).toMatch(/transient/);
  });

  it('400 hints at parameter / model id mismatch', () => {
    const { message } = classifyHttpError(fakeRes(400), builtIn);
    expect(message).toMatch(/bad parameter|unsupported model/i);
  });

  it('never carries a response body — not in the message, not in the summary', () => {
    // The body is not even passed in anymore; classification is status-only. Both
    // surfaces stay body-free so no prompt/credential/tenant data can leak.
    const err = classifyHttpError(fakeRes(400), builtIn);
    expect(err.message).not.toContain(PROMPT_ECHO);
    expect(err.message).not.toMatch(/Body:|Raw:/);
    expect(err.logSummary).not.toContain(PROMPT_ECHO);
    expect(err.logSummary).toContain('OpenAI');
    expect(err.logSummary).toContain('400');
    expect(err.logSummary).toMatch(/bad-request/);
  });

  it('never logs a custom provider display name', () => {
    const untrusted = { ...custom, name: 'secret=abc\nFORGED' };
    for (const err of [
      classifyHttpError(fakeRes(400), untrusted),
      describeNetworkError(new Error('ETIMEDOUT'), untrusted),
      missingKeyError(untrusted),
    ]) {
      expect(err.logSummary).not.toContain('secret=abc');
      expect(err.logSummary).not.toContain('FORGED');
      expect(err.logSummary).toContain('Custom provider');
    }
  });

  it('cancels an unread HTTP error body before throwing the classified error', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { status: 400 });

    await expect(throwHttpError(res, builtIn)).rejects.toMatchObject({
      logSummary: 'OpenAI HTTP 400 (bad-request)',
    });
    expect(cancelled).toBe(true);
  });
});

describe('describeNetworkError', () => {
  it('classifies timeout', () => {
    const error = describeNetworkError(new Error('connect ETIMEDOUT'), builtIn);
    expect(error.message).toMatch(/timed out/i);
    expect(classifyError(error).errorCategory).toBe('timeout');
  });

  it('classifies DNS failure', () => {
    const { message } = describeNetworkError(new Error('getaddrinfo ENOTFOUND foo'), builtIn);
    expect(message).toMatch(/Cannot reach/);
  });

  it('classifies AbortError by its structured name, not message wording', () => {
    const { message } = describeNetworkError(new DOMException('stop now', 'AbortError'), builtIn);
    expect(message).toMatch(/cancelled/i);
  });

  it('does not mistake "abort" inside a DNS error message for cancellation', () => {
    const err = describeNetworkError(new Error('getaddrinfo ENOTFOUND abort.example.com'), builtIn);
    expect(err.message).toMatch(/Cannot reach/);
    expect(err.logSummary).toBe('OpenAI request failed (unreachable)');
  });

  it('never echoes the underlying error text into message or summary', () => {
    // The raw error can carry the request URL (with a signed ?token=…) or other
    // internals; it must only CLASSIFY the failure, never be reproduced.
    const err = describeNetworkError(new Error(`fetch failed: ${PROMPT_ECHO}`), builtIn);
    expect(err.message).not.toContain(PROMPT_ECHO);
    expect(err.logSummary).not.toContain(PROMPT_ECHO);
    expect(err.logSummary).toContain('OpenAI');
    expect(err.logSummary).toMatch(/network-error/);
  });

  it('describes an unclassified network failure without doubled error wording', () => {
    const { message } = describeNetworkError(new Error('socket failed'), builtIn);
    expect(message).toBe('OpenAI request failed because of a network error.');
  });
});

describe('readBodyText', () => {
  it('returns the body text on a healthy response', async () => {
    await expect(readBodyText(new Response('{"ok":true}'), builtIn)).resolves.toBe('{"ok":true}');
  });

  // Read the body, expecting it to reject, and hand back the thrown ImageGenError.
  const captureReadError = async (res: Response): Promise<ImageGenError> => {
    try {
      await readBodyText(res, builtIn);
    } catch (error) {
      return error as ImageGenError;
    }
    throw new Error('expected readBodyText to reject');
  };

  it('classifies a body that breaks mid-stream and never echoes its text', async () => {
    // Headers arrived OK but the body read rejects (broken/cancelled stream). The
    // raw rejection can carry internals — it must CLASSIFY, not reproduce. A plain
    // Error here would otherwise be swallowed downstream and misreported as JSON.
    const res = {
      async text() {
        throw new Error(`stream failed: ${PROMPT_ECHO} ECONNRESET`);
      },
    } as unknown as Response;
    const err = await captureReadError(res);
    expect(err).toBeInstanceOf(ImageGenError);
    expect(err.logSummary).toBe('OpenAI request failed (unreachable)');
    expect(err.message).not.toContain(PROMPT_ECHO);
    expect(err.logSummary).not.toContain(PROMPT_ECHO);
  });

  it('classifies a cancelled body read as cancelled', async () => {
    const res = {
      async text() {
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as Response;
    const err = await captureReadError(res);
    expect(err).toBeInstanceOf(ImageGenError);
    expect(err.logSummary).toBe('OpenAI request failed (cancelled)');
    expect(err.message).toMatch(/cancelled/i);
  });
});

describe('redactUrl', () => {
  it('drops the query string (signed token) but keeps scheme/host/path', () => {
    expect(redactUrl('https://cdn.example.com/img/abc.png?X-Amz-Signature=SECRET&token=USER')).toBe(
      'https://cdn.example.com/img/abc.png',
    );
  });

  it('drops userinfo credentials embedded in the authority', () => {
    expect(redactUrl('https://user:pass@host.example/path')).toBe('https://host.example/path');
  });

  it('collapses an unparseable value to <url>', () => {
    expect(redactUrl('not a url at all')).toBe('<url>');
  });
});

// A resolved absolute path + system errno string, and a signed URL — the kinds
// of payload a raw fs/fetch Error carries that must reach NEITHER sink.
const FS_LEAK = "ENOENT: no such file or directory, open '/Users/alice/secret/photo.png'";
const SIGNED_URL_LEAK = 'https://cdn.example.com/img.png?X-Amz-Signature=SECRET&token=USER';

describe('describeDownloadError', () => {
  it('redacts the signed query on an HTTP failure and stays body-free', () => {
    const err = describeDownloadError('generated image', SIGNED_URL_LEAK, { httpStatus: 403 });
    expect(err).toBeInstanceOf(ImageGenError);
    for (const surface of [err.message, err.logSummary]) {
      expect(surface).not.toContain('X-Amz-Signature');
      expect(surface).not.toContain('SECRET');
      expect(surface).not.toContain('token=');
    }
    expect(err.message).toContain('https://cdn.example.com/img.png');
    expect(err.message).toContain('403');
    expect(err.logSummary).toBe('generated image download failed (HTTP 403)');
  });

  it('never reproduces a fetch rejection that embeds the signed URL', () => {
    // The raw rejection reproduces the full URL; the error must classify it, not
    // echo it — neither surface may carry the query credential.
    const err = describeDownloadError('image input', SIGNED_URL_LEAK, {
      rejected: new Error(`request to ${SIGNED_URL_LEAK} failed, reason: ECONNREFUSED`),
    });
    for (const surface of [err.message, err.logSummary]) {
      expect(surface).not.toContain('X-Amz-Signature');
      expect(surface).not.toContain('SECRET');
      expect(surface).not.toContain('token=');
    }
    expect(err.logSummary).toBe('image input download failed (unreachable)');
  });

  it('classifies an aborted download as cancelled', () => {
    const err = describeDownloadError('generated image', SIGNED_URL_LEAK, {
      rejected: new DOMException('stop now', 'AbortError'),
    });
    expect(err.message).toMatch(/cancelled/i);
    expect(err.logSummary).toBe('generated image download failed (cancelled)');
  });
});

describe('toLogSummary', () => {
  it('returns the curated summary for an ImageGenError', () => {
    const err = new ImageGenError(
      'rich message with body: secret',
      'OpenAI HTTP 500 (server-error)',
    );
    expect(toLogSummary(err)).toBe('OpenAI HTTP 500 (server-error)');
  });

  it('keeps a crafted ImageGenError summary on one log line', () => {
    const err = new ImageGenError('safe user message', 'Gateway\nFORGED secret=abc');
    const summary = toLogSummary(err);
    expect(summary).toBe('Gateway');
    expect(summary).not.toContain('\n');
    expect(summary).not.toContain('secret=abc');
  });

  it('never echoes a plain Error message (may carry a path/errno) — fixed label only', () => {
    // Safe-by-default: a non-ImageGenError is untrusted. We emit a constant
    // string and read no bytes off the value (which here embeds a path).
    const summary = toLogSummary(new Error(FS_LEAK));
    expect(summary).toBe('unexpected error');
    expect(summary).not.toContain('/Users/alice');
    expect(summary).not.toContain('ENOENT');
  });

  it('does not trust a writable Error.name — a crafted name cannot leak or inject', () => {
    // `Error.name` is writable, so a caller (or a library) can set it to a
    // secret or a log-injection payload. We never read `name` at all, so anything
    // it holds — a token, a newline — cannot reach the log line.
    const secret = new Error('boom');
    secret.name = 'token=USER_SECRET';
    expect(toLogSummary(secret)).toBe('unexpected error');

    const injected = new Error('boom');
    injected.name = 'Error\n[pi-image-gen] FORGED LOG LINE';
    const summary = toLogSummary(injected);
    expect(summary).toBe('unexpected error');
    expect(summary).not.toContain('USER_SECRET');
    expect(summary).not.toContain('\n');
  });

  it('collapses every Error subclass to the same fixed label (no class name read)', () => {
    // The class name is not surfaced either — even a standard subclass yields the
    // constant string, so the boundary never depends on a readable, spoofable field.
    expect(toLogSummary(new TypeError('x is not a function'))).toBe('unexpected error');
    expect(toLogSummary(new RangeError('out of range'))).toBe('unexpected error');
  });

  it('never echoes a non-Error throw', () => {
    const summary = toLogSummary(SIGNED_URL_LEAK);
    expect(summary).toBe('unexpected non-error throw');
    expect(summary).not.toContain('token=');
  });
});

describe('errorMessageForUser', () => {
  it('surfaces the vetted message for an ImageGenError', () => {
    const err = new ImageGenError('defaultModel is not set. Configure it.', 'defaultModel not set');
    expect(errorMessageForUser(err)).toBe('defaultModel is not set. Configure it.');
  });

  it('never echoes a plain Error message (path/errno) to the user', () => {
    const msg = errorMessageForUser(new Error(FS_LEAK));
    expect(msg).not.toContain('/Users/alice');
    expect(msg).not.toContain('ENOENT');
    expect(msg).toMatch(/failed unexpectedly/i);
    expect(msg).toMatch(/report.*pi-image-gen bug/i);
    expect(msg).not.toMatch(/logs|stderr/i);
  });

  it('never echoes a non-Error throw to the user', () => {
    const msg = errorMessageForUser(SIGNED_URL_LEAK);
    expect(msg).not.toContain('token=');
    expect(msg).toMatch(/failed unexpectedly/i);
  });
});

describe('describeWriteError', () => {
  const fsError = (code: string, message: string): NodeJS.ErrnoException => {
    const e = new Error(message) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };

  it('classifies EACCES/ENOSPC/ENOENT into a path-free, actionable hint', () => {
    const denied = describeWriteError(
      'write the image file',
      fsError('EACCES', "EACCES: permission denied, open '/root/secret/out.png'"),
    );
    expect(denied.message).toMatch(/permission was denied/);
    expect(denied.message).toMatch(/output directory/);
    expect(denied.message).not.toContain('/root/secret');
    expect(denied.logSummary).toBe('write the image file failed (EACCES)');

    expect(
      describeWriteError('create the output directory', fsError('ENOSPC', 'x')).message,
    ).toMatch(/disk is full/);
    expect(
      describeWriteError('create the output directory', fsError('ENOTDIR', 'x')).message,
    ).toMatch(/path is invalid/);
  });

  it('never trusts a bogus .code (only errno-shaped codes reach the summary)', () => {
    // A crafted `.code` must not smuggle bytes into the log summary.
    const bogus = new Error('boom') as NodeJS.ErrnoException;
    bogus.code = 'token=SECRET' as string;
    const err = describeWriteError('write the image file', bogus);
    expect(err.logSummary).toBe('write the image file failed (fs-error)');
    expect(err.logSummary).not.toContain('SECRET');
    expect(err.message).toMatch(/filesystem error/);
  });
});

describe('cancelledError', () => {
  it('is a body-free ImageGenError naming the operation', () => {
    const err = cancelledError('image generation');
    expect(err).toBeInstanceOf(ImageGenError);
    expect(err.message).toBe('image generation was cancelled.');
    expect(err.logSummary).toBe('image generation cancelled');
  });
});

describe('missingKeyError', () => {
  it('names the correct env var per provider — OpenRouter is not told to set OPENAI_API_KEY', () => {
    const openrouter: ResolvedProvider = {
      id: 'openrouter',
      api: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'OpenRouter',
      builtIn: true,
    };
    const err = missingKeyError(openrouter);
    expect(err.message).toMatch(/OPENROUTER_API_KEY/);
    expect(err.message).not.toMatch(/OPENAI_API_KEY/);
    expect(err.logSummary).toBe('OpenRouter missing API key');
  });

  it('names ARK_API_KEY for the built-in ark provider', () => {
    const ark: ResolvedProvider = {
      id: 'ark',
      api: 'ark',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      name: 'Ark',
      builtIn: true,
    };
    expect(missingKeyError(ark).message).toMatch(/ARK_API_KEY/);
  });

  it('points a custom provider at its settings path, not an env var', () => {
    const err = missingKeyError(custom);
    expect(err.message).toMatch(/customProviders\.amaster\.apiKey/);
    expect(err.message).not.toMatch(/_API_KEY/);
  });
});

describe('safe timeout metadata', () => {
  it('keeps a deadline identifiable after sanitizing an image download failure', () => {
    const error = describeDownloadError('image input', 'https://example.com/image?token=secret', {
      rejected: new DOMException('secret', 'TimeoutError'),
    });
    expect(error.message).toContain('timed out');
    expect(classifyError(error).errorCategory).toBe('timeout');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('token=secret');
  });
});
