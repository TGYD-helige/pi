import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpStatusError, networkError, safeBasename, VideoGenError } from '../errors.js';
import { arkAdapter } from '../providers/ark.js';
import { requestFingerprint } from '../providers/request.js';
import { pollTask, sanitizeProviderMessage } from '../providers/task.js';
import type { RemoteTaskStatus, ResolvedProvider } from '../types.js';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

const suiteDir = join(tmpdir(), 'pi-video-gen-providers');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));
beforeEach(() => {
  safeFetchMock.mockReset();
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(join(suiteDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

it('redacts both POSIX and Windows parent directories from path messages', () => {
  expect(safeBasename('/private/project/frame.png')).toBe('frame.png');
  expect(safeBasename(String.raw`C:\Users\alice\secret\frame.png`)).toBe('frame.png');
});

const provider: ResolvedProvider = {
  style: 'ark',
  apiKey: 'test-key',
  baseUrl: 'https://ark.example/api/v3',
};

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('arkAdapter.submit', () => {
  it('builds the task body with roles and structured params', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return jsonResponse(200, { id: 'task-1' });
    });

    const handle = await arkAdapter.submit(
      provider,
      'doubao-seedance-2-0-260128',
      {
        prompt: 'waves',
        firstFramePath: join(suiteDir, 'frame.png'),
        lastFramePath: join(suiteDir, 'frame.png'),
        durationSec: 5,
        aspectRatio: '16:9',
        resolution: '720p',
        generateAudio: true,
      },
      fetchImpl,
    );

    expect(handle.taskId).toBe('task-1');
    expect(seen?.url).toBe('https://ark.example/api/v3/contents/generations/tasks');
    const content = seen?.body.content as { type: string; role?: string }[];
    expect(content[0]).toEqual({ type: 'text', text: 'waves' });
    expect(content[1]?.role).toBe('first_frame');
    expect(content[2]?.role).toBe('last_frame');
    expect(seen?.body.generate_audio).toBe(true);
    expect(seen?.body.resolution).toBe('720p');
    expect(seen?.body.ratio).toBe('16:9');
    expect(seen?.body.duration).toBe(5);
    expect(seen?.body.watermark).toBe(false);
    expect(handle.requestFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('omits optional params when not provided', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { id: 'task-2' });
    });
    await arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl);
    expect(body?.generate_audio).toBeUndefined();
    expect(body?.resolution).toBeUndefined();
    expect((body?.content as unknown[]).length).toBe(1);
  });

  it('maps trusted asset ids to Ark asset URLs in caller order', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { id: 'task-assets' });
    });

    await arkAdapter.submit(
      provider,
      'm',
      {
        prompt: 'Image 1 speaks while Video 1 sets the motion and Audio 1 sets the voice.',
        referenceAssets: [
          { modality: 'image', assetId: 'asset-image-1' },
          { modality: 'video', assetId: 'asset-video-1' },
          { modality: 'audio', assetId: 'asset-audio-1' },
        ],
      },
      fetchImpl,
    );

    expect(body?.content).toEqual([
      {
        type: 'text',
        text: 'Image 1 speaks while Video 1 sets the motion and Audio 1 sets the voice.',
      },
      {
        type: 'image_url',
        image_url: { url: 'asset://asset-image-1' },
        role: 'reference_image',
      },
      {
        type: 'video_url',
        video_url: { url: 'asset://asset-video-1' },
        role: 'reference_video',
      },
      {
        type: 'audio_url',
        audio_url: { url: 'asset://asset-audio-1' },
        role: 'reference_audio',
      },
    ]);
  });

  it('maps Ark portrait privacy rejection codes to safe actionable guidance', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(400, {
        error: {
          code: 'InputImageSensitiveContentDetected.PrivacyInformation',
          message: 'raw provider body must not escape',
        },
      }),
    );
    await expect(arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl)).rejects.toThrow(
      /preset avatar|authorized-person Asset ID/i,
    );
    await expect(arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl)).rejects.not.toThrow(
      /raw provider body/i,
    );
  });

  it('fails fast on 4xx without retrying', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(400, { error: 'bad' }));
    await expect(arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl)).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it('includes trusted asset identity and ordering in the request fingerprint', () => {
    const base = { prompt: 'x' };
    const image = {
      ...base,
      referenceAssets: [{ modality: 'image' as const, assetId: 'asset-1' }],
    };
    const video = {
      ...base,
      referenceAssets: [{ modality: 'video' as const, assetId: 'asset-1' }],
    };
    const reordered = {
      ...base,
      referenceAssets: [
        { modality: 'image' as const, assetId: 'asset-2' },
        { modality: 'image' as const, assetId: 'asset-1' },
      ],
    };
    const original = {
      ...base,
      referenceAssets: [
        { modality: 'image' as const, assetId: 'asset-1' },
        { modality: 'image' as const, assetId: 'asset-2' },
      ],
    };

    expect(requestFingerprint('m', image)).not.toBe(requestFingerprint('m', video));
    expect(requestFingerprint('m', original)).not.toBe(requestFingerprint('m', reordered));
  });

  it('treats 5xx and network errors as ambiguous (no blind retry)', async () => {
    const fetch5xx = mockFetch(() => jsonResponse(500, {}));
    await expect(arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetch5xx)).rejects.toThrow(
      /ambiguous/i,
    );

    const fetchNet = mockFetch(() => {
      throw new Error('socket hangup');
    });
    await expect(arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetchNet)).rejects.toThrow(
      /ambiguous/i,
    );
  });

  it('requires an api key and rejects unsupported image extensions', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { id: 'x' }));
    await expect(
      arkAdapter.submit({ ...provider, apiKey: undefined }, 'm', { prompt: 'x' }, fetchImpl),
    ).rejects.toThrow(/api key/i);
    writeFileSync(join(suiteDir, 'frame.gif'), 'x');
    await expect(
      arkAdapter.submit(
        provider,
        'm',
        { prompt: 'x', firstFramePath: join(suiteDir, 'frame.gif') },
        fetchImpl,
      ),
    ).rejects.toThrow(/png\/jpg\/webp/);
  });

  it('2xx without a task id is AMBIGUOUS (provider may have created it)', async () => {
    const { AmbiguousSubmitError } = await import('../errors.js');
    const fetchImpl = mockFetch(() => jsonResponse(200, {}));
    try {
      await arkAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousSubmitError);
    }
  });
});

