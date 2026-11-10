import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dashscopeAdapter } from '../providers/dashscope.js';
import type { ResolvedProvider } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-dashscope');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

const provider: ResolvedProvider = {
  style: 'dashscope',
  apiKey: 'test-key',
  baseUrl: 'https://dashscope.aliyuncs.com',
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

describe('dashscopeAdapter.submit', () => {
  beforeEach(() => {
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it.each([
    'wan3.0-video',
    'wan3.0-video-prime',
  ])('submits %s with unchanged ID, first/last media and audio control', async (model) => {
    let body: Record<string, any> = {};
    const handle = await dashscopeAdapter.submit(
      provider,
      model,
      {
        prompt: 'waves',
        firstFramePath: join(suiteDir, 'frame.png'),
        lastFramePath: join(suiteDir, 'frame.png'),
        durationSec: 30,
        resolution: '480P',
        aspectRatio: '16:9',
        generateAudio: false,
      },
      mockFetch((_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(200, { output: { task_id: 'wan-1' } });
      }),
    );
    expect(handle.taskId).toBe('wan-1');
    expect(body.model).toBe(model);
    expect(body.input.media.map((m: { type: string }) => m.type)).toEqual([
      'first_frame',
      'last_frame',
    ]);
    expect(body.parameters).toEqual({
      watermark: false,
      duration: 30,
      resolution: '480P',
      ratio: '16:9',
      audio: false,
    });
  });

  it.each([
    false,
    true,
  ])('Wan text/reference mode keeps one model ID (reference=%s)', async (references) => {
    let body: Record<string, any> = {};
    await dashscopeAdapter.submit(
      provider,
      'wan3.0-video',
      {
        prompt: 'waves',
        referenceImagePaths: references ? [join(suiteDir, 'frame.png')] : [],
        generateAudio: true,
      },
      mockFetch((_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(200, { output: { task_id: 'wan-ref' } });
      }),
    );
    expect(body.model).toBe('wan3.0-video');
    expect(body.input.media?.[0]?.type).toBe(references ? 'reference_image' : undefined);
    expect(body.parameters.audio).toBe(true);
  });

  it('rejects invalid Wan frame combinations before submission', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('must not submit');
    });
    await expect(
      dashscopeAdapter.submit(
        provider,
        'wan3.0-video',
        { prompt: 'waves', lastFramePath: 'last.png' },
        fetchImpl,
      ),
    ).rejects.toThrow(/requires a first frame/);
    await expect(
      dashscopeAdapter.submit(
        provider,
        'wan3.0-video',
        { prompt: 'waves', firstFramePath: 'first.png', referenceImagePaths: ['ref.png'] },
        fetchImpl,
      ),
    ).rejects.toThrow(/not both/);
  });

  it('t2v: no media, structured parameters, async header', async () => {
    let seen:
      | { url: string; headers: Record<string, string>; body: Record<string, never> }
      | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = {
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(200, { output: { task_id: 'dt-1', task_status: 'PENDING' } });
    });

    const handle = await dashscopeAdapter.submit(
      provider,
      'happyhorse-1.1',
      { prompt: 'a calm sea', durationSec: 5, aspectRatio: '16:9', resolution: '1080P' },
      fetchImpl,
    );

    expect(handle.taskId).toBe('dt-1');
    expect(seen?.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    );
    expect(seen?.headers['x-dashscope-async']).toBe('enable');
    expect(seen?.body.model).toBe('happyhorse-1.1-t2v');
    const input = (seen?.body.input ?? {}) as { prompt: string; media?: unknown[] };
    expect(input.prompt).toBe('a calm sea');
    expect(input.media).toBeUndefined();
    const parameters = (seen?.body.parameters ?? {}) as Record<string, unknown>;
    expect(parameters.resolution).toBe('1080P');
    expect(parameters.ratio).toBe('16:9');
    expect(parameters.duration).toBe(5);
    expect(parameters.watermark).toBe(false);
  });

  it('i2v: single first_frame media, ratio omitted (follows image)', async () => {
    let body: Record<string, never> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { output: { task_id: 'dt-2' } });
    });

    await dashscopeAdapter.submit(
      provider,
      'happyhorse-1.1',
      { prompt: 'cat runs', firstFramePath: join(suiteDir, 'frame.png'), aspectRatio: '9:16' },
      fetchImpl,
    );

    expect(body?.model).toBe('happyhorse-1.1-i2v');
    const media = ((body?.input ?? {}) as { media: { type: string; url: string }[] }).media;
    expect(media).toHaveLength(1);
    expect(media[0]!.type).toBe('first_frame');
    expect(media[0]!.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(((body?.parameters ?? {}) as Record<string, unknown>).ratio).toBeUndefined();
  });

  it('r2v: reference_image media for each reference, family suffix routing', async () => {
    let body: Record<string, never> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { output: { task_id: 'dt-3' } });
    });

    await dashscopeAdapter.submit(
      provider,
      'happyhorse-1.0-i2v', // stale suffix is re-derived from params
      {
        prompt: 'the woman in [Image 1] walks',
        referenceImagePaths: [join(suiteDir, 'frame.png'), join(suiteDir, 'frame.png')],
      },
      fetchImpl,
    );

    expect(body?.model).toBe('happyhorse-1.0-r2v');
    const media = ((body?.input ?? {}) as { media: { type: string }[] }).media;
    expect(media).toHaveLength(2);
    expect(media.every((m) => m.type === 'reference_image')).toBe(true);
  });

  it('rejects firstFrame+references and lastFrame with clear messages', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { output: { task_id: 'x' } }));
    await expect(
      dashscopeAdapter.submit(
        provider,
        'happyhorse-1.1',
        {
          prompt: 'x',
          firstFramePath: join(suiteDir, 'frame.png'),
          referenceImagePaths: [join(suiteDir, 'frame.png')],
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/either a first frame .* OR reference images/);

    await expect(
      dashscopeAdapter.submit(
        provider,
        'happyhorse-1.1',
        { prompt: 'x', lastFramePath: join(suiteDir, 'frame.png') },
        fetchImpl,
      ),
    ).rejects.toThrow(/does not support last-frame/);
  });

  it('fails fast on 4xx, ambiguous on 5xx/network', async () => {
    const f400 = mockFetch(() => jsonResponse(400, { code: 'InvalidParameter' }));
    await expect(dashscopeAdapter.submit(provider, 'm', { prompt: 'x' }, f400)).rejects.toThrow(
      /HTTP 400/,
    );

    const f500 = mockFetch(() => jsonResponse(500, {}));
    await expect(dashscopeAdapter.submit(provider, 'm', { prompt: 'x' }, f500)).rejects.toThrow(
      /ambiguous/i,
    );

    const fNet = mockFetch(() => {
      throw new Error('reset');
    });
    await expect(dashscopeAdapter.submit(provider, 'm', { prompt: 'x' }, fNet)).rejects.toThrow(
      /ambiguous/i,
    );
  });

  it('treats 2xx without a task id as ambiguous', async () => {
    const { AmbiguousSubmitError } = await import('../errors.js');
    await expect(
      dashscopeAdapter.submit(
        provider,
        'm',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(200, { output: {} })),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
  });
});

