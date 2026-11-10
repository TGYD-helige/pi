import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openrouterAdapter } from '../providers/openrouter.js';
import type { ResolvedProvider } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-openrouter');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

const provider: ResolvedProvider = {
  style: 'openrouter',
  apiKey: 'test-key',
  baseUrl: 'https://openrouter.ai/api/v1',
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

describe('openrouterAdapter.submit', () => {
  beforeEach(() => {
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it.each([
    'google/veo-3.1',
    'google/veo-3.1-fast',
    'google/veo-3.1-lite',
  ])('rejects unsupported discrete durations for %s before a paid submit', async (model) => {
    let called = false;
    await expect(
      openrouterAdapter.submit(
        provider,
        model,
        { prompt: 'waves', durationSec: 5 },
        mockFetch(() => {
          called = true;
          return jsonResponse(202, { id: 'unexpected' });
        }),
      ),
    ).rejects.toThrow(/4, 6, or 8/);
    expect(called).toBe(false);
  });

  it.each([
    'google/veo-3.1-fast',
    'google/veo-3.1-lite',
    'google/gemini-omni-1.1-flash',
    'google/gemini-omni-1.2-flash',
  ])('submits %s through the shared video endpoint', async (model) => {
    let body: Record<string, unknown> = {};
    const handle = await openrouterAdapter.submit(
      provider,
      model,
      {
        prompt: 'waves',
        durationSec: 8,
        resolution: '1080p',
        aspectRatio: '9:16',
        generateAudio: true,
      },
      mockFetch((_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(202, { id: 'new-video' });
      }),
    );
    expect(handle.taskId).toBe('new-video');
    expect(body).toEqual({
      model,
      prompt: 'waves',
      duration: 8,
      resolution: '1080p',
      aspect_ratio: '9:16',
      generate_audio: true,
    });
  });

  it('builds the body with frame_images + input_references and reads id', async () => {
    let seen:
      | { url: string; headers: Record<string, string>; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = {
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(202, { id: 'job-1', generation_id: 'gen-1', status: 'pending' });
    });

    const handle = await openrouterAdapter.submit(
      provider,
      'google/veo-3.1',
      {
        prompt: 'waves',
        firstFramePath: join(suiteDir, 'frame.png'),
        lastFramePath: join(suiteDir, 'frame.png'),
        referenceImagePaths: [join(suiteDir, 'frame.png')],
        durationSec: 8,
        aspectRatio: '16:9',
        resolution: '720p',
        generateAudio: true,
      },
      fetchImpl,
    );

    expect(handle.taskId).toBe('job-1');
    expect(seen?.url).toBe('https://openrouter.ai/api/v1/videos');
    expect(seen?.headers.authorization).toBe('Bearer test-key');
    expect(seen?.body.model).toBe('google/veo-3.1');
    expect(seen?.body.duration).toBe(8);
    expect(seen?.body.resolution).toBe('720p');
    expect(seen?.body.aspect_ratio).toBe('16:9');
    expect(seen?.body.generate_audio).toBe(true);
    const frames = (seen?.body.frame_images ?? []) as { frame_type: string }[];
    expect(frames.map((f) => f.frame_type)).toEqual(['first_frame', 'last_frame']);
    const refs = (seen?.body.input_references ?? []) as { type: string }[];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.type).toBe('image_url');
  });

  it('fails fast on 4xx, ambiguous on 5xx/network, missing key', async () => {
    const f400 = mockFetch(() => jsonResponse(400, {}));
    await expect(openrouterAdapter.submit(provider, 'm', { prompt: 'x' }, f400)).rejects.toThrow(
      /HTTP 400/,
    );
    const f500 = mockFetch(() => jsonResponse(500, {}));
    await expect(openrouterAdapter.submit(provider, 'm', { prompt: 'x' }, f500)).rejects.toThrow(
      /ambiguous/i,
    );
    const fNet = mockFetch(() => {
      throw new Error('reset');
    });
    await expect(openrouterAdapter.submit(provider, 'm', { prompt: 'x' }, fNet)).rejects.toThrow(
      /ambiguous/i,
    );
    await expect(
      openrouterAdapter.submit(
        { style: 'openrouter', baseUrl: provider.baseUrl },
        'm',
        { prompt: 'x' },
        f400,
      ),
    ).rejects.toThrow(/api key/i);
  });

  it('treats 2xx without a task id as ambiguous', async () => {
    const { AmbiguousSubmitError } = await import('../errors.js');
    await expect(
      openrouterAdapter.submit(
        provider,
        'm',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(200, {})),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
  });
});

describe('openrouterAdapter.inspect', () => {
  const handle = { taskId: 'job-1', submittedAt: '', requestFingerprint: 'fp' };

  it('maps the full status enum and reads unsigned_urls', async () => {
    const cases: [string, unknown][] = [
      ['pending', { phase: 'pending' }],
      ['in_progress', { phase: 'running' }],
      ['completed', { phase: 'succeeded', videoUrl: 'https://storage.example/v.mp4' }],
      ['failed', { phase: 'failed', message: 'boom' }],
      ['cancelled', { phase: 'failed', message: 'boom' }],
      ['expired', { phase: 'failed', message: 'boom' }],
    ];
    for (const [status, expected] of cases) {
      let seenUrl = '';
      const fetchImpl = mockFetch((url) => {
        seenUrl = url;
        return jsonResponse(200, {
          status,
          unsigned_urls: ['https://storage.example/v.mp4'],
          error: 'boom',
        });
      });
      expect(await openrouterAdapter.inspect(provider, handle, fetchImpl)).toEqual(expected);
      expect(seenUrl).toBe('https://openrouter.ai/api/v1/videos/job-1');
    }
  });

  it('throws on completed-without-url and unknown status', async () => {
    const noUrl = mockFetch(() => jsonResponse(200, { status: 'completed', unsigned_urls: [] }));
    await expect(openrouterAdapter.inspect(provider, handle, noUrl)).rejects.toThrow(
      /no video URL/i,
    );
    const weird = mockFetch(() => jsonResponse(200, { status: 'mystery' }));
    await expect(openrouterAdapter.inspect(provider, handle, weird)).rejects.toThrow(
      /unknown task status/i,
    );
  });
});