describe('arkAdapter.inspect', () => {
  const handle = {
    taskId: 'task-1',
    submittedAt: new Date().toISOString(),
    requestFingerprint: 'fp',
  };

  it('maps provider statuses', async () => {
    const cases: [string, RemoteTaskStatus | 'throws'][] = [
      ['queued', { phase: 'pending' }],
      ['running', { phase: 'running' }],
      ['succeeded', { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' }],
      ['failed', { phase: 'failed', message: 'boom' }],
    ];
    for (const [status, expected] of cases) {
      const fetchImpl = mockFetch(() =>
        jsonResponse(200, {
          status,
          content: { video_url: 'https://cdn.example/v.mp4' },
          error: { message: 'boom' },
        }),
      );
      const result = await arkAdapter.inspect(provider, handle, fetchImpl);
      expect(result).toEqual(expected);
    }
  });

  it('throws on unknown status and succeeded-without-url', async () => {
    const unknown = mockFetch(() => jsonResponse(200, { status: 'mystery' }));
    await expect(arkAdapter.inspect(provider, handle, unknown)).rejects.toThrow(
      /unknown task status/i,
    );

    const noUrl = mockFetch(() => jsonResponse(200, { status: 'succeeded', content: {} }));
    await expect(arkAdapter.inspect(provider, handle, noUrl)).rejects.toThrow(/no video URL/i);
  });

  it('URL-encodes task ids when inspecting', async () => {
    let seenUrl = '';
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return jsonResponse(200, { status: 'running' });
    });
    await arkAdapter.inspect(provider, { ...handle, taskId: 'task/a?b#c' }, fetchImpl);
    expect(seenUrl).toBe('https://ark.example/api/v3/contents/generations/tasks/task%2Fa%3Fb%23c');
  });
});

