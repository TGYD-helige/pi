import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImage } from '../generate.js';
import { MAX_BASE64_IMAGE_CHARS } from '../image-input.js';
import type { ImageGenSettings } from '../types.js';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082',
  'hex',
);

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('generateImage', () => {
  // Track every temp dir created in this suite and clean them up, per the repo
  // test convention (pi-<pkg>-<suite> prefix + beforeEach/afterEach cleanup).
  const tmpDirs: string[] = [];
  const makeTmpDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-image-gen-generate-'));
    tmpDirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    tmpDirs.length = 0;
    safeFetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });
  it('saves an image returned as base64 to outputDir and returns its path', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return fakeJsonResponse({
        data: [{ b64_json: PNG_BYTES.toString('base64'), revised_prompt: 'a cat, but cuter' }],
      });
    }) as typeof fetch;

    const result = await generateImage(
      { prompt: 'a cat', filename: 'cat-test' },
      {
        cwd,
        settings: { defaultModel: 'gpt-image-2' },
        fetchImpl,
        now: () => new Date(Date.UTC(2026, 5, 4, 12, 0, 0)),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.path).toMatch(/cat-test\.png$/);
    expect(result.images[0]?.revisedPrompt).toBe('a cat, but cuter');
    expect(readFileSync(result.images[0]!.path)).toEqual(PNG_BYTES);
  });

  it('rejects an oversized provider base64 result before materialization', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const oversized = `${PNG_BYTES.toString('base64')}${'A'.repeat(MAX_BASE64_IMAGE_CHARS + 1)}`;
    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({ data: [{ b64_json: oversized }] })) as typeof fetch;

    await expect(
      generateImage(
        { prompt: 'a cat' },
        { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl },
      ),
    ).rejects.toThrow(/size ceiling/i);
  });

  it('downloads url-style results and writes them to disk', async () => {
    const cwd = makeTmpDir();
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        myprov: {
          api: 'openai',
          apiKey: 'k',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return fakeJsonResponse({ data: [{ url: 'https://cdn.test/img.png' }] });
      }
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;
    safeFetchMock.mockImplementation(fetchImpl);

    const result = await generateImage({ prompt: 'house' }, { cwd, settings, fetchImpl });
    expect(result.provider).toBe('myprov (custom)');
    expect(result.images).toHaveLength(1);
    expect(readFileSync(result.images[0]!.path)).toEqual(PNG_BYTES);
  });

  it('trusts the provider and returned media hosts when downloading url-style results', async () => {
    const cwd = makeTmpDir();
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        myprov: {
          api: 'openai',
          apiKey: 'k',
          baseUrl: 'https://gateway.internal.example/v1',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return fakeJsonResponse({
          data: [{ url: 'https://cdn.example/img.png' }],
        });
      }
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;
    safeFetchMock.mockImplementation(fetchImpl);

    await generateImage({ prompt: 'house' }, { cwd, settings, fetchImpl });

    expect(safeFetchMock).toHaveBeenCalledWith('https://cdn.example/img.png', expect.anything(), {
      trustedHosts: ['gateway.internal.example', 'cdn.example'],
    });
  });

  it('does not trust provider-returned IP literal media hosts', async () => {
    const cwd = makeTmpDir();
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        myprov: {
          api: 'openai',
          apiKey: 'k',
          baseUrl: 'https://gateway.internal.example/v1',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({ data: [{ url: 'http://127.0.0.1/private.png' }] })) as typeof fetch;
    safeFetchMock.mockRejectedValue(
      new Error('Outbound URL must use a public HTTP(S) destination.'),
    );

    await expect(generateImage({ prompt: 'house' }, { cwd, settings, fetchImpl })).rejects.toThrow(
      /public HTTP/i,
    );
    expect(safeFetchMock).toHaveBeenCalledWith('http://127.0.0.1/private.png', expect.anything(), {
      trustedHosts: ['gateway.internal.example'],
    });
  });

  it('cancels an unread generated-image HTTP error body', async () => {
    const cwd = makeTmpDir();
    let cancelled = false;
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        myprov: {
          api: 'openai',
          apiKey: 'k',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return fakeJsonResponse({ data: [{ url: 'https://cdn.test/rejected.png' }] });
      }
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 403 },
      );
    }) as typeof fetch;
    safeFetchMock.mockImplementation(fetchImpl);

    await expect(generateImage({ prompt: 'house' }, { cwd, settings, fetchImpl })).rejects.toThrow(
      /403/,
    );
    expect(cancelled).toBe(true);
  });

  it.each([
    'openai',
    'gemini',
    'dashscope',
  ] as const)('cancels an unread %s provider HTTP error body', async (api) => {
    const cwd = makeTmpDir();
    let cancelled = false;
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        provider: {
          api,
          apiKey: 'k',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400 },
      )) as typeof fetch;

    await expect(generateImage({ prompt: 'house' }, { cwd, settings, fetchImpl })).rejects.toThrow(
      /400/,
    );
    expect(cancelled).toBe(true);
  });

  it('raises if defaultModel is not configured', async () => {
    const cwd = makeTmpDir();
    await expect(generateImage({ prompt: 'hi' }, { cwd, settings: {} })).rejects.toThrow(
      /defaultModel is not set/,
    );
  });

  it('raises with a helpful error if no provider can serve the model', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('GEMINI_API_KEY', undefined);
    await expect(
      generateImage(
        { prompt: 'x' },
        { cwd, settings: { defaultModel: 'nano-banana' }, fetchImpl: fetch },
      ),
    ).rejects.toThrow(/Unknown image model|no API key/i);
  });

  it('aborts an in-flight provider request when signal fires', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const fetchImpl: typeof fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        const sig = (init as RequestInit | undefined)?.signal;
        if (!sig) {
          reject(new Error('signal was not propagated to fetch'));
          return;
        }
        sig.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;

    const ctrl = new AbortController();
    const promise = generateImage(
      { prompt: 'x' },
      {
        cwd,
        settings: { defaultModel: 'gpt-image-2' },
        fetchImpl,
        signal: ctrl.signal,
      },
    );
    setTimeout(() => ctrl.abort(), 10);
    await expect(promise).rejects.toThrow(/cancelled|abort/i);
  });

  it('re-checks cancellation before each write, after the provider call (base64 path)', async () => {
    // A base64 result never fetches during materialize, so the write phase's only
    // cancellation point is the per-iteration signal check. Abort via the `now`
    // hook, which fires AFTER the post-provider check but BEFORE the write loop —
    // so the earlier one-shot check passes and only the new in-loop check can stop
    // it. Without that check, both files would be written and the call would
    // resolve successfully.
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const ctrl = new AbortController();

    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({
        data: [
          { b64_json: PNG_BYTES.toString('base64') },
          { b64_json: PNG_BYTES.toString('base64') },
        ],
      })) as typeof fetch;

    await expect(
      generateImage(
        { prompt: 'a cat', filename: 'nope' },
        {
          cwd,
          settings: { defaultModel: 'gpt-image-2' },
          fetchImpl,
          signal: ctrl.signal,
          now: () => {
            ctrl.abort();
            return new Date(Date.UTC(2026, 5, 4, 12, 0, 0));
          },
        },
      ),
    ).rejects.toThrow(/cancelled/i);
    // The output dir may be created, but no image file was written (default
    // outputDir is <cwd>/.pi/images).
    expect(existsSync(join(cwd, '.pi', 'images', 'nope.png'))).toBe(false);
  });

  it('re-checks cancellation after materializing bytes, immediately before writing', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const ctrl = new AbortController();

    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({
        data: [{ b64_json: PNG_BYTES.toString('base64') }],
      })) as typeof fetch;

    await expect(
      generateImage(
        { prompt: 'a cat', filename: 'late-cancel' },
        {
          cwd,
          settings: { defaultModel: 'gpt-image-2' },
          fetchImpl,
          signal: ctrl.signal,
          now: () => {
            // The loop's first signal check has not happened yet. This microtask
            // runs while `await materialize(...)` yields, after that check but
            // before writeUnique starts.
            queueMicrotask(() => ctrl.abort());
            return new Date(Date.UTC(2026, 5, 4, 12, 0, 0));
          },
        },
      ),
    ).rejects.toThrow(/cancelled/i);
    expect(existsSync(join(cwd, '.pi', 'images', 'late-cancel.png'))).toBe(false);
  });

  it('removes earlier files when a later image in the same batch fails', async () => {
    const cwd = makeTmpDir();
    const ctrl = new AbortController();
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        provider: {
          api: 'openai',
          apiKey: 'k',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return fakeJsonResponse({
          data: [
            { b64_json: PNG_BYTES.toString('base64') },
            { url: 'https://cdn.test/cancelled.png' },
          ],
        });
      }
      ctrl.abort();
      throw new DOMException('stop now', 'AbortError');
    }) as typeof fetch;
    safeFetchMock.mockImplementation(fetchImpl);

    await expect(
      generateImage(
        { prompt: 'a cat', filename: 'batch' },
        { cwd, settings, fetchImpl, signal: ctrl.signal },
      ),
    ).rejects.toThrow(/cancelled/i);
    expect(existsSync(join(cwd, '.pi', 'images', 'batch-1.png'))).toBe(false);
  });

  it('preserves the original batch error when cleanup also fails', async () => {
    const cwd = makeTmpDir();
    const firstPath = join(cwd, '.pi', 'images', 'batch-cleanup-1.png');
    const settings: ImageGenSettings = {
      defaultModel: 'x-img',
      customProviders: {
        provider: {
          api: 'openai',
          apiKey: 'k',
          models: ['x-img'],
        },
      },
    };
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return fakeJsonResponse({
          data: [
            { b64_json: PNG_BYTES.toString('base64') },
            { url: 'https://cdn.test/generated.png' },
          ],
        });
      }
      rmSync(firstPath);
      mkdirSync(firstPath);
      throw new Error('download failed token=secret');
    }) as typeof fetch;
    safeFetchMock.mockImplementation(fetchImpl);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        generateImage({ prompt: 'a cat', filename: 'batch-cleanup' }, { cwd, settings, fetchImpl }),
      ).rejects.toMatchObject({
        logSummary: 'generated image download failed (network-error)',
      });
      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('[pi-image-gen] cleanup failed:');
      expect(logged).not.toContain(firstPath);
      expect(logged).not.toContain('token=secret');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('propagates cancellation into an in-flight image file write', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const ctrl = new AbortController();
    const largeBytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
    PNG_BYTES.copy(largeBytes);
    const largeImage = largeBytes.toString('base64');

    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({
        data: [{ b64_json: largeImage }],
      })) as typeof fetch;

    const promise = generateImage(
      { prompt: 'a cat', filename: 'in-flight-cancel' },
      {
        cwd,
        settings: { defaultModel: 'gpt-image-2' },
        fetchImpl,
        signal: ctrl.signal,
        now: () => {
          // Runs after the synchronous pre-write checks, while writeFile is
          // waiting in the filesystem thread pool.
          setImmediate(() => ctrl.abort());
          return new Date(Date.UTC(2026, 5, 4, 12, 0, 0));
        },
      },
    );

    await expect(promise).rejects.toThrow(/cancelled/i);
    expect(existsSync(join(cwd, '.pi', 'images', 'in-flight-cancel.png'))).toBe(false);
  });

  it('forwards `quality` to the OpenAI generations body', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (_input, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return fakeJsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] });
    }) as typeof fetch;

    await generateImage(
      { prompt: 'a cat', quality: 'high' },
      { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl },
    );
    expect(calls[0]?.body.quality).toBe('high');
  });

  it('omits `quality` from the body when not provided', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (_input, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return fakeJsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] });
    }) as typeof fetch;

    await generateImage(
      { prompt: 'a cat' },
      { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl },
    );
    expect(calls[0]?.body).not.toHaveProperty('quality');
  });

  it('does not overwrite an existing file — writes a -v2 sibling instead', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] })) as typeof fetch;

    const opts = { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl } as const;
    const first = await generateImage({ prompt: 'a cat', filename: 'hero' }, opts);
    const second = await generateImage({ prompt: 'a cat', filename: 'hero' }, opts);

    expect(first.images[0]?.path).toMatch(/hero\.png$/);
    expect(second.images[0]?.path).toMatch(/hero-v2\.png$/);
    expect(second.images[0]?.path).not.toBe(first.images[0]?.path);
    // The first file is still intact.
    expect(readFileSync(first.images[0]!.path)).toEqual(PNG_BYTES);
  });

  it('removes its newly created file when writing it fails', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const probePath = join(cwd, 'probe');
    const probe = await open(probePath, 'w');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      writeFile(data: string | Uint8Array, options?: unknown): Promise<void>;
    };
    await probe.close();
    rmSync(probePath);

    const error = new Error('simulated write failure') as NodeJS.ErrnoException;
    error.code = 'EIO';
    const writeSpy = vi.spyOn(fileHandlePrototype, 'writeFile').mockRejectedValue(error);
    const fetchImpl: typeof fetch = (async () =>
      fakeJsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] })) as typeof fetch;

    try {
      await expect(
        generateImage(
          { prompt: 'a cat', filename: 'write-failure' },
          { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl },
        ),
      ).rejects.toThrow(/filesystem error/i);
    } finally {
      writeSpy.mockRestore();
    }
    expect(existsSync(join(cwd, '.pi', 'images', 'write-failure.png'))).toBe(false);
  });

  it('gives every concurrent same-filename call a distinct path (atomic O_EXCL write)', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    // Distinct bytes per call so we can prove nothing was clobbered: the i-th
    // image is a PNG whose trailing byte encodes i. If two calls resolved to the
    // same path, one payload would overwrite the other and the read-back set
    // would be missing a value.
    const bodyFor = (i: number) => {
      const bytes = Buffer.concat([PNG_BYTES, Buffer.from([i])]);
      return { data: [{ b64_json: bytes.toString('base64') }] };
    };
    let call = 0;
    const fetchImpl: typeof fetch = (async () => {
      const i = call++;
      return fakeJsonResponse(bodyFor(i));
    }) as typeof fetch;

    const N = 50;
    const opts = { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl } as const;
    const results = await Promise.all(
      Array.from({ length: N }, () => generateImage({ prompt: 'a cat', filename: 'hero' }, opts)),
    );

    const paths = results.map((r) => r.images[0]!.path);
    // Every call must have claimed a unique path — the whole point of the fix.
    expect(new Set(paths).size).toBe(N);
    // And every file must survive on disk (nothing overwrote a sibling).
    const trailingBytes = new Set(paths.map((p) => readFileSync(p).at(-1)));
    expect(trailingBytes.size).toBe(N);
  });

  it('routes to OpenAI /images/edits when an image input is supplied', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const calls: Array<{ url: string; method: string; isFormData: boolean }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({
        url,
        method: (init as RequestInit | undefined)?.method ?? 'GET',
        isFormData: (init as RequestInit | undefined)?.body instanceof FormData,
      });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const refPath = join(cwd, 'ref.png');
    writeFileSync(refPath, PNG_BYTES);
    const result = await generateImage(
      { prompt: 'make it green', image: [refPath], filename: 'edit-test' },
      {
        cwd,
        settings: { defaultModel: 'gpt-image-2' },
        fetchImpl,
        now: () => new Date(Date.UTC(2026, 5, 5, 0, 0, 0)),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/edits');
    expect(calls[0]?.isFormData).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  it('accepts a data: URI returned in the `url` field of an OpenAI response', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const dataUri = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ data: [{ url: dataUri }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await generateImage(
      { prompt: 'cat' },
      { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl },
    );
    expect(result.images).toHaveLength(1);
    expect(readFileSync(result.images[0]!.path)).toEqual(PNG_BYTES);
  });

  it('skips entries that have neither b64_json nor a usable url', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { url: '' },
            { b64_json: PNG_BYTES.toString('base64') },
            { url: 'https://cdn.test/real.png' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    // We don't follow real.png in this test — provide a fake fetch that returns a body for it.
    const wrappedFetch: typeof fetch = (async (input, init) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u === 'https://cdn.test/real.png') {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    safeFetchMock.mockImplementation(wrappedFetch);

    const result = await generateImage(
      { prompt: 'x' },
      { cwd, settings: { defaultModel: 'gpt-image-2' }, fetchImpl: wrappedFetch },
    );
    expect(result.images).toHaveLength(2);
  });

  it('routes OpenRouter to POST /api/v1/images (not /images/generations)', async () => {
    const cwd = makeTmpDir();
    const settings: ImageGenSettings = {
      defaultModel: 'google/gemini-3.1-flash-image',
      customProviders: {
        or: {
          api: 'openrouter',
          apiKey: 'or-test',
          models: ['google/gemini-3.1-flash-image'],
        },
      },
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return fakeJsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] });
    }) as typeof fetch;

    const result = await generateImage({ prompt: 'a cat' }, { cwd, settings, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/images');
    expect(calls[0]?.body.model).toBe('google/gemini-3.1-flash-image');
    expect(result.images).toHaveLength(1);
  });

  it('OpenRouter image-to-image sends input_references in JSON body', async () => {
    const cwd = makeTmpDir();
    const settings: ImageGenSettings = {
      defaultModel: 'google/gemini-3.1-flash-image',
      customProviders: {
        or: {
          api: 'openrouter',
          apiKey: 'or-test',
          models: ['google/gemini-3.1-flash-image'],
        },
      },
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return fakeJsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] });
    }) as typeof fetch;

    const refPath = join(cwd, 'ref.png');
    writeFileSync(refPath, PNG_BYTES);
    await generateImage({ prompt: 'make blue', image: [refPath] }, { cwd, settings, fetchImpl });

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/images');
    const refs = calls[0]?.body.input_references as Array<{
      image_url: { url: string };
    }>;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('passes out-of-documented-range size and n through to the provider (advisory, not gated)', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('DASHSCOPE_API_KEY', 'ds-test');
    const settings: ImageGenSettings = { defaultModel: 'qwen-image-3.0' };

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, body: JSON.parse(String((init as RequestInit)?.body ?? '{}')) });
      return fakeJsonResponse({
        output: { choices: [{ message: { content: [{ image: 'https://cdn.test/out.png' }] } }] },
      });
    }) as typeof fetch;
    // The url-style result is downloaded through safeFetch — serve the bytes.
    safeFetchMock.mockImplementation(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    // 256*256 is below the documented 512*512 floor and n=42 exceeds the
    // documented 1–6 — a private deployment may allow both; the provider's
    // own error is the backstop, so the call must reach the wire unchanged.
    await generateImage({ prompt: 'p', size: '256*256', n: 42 }, { cwd, settings, fetchImpl });

    expect(calls).toHaveLength(1);
    const parameters = calls[0]?.body.parameters as Record<string, unknown>;
    expect(parameters.size).toBe('256*256');
    expect(parameters.n).toBe(42);
  });

  it('rejects a pixel size on gemini-style models before any provider call', async () => {
    const cwd = makeTmpDir();
    vi.stubEnv('GEMINI_API_KEY', 'gem-test');
    const settings: ImageGenSettings = { defaultModel: 'nano-banana-pro' };
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      generateImage({ prompt: 'p', size: '1024x1024' }, { cwd, settings, fetchImpl }),
    ).rejects.toThrow(/no pixel-size knob/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