describe('dashscopeAdapter.inspect', () => {
  const handle = { taskId: 'dt-1', submittedAt: '', requestFingerprint: 'fp' };

  it('maps task statuses including CANCELED and UNKNOWN', async () => {
    const cases: [string, unknown][] = [
      ['PENDING', { phase: 'pending' }],
      ['RUNNING', { phase: 'running' }],
      ['SUCCEEDED', { phase: 'succeeded', videoUrl: 'https://oss.example/v.mp4' }],
      ['FAILED', { phase: 'failed', message: 'boom' }],
      ['CANCELED', { phase: 'failed', message: 'task was cancelled on the provider' }],
      ['UNKNOWN', { phase: 'failed', message: 'task unknown or expired (task ids live 24h)' }],
    ];
    for (const [status, expected] of cases) {
      const fetchImpl = mockFetch(() =>
        jsonResponse(200, {
          output: { task_status: status, video_url: 'https://oss.example/v.mp4', message: 'boom' },
        }),
      );
      expect(await dashscopeAdapter.inspect(provider, handle, fetchImpl)).toEqual(expected);
    }
  });

  it('URL-encodes task ids', async () => {
    let seenUrl = '';
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return jsonResponse(200, { output: { task_status: 'RUNNING' } });
    });
    await dashscopeAdapter.inspect(provider, { ...handle, taskId: 'dt/a?b#c' }, fetchImpl);
    expect(seenUrl).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/dt%2Fa%3Fb%23c');
  });
});

describe('dashscopeAdapter.cancel', () => {
  it('POSTs the generic task cancel endpoint', async () => {
    let seen: { url: string; method: string } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = { url, method: init?.method ?? 'GET' };
      return jsonResponse(200, {});
    });
    const result = await dashscopeAdapter.cancel!(
      provider,
      { taskId: 'dt-1', submittedAt: '', requestFingerprint: 'fp' },
      fetchImpl,
    );
    expect(result.cancelled).toBe(true);
    expect(seen?.url).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/dt-1/cancel');
    expect(seen?.method).toBe('POST');
  });

  it('URL-encodes task ids in the cancel endpoint', async () => {
    let seenUrl = '';
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return jsonResponse(200, {});
    });
    await dashscopeAdapter.cancel!(
      provider,
      { taskId: 'dt/a?b#c', submittedAt: '', requestFingerprint: 'fp' },
      fetchImpl,
    );
    expect(seenUrl).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/dt%2Fa%3Fb%23c/cancel');
  });
});
