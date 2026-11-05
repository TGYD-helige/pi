import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError } from '@amaster.ai/pi-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmbiguousSubmitError, RemoteTaskNotFoundError, VideoGenError } from '../errors.js';
import { minimaxAdapter } from '../providers/minimax.js';
import type { ResolvedProvider } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-minimax');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

const provider: ResolvedProvider = {
  style: 'minimax',
  apiKey: 'test-key',
  baseUrl: 'https://api.minimax.io',
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

describe('minimaxAdapter.submit (v2)', () => {
  it('retains timeout classification while preserving paid-submit uncertainty', async () => {
    const result = await minimaxAdapter
      .submit(
        provider,
        'MiniMax-H3',
        { prompt: 'sea' },
        mockFetch(() => Promise.reject(new DOMException('secret-token', 'TimeoutError'))),
      )
      .catch((error) => error);
    expect(result).toBeInstanceOf(AmbiguousSubmitError);
    expect(classifyError(result).errorCategory).toBe('timeout');
    expect(result.message).toContain('MAY have created a paid task');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  beforeEach(() => {
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('t2v: content text item, concrete ratio, Bearer apiKey', async () => {
    let seen:
      | { url: string; headers: Record<string, string>; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = {
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(200, { task_id: 'mm-1' });
    });

    const handle = await minimaxAdapter.submit(
      provider,
      'MiniMax-H3',
      { prompt: 'a calm sea', durationSec: 8, aspectRatio: '16:9', resolution: '2K' },
      fetchImpl,
    );

    expect(handle.taskId).toBe('mm-1');
    expect(seen?.url).toBe('https://api.minimax.io/v2/video_generation');
    expect(seen?.headers.authorization).toBe('Bearer test-key');
    expect(seen?.body.model).toBe('MiniMax-H3');
    expect(seen?.body.content).toEqual([{ type: 'text', text: 'a calm sea' }]);
    expect(seen?.body.resolution).toBe('2K');
    expect(seen?.body.duration).toBe(8);
    expect(seen?.body.ratio).toBe('16:9');
    expect(seen?.body.aigc_watermark).toBe(false);
  });

  it('i2v: first_frame role with a data URI, ratio omitted (server forces adaptive)', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { task_id: 'mm-2' });
    });

    await minimaxAdapter.submit(
      provider,
      'MiniMax-H3',
      {
        prompt: 'cat runs',
        firstFramePath: join(suiteDir, 'frame.png'),
        aspectRatio: '9:16',
        durationSec: 5,
        resolution: '768P',
      },
      fetchImpl,
    );

    expect(body?.ratio).toBeUndefined();
    const content = body?.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: 'text', text: 'cat runs' });
    expect(content[1]?.type).toBe('image_url');
    expect(content[1]?.role).toBe('first_frame');
    expect(String((content[1]?.image_url as { url: string }).url)).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it('flf: last_frame role pairs with first_frame', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { task_id: 'mm-3' });
    });

    await minimaxAdapter.submit(
      provider,
      'MiniMax-H3',
      {
        prompt: 'cat runs',
        firstFramePath: join(suiteDir, 'frame.png'),
        lastFramePath: join(suiteDir, 'frame.png'),
      },
      fetchImpl,
    );

    const roles = (body?.content as Record<string, unknown>[]).map((item) => item.role);
    expect(roles).toEqual([undefined, 'first_frame', 'last_frame']);
  });

  it('reference images: reference_image roles, ratio sent when provided', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { task_id: 'mm-4' });
    });

    await minimaxAdapter.submit(
      provider,
      'MiniMax-H3',
      {
        prompt: 'the character dances',
        referenceImagePaths: [join(suiteDir, 'frame.png'), join(suiteDir, 'frame.png')],
        aspectRatio: '1:1',
      },
      fetchImpl,
    );

    expect(body?.ratio).toBe('1:1');
    const roles = (body?.content as Record<string, unknown>[]).map((item) => item.role);
    expect(roles).toEqual([undefined, 'reference_image', 'reference_image']);
  });

  it('rejects a last frame without a first frame', async () => {
    await expect(
      minimaxAdapter.submit(
        provider,
        'MiniMax-H3',
        { prompt: 'x', lastFramePath: join(suiteDir, 'frame.png') },
        mockFetch(() => jsonResponse(200, { task_id: 'mm-5' })),
      ),
    ).rejects.toThrow(/requires a first frame/);
  });

  it('rejects mixing first frame with reference images', async () => {
    await expect(
      minimaxAdapter.submit(
        provider,
        'MiniMax-H3',
        {
          prompt: 'x',
          firstFramePath: join(suiteDir, 'frame.png'),
          referenceImagePaths: [join(suiteDir, 'frame.png')],
        },
        mockFetch(() => jsonResponse(200, { task_id: 'mm-6' })),
      ),
    ).rejects.toThrow(/not both/);
  });

  it('fails clearly without an api key', async () => {
    await expect(
      minimaxAdapter.submit(
        { ...provider, apiKey: undefined },
        'MiniMax-H3',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(200, { task_id: 'mm-7' })),
      ),
    ).rejects.toThrow(/No API key configured for MiniMax/);
  });

  it('network failure on submit is ambiguous (no idempotency lookup exists)', async () => {
    await expect(
      minimaxAdapter.submit(
        provider,
        'MiniMax-H3',
        { prompt: 'x' },
        mockFetch(() => Promise.reject(new Error('socket hangup'))),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
  });

  it('5xx on submit is ambiguous; 4xx is a plain http error', async () => {
    await expect(
      minimaxAdapter.submit(
        provider,
        'MiniMax-H3',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(500, { type: 'error' })),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
    await expect(
      minimaxAdapter.submit(
        provider,
        'MiniMax-H3',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(400, { type: 'error' })),
      ),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('2xx without a task id is ambiguous, not a clean failure', async () => {
    await expect(
      minimaxAdapter.submit(
        provider,
        'MiniMax-H3',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(200, {})),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
  });
});

describe('minimaxAdapter.inspect (v2)', () => {
  const handle = {
    taskId: 'mm-1',
    submittedAt: '2026-08-06T00:00:00.000Z',
    requestFingerprint: 'fp',
  };

  function inspectWith(body: unknown, status = 200) {
    return minimaxAdapter.inspect(
      provider,
      handle,
      mockFetch((url) => {
        expect(url).toBe('https://api.minimax.io/v2/query/video_generation/mm-1');
        return jsonResponse(status, body);
      }),
    );
  }

  it('maps queued → pending and running → running', async () => {
    await expect(inspectWith({ task: { id: 'mm-1', status: 'queued' } })).resolves.toEqual({
      phase: 'pending',
    });
    await expect(inspectWith({ task: { id: 'mm-1', status: 'running' } })).resolves.toEqual({
      phase: 'running',
    });
  });

  it('maps succeeded → video url from task.content.url', async () => {
    await expect(
      inspectWith({
        task: { id: 'mm-1', status: 'succeeded', content: { url: 'https://cdn.example/v.mp4' } },
      }),
    ).resolves.toEqual({ phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' });
  });

  it('succeeded without a url throws', async () => {
    await expect(inspectWith({ task: { id: 'mm-1', status: 'succeeded' } })).rejects.toThrow(
      /no video URL/,
    );
  });

  it('maps failed → provider message, cancelled → failed', async () => {
    await expect(
      inspectWith({
        task: { id: 'mm-1', status: 'failed', error: { code: '1026', message: 'sensitive' } },
      }),
    ).resolves.toEqual({ phase: 'failed', message: 'sensitive' });
    await expect(inspectWith({ task: { id: 'mm-1', status: 'cancelled' } })).resolves.toEqual({
      phase: 'failed',
      message: 'task was cancelled on the provider',
    });
  });

  it('unknown status and malformed payloads throw', async () => {
    await expect(inspectWith({ task: { id: 'mm-1', status: 'mystery' } })).rejects.toThrow(
      /unknown task status/,
    );
    await expect(inspectWith({})).rejects.toThrow(/malformed task payload/);
  });

  it('404 on inspect means the remote task is gone', async () => {
    await expect(inspectWith({ type: 'error' }, 404)).rejects.toBeInstanceOf(
      RemoteTaskNotFoundError,
    );
  });

  it('network failure is retryable', async () => {
    await expect(
      minimaxAdapter.inspect(
        provider,
        handle,
        mockFetch(() => Promise.reject(new Error('dns'))),
      ),
    ).rejects.toThrow(/network error/);
  });

  it('non-VideoGenError surprises stay off the user channel', async () => {
    try {
      await inspectWith({ task: { id: 'mm-1', status: 'mystery' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VideoGenError);
    }
  });
});