describe('arkAdapter.downloadTo', () => {
  const handle = { taskId: 'task-1', submittedAt: '', requestFingerprint: 'fp' };

  function mp4Response(): Response {
    const header = Buffer.alloc(16);
    header.write('ftyp', 4, 'ascii');
    return new Response(new Uint8Array(Buffer.concat([header, Buffer.alloc(100)])), {
      status: 200,
    });
  }

  it('streams to disk with magic-byte validation and atomic rename', async () => {
    const dest = join(suiteDir, 'out.mp4');
    const fetchImpl = mockFetch(mp4Response);
    safeFetchMock.mockImplementation(fetchImpl);
    const meta = await arkAdapter.downloadTo(
      provider,
      handle,
      'https://cdn.example/v.mp4',
      dest,
      fetchImpl,
    );
    expect(meta.path).toBe(dest);
    expect(meta.bytes).toBe(116);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(`${dest}.tmp`)).toBe(false);
    expect(readFileSync(dest).subarray(4, 8).toString('ascii')).toBe('ftyp');
  });

  it('blocks a provider-returned loopback URL before download', async () => {
    const dest = join(suiteDir, 'private.mp4');
    const { safeFetch } =
      await vi.importActual<typeof import('@amaster.ai/pi-shared')>('@amaster.ai/pi-shared');
    safeFetchMock.mockImplementation(safeFetch);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      arkAdapter.downloadTo(provider, handle, 'http://127.0.0.1/private.mp4', dest, fetchImpl),
    ).rejects.toThrow(/public HTTP/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the provider baseUrl and media URL hosts as trustedHosts to safeFetch', async () => {
    const dest = join(suiteDir, 'trusted.mp4');
    safeFetchMock.mockImplementation(mockFetch(mp4Response));
    await arkAdapter.downloadTo(
      provider,
      handle,
      'https://cdn.ark.example/v.mp4',
      dest,
      vi.fn<typeof fetch>(),
    );
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://cdn.ark.example/v.mp4',
      expect.anything(),
      expect.objectContaining({ trustedHosts: ['ark.example', 'cdn.ark.example'] }),
    );
  });

  it('refuses a pre-placed destination symlink (and never follows it)', async () => {
    const dir = join(suiteDir, `sym-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const victim = join(dir, 'victim.bin');
    writeFileSync(victim, 'precious');
    const dest = join(dir, 'linked.mp4');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(victim, dest, 'file');
    await expect(
      arkAdapter.downloadTo(
        provider,
        handle,
        'https://cdn.example/v.mp4',
        dest,
        mockFetch(mp4Response),
      ),
    ).rejects.toThrow(/not a regular file/);
    expect(readFileSync(victim, 'utf-8')).toBe('precious');
  });

  it('never follows a pre-placed tmp symlink during download', async () => {
    const dir = join(suiteDir, `tmp-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const victim = join(dir, 'victim.bin');
    writeFileSync(victim, 'precious');
    const dest = join(dir, 'out.mp4');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(victim, `${dest}.tmp-${process.pid}-0`, 'file');

    const fetchImpl = mockFetch(mp4Response);
    safeFetchMock.mockImplementation(fetchImpl);
    const meta = await arkAdapter.downloadTo(
      provider,
      handle,
      'https://cdn.example/v.mp4',
      dest,
      fetchImpl,
    );
    expect(readFileSync(victim, 'utf-8')).toBe('precious'); // untouched
    expect(meta.bytes).toBe(116); // download still succeeded via the next counter
    expect(existsSync(dest)).toBe(true);
  });

  it('rejects non-mp4 payloads and cleans up the temp file', async () => {
    const dest = join(suiteDir, 'bad.mp4');
    const html = mockFetch(() => new Response('<html>error</html>', { status: 200 }));
    safeFetchMock.mockImplementation(html);
    await expect(
      arkAdapter.downloadTo(provider, handle, 'https://cdn.example/v.mp4', dest, html),
    ).rejects.toThrow(/not an mp4/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.tmp`)).toBe(false);
  });
});

describe('pollTask', () => {
  it('returns on success after pending ticks', async () => {
    let calls = 0;
    const statuses: RemoteTaskStatus[] = [
      { phase: 'pending' },
      { phase: 'running' },
      { phase: 'succeeded', videoUrl: 'u' },
    ];
    const result = await pollTask({ check: async () => statuses[calls++]!, intervalMs: 1 });
    expect(result.phase).toBe('succeeded');
  });

  it('throws on provider-side failure (generic LLM message, reason in logSummary only)', async () => {
    const nasty = `fail see https://signed.example/t.mp4?token=secret123 ${'x'.repeat(400)}\nsecond line ignored`;
    try {
      await pollTask({
        check: async () => ({ phase: 'failed', message: nasty }) as RemoteTaskStatus,
        intervalMs: 1,
      });
      expect.unreachable();
    } catch (error) {
      // LLM channel: vetted text only, ZERO provider-controlled content
      const msg = (error as Error).message;
      expect(msg).toContain('failed on the provider side');
      expect(msg).not.toContain('signed.example');
      expect(msg).not.toContain('secret123');
      expect(msg).toContain('job manifest records the (sanitized) provider reason');
      // Manifest-only channel carries the sanitized reason; stderr is fixed.
      const providerMessage = (error as { providerMessage?: string }).providerMessage ?? '';
      expect(providerMessage).toContain('<url>');
      expect(providerMessage).not.toContain('token=secret123');
      expect(providerMessage).not.toContain('\n');
      expect(providerMessage.length).toBeLessThan(220);
    }
    expect(sanitizeProviderMessage('plain error')).toBe('plain error');
  });

  it('keeps provider failure text out of the stderr summary', async () => {
    await expect(
      pollTask({
        check: async () => ({
          phase: 'failed',
          message: 'secret prompt https://signed.example/video?token=abc',
        }),
        intervalMs: 0,
      }),
    ).rejects.toMatchObject({
      logSummary: 'poll: task failed',
      providerMessage: 'secret prompt <url>',
    });
  });

  it('gives up after maxAttempts', async () => {
    await expect(
      pollTask({
        check: async () => ({ phase: 'running' }) as RemoteTaskStatus,
        intervalMs: 1,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/polling budget/);
  });

  it('tolerates sporadic but not consecutive transport errors', async () => {
    let calls = 0;
    const flaky = async (): Promise<RemoteTaskStatus> => {
      calls++;
      if (calls < 3) throw networkError('ark', 'inspect');
      return { phase: 'succeeded', videoUrl: 'u' };
    };
    const result = await pollTask({ check: flaky, intervalMs: 1 });
    expect(result.phase).toBe('succeeded');

    await expect(
      pollTask({
        check: async (): Promise<RemoteTaskStatus> => {
          throw networkError('ark', 'inspect');
        },
        intervalMs: 1,
        maxConsecutiveErrors: 3,
      }),
    ).rejects.toThrow(/Lost contact/);
  });

  it('retries transient inspect HTTP errors', async () => {
    const statuses = [429, 503];
    const result = await pollTask({
      check: async () => {
        const status = statuses.shift();
        if (status) throw httpStatusError('ark', 'inspect', status);
        return { phase: 'succeeded', videoUrl: 'u' };
      },
      intervalMs: 1,
    });
    expect(result.phase).toBe('succeeded');
  });

  it('does not retry deterministic inspect errors', async () => {
    let calls = 0;
    await expect(
      pollTask({
        check: async (): Promise<RemoteTaskStatus> => {
          calls++;
          throw new VideoGenError('Unauthorized.', 'inspect: HTTP 401');
        },
        intervalMs: 1,
      }),
    ).rejects.toThrow(/Unauthorized/);
    expect(calls).toBe(1);
  });

  it('aborts promptly on signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(
      pollTask({
        check: async () => ({ phase: 'running' }) as RemoteTaskStatus,
        signal: ac.signal,
        intervalMs: 50,
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});
