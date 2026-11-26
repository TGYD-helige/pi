import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { klingAdapter } from '../providers/kling.js';
import type { ResolvedProvider } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-kling');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

const provider: ResolvedProvider = {
  style: 'kling',
  apiKey: 'test-key',
  baseUrl: 'https://api-singapore.klingai.com',
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

describe('klingAdapter.submit (API 2.0)', () => {
  beforeEach(() => {
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('t2v: model in path, plain prompt field, settings+options, Bearer apiKey', async () => {
    let seen:
      | { url: string; headers: Record<string, string>; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = {
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(200, { code: 0, data: { id: 'kt-1' } });
    });

    const handle = await klingAdapter.submit(
      provider,
      'kling-3.0',
      {
        prompt: 'a calm sea',
        durationSec: 8,
        aspectRatio: '16:9',
        resolution: '4k',
        generateAudio: true,
      },
      fetchImpl,
    );

    expect(handle.taskId).toBe('kt-1');
    expect(handle.meta?.taskType).toBe('text-to-video');
    expect(seen?.url).toBe('https://api-singapore.klingai.com/text-to-video/kling-3.0');
    expect(seen?.headers.authorization).toBe('Bearer test-key');
    expect(seen?.body.prompt).toBe('a calm sea');
    const settings = (seen?.body.settings ?? {}) as Record<string, unknown>;
    expect(settings.duration).toBe(8);
    expect(settings.resolution).toBe('4k');
    expect(settings.aspect_ratio).toBe('16:9');
    expect(settings.audio).toBe('native');
    const options = (seen?.body.options ?? {}) as Record<string, unknown>;
    expect(options.external_task_id).toBe(handle.requestFingerprint);
    expect((options.watermark_info as Record<string, unknown>).enabled).toBe(false);
  });

  it('uses the stable request id to keep identical jobs distinct', async () => {
    const externalIds: string[] = [];
    const fetchImpl = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        options: { external_task_id: string };
      };
      externalIds.push(body.options.external_task_id);
      return jsonResponse(200, { code: 0, data: { id: `kt-${externalIds.length}` } });
    });
    await klingAdapter.submit(
      provider,
      'kling-3.0-turbo',
      { prompt: 'same prompt', requestId: 'job-a:s1' },
      fetchImpl,
    );
    await klingAdapter.submit(
      provider,
      'kling-3.0-turbo',
      { prompt: 'same prompt', requestId: 'job-b:s1' },
      fetchImpl,
    );
    expect(externalIds[0]).not.toBe(externalIds[1]);
  });

  it.each([
    'kling-3.0',
    'kling-4.0',
  ])('sends both frame roles with the correct %s shape', async (model) => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe(`${provider.baseUrl}/image-to-video/${model}`);
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, { code: 0, data: { id: 'kt-2' } });
    });

    const handle = await klingAdapter.submit(
      provider,
      model,
      {
        prompt: 'cat runs',
        firstFramePath: join(suiteDir, 'frame.png'),
        lastFramePath: join(suiteDir, 'frame.png'),
        aspectRatio: '9:16',
      },
      fetchImpl,
    );

    expect(handle.meta?.taskType).toBe('image-to-video');
    const contents = (body?.contents ?? []) as { type: string; url?: string; id?: string }[];
    expect(contents[0]).toEqual({ type: 'prompt', text: 'cat runs' });
    expect(contents[1]!.type).toBe('first_frame');
    expect(contents[1]!.url!.startsWith('data:image/png;base64,')).toBe(true);
    expect(contents[2]!.type).toBe('last_frame');
    expect(contents[1]?.id).toBe(model === 'kling-4.0' ? 'first_frame' : undefined);
    expect(contents[2]?.id).toBe(model === 'kling-4.0' ? 'last_frame' : undefined);
    const settings = (body?.settings ?? {}) as Record<string, unknown>;
    expect(settings.aspect_ratio).toBeUndefined(); // follows the frame
  });

  it('adopts an existing task after ambiguous failure via external_task_id lookup', async () => {
    let calls = 0;
    const fetchImpl = mockFetch((url) => {
      calls++;
      if (calls === 1) throw new Error('socket hangup'); // submit dies ambiguously
      // recovery lookup: task WAS created
      expect(url).toContain('/tasks?external_task_ids=');
      return jsonResponse(200, { code: 0, data: [{ id: 'kt-recovered', status: 'processing' }] });
    });

    const handle = await klingAdapter.submit(
      provider,
      'kling-3.0-turbo',
      { prompt: 'waves' },
      fetchImpl,
    );
    expect(handle.taskId).toBe('kt-recovered');
    expect(handle.meta?.taskType).toBe('text-to-video');
  });

  it('recovery after abort uses a FRESH signal and returns the created task', async () => {
    const ac = new AbortController();
    ac.abort(); // user cancelled mid-submit
    const signals: (AbortSignal | null | undefined)[] = [];
    let calls = 0;
    const fetchImpl = mockFetch((url, init) => {
      calls++;
      signals.push(init?.signal);
      if (calls === 1) throw new Error('aborted');
      expect(url).toContain('/tasks?external_task_ids=');
      return jsonResponse(200, { code: 0, data: [{ id: 'kt-recovered', status: 'processing' }] });
    });

    const handle = await klingAdapter.submit(
      provider,
      'kling-3.0-turbo',
      { prompt: 'waves' },
      fetchImpl,
      ac.signal,
    );
    expect(handle.taskId).toBe('kt-recovered');
    // the recovery lookup must NOT reuse the aborted signal
    expect(signals[1]?.aborted).not.toBe(true);
  });

  it('abort + no task found ⇒ CancelledError (not misleading billing guidance)', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls++;
      if (calls === 1) throw new Error('aborted');
      return jsonResponse(200, { code: 0, data: [] });
    });
    await expect(
      klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, fetchImpl, ac.signal),
    ).rejects.toThrow(/cancelled/i);
  });

  it('5xx + lookup CONFIRMS no task ⇒ confident safe-to-retry message', async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls++;
      if (calls === 1) return jsonResponse(500, {});
      return jsonResponse(200, { code: 0, data: [] });
    });
    await expect(
      klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, fetchImpl),
    ).rejects.toThrow(/confirmed NO task was created.*Safe to retry/);
  });

  it('abort + lookup FAILS ⇒ warns a paid task MAY exist (not a bare cancel)', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = mockFetch(() => {
      throw new Error('network dead'); // submit AND lookup both fail
    });
    await expect(
      klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, fetchImpl, ac.signal),
    ).rejects.toThrow(/A paid task MAY exist/);
  });

  it('res.json() failure mid-submit still recovers via external id', async () => {
    let calls = 0;
    const fetchImpl = mockFetch((url) => {
      calls++;
      if (calls === 1) return jsonResponse(200, null); // invalid JSON after OK headers
      expect(url).toContain('/tasks?external_task_ids=');
      return jsonResponse(200, { code: 0, data: [{ id: 'kt-body', status: 'submitted' }] });
    });
    const handle = await klingAdapter.submit(
      provider,
      'kling-3.0-turbo',
      { prompt: 'x' },
      fetchImpl,
    );
    expect(handle.taskId).toBe('kt-body');
  });

  it('idempotency lookup enforces its deadline (default 10s, tested at 30ms)', async () => {
    const { tryRecoverByExternalId } = await import('../providers/kling.js');
    const hanging = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await tryRecoverByExternalId(provider, 'fp', 'text-to-video', hanging, 30);
    expect(result.outcome).toBe('unknown');
  });

  it('recovery treats error envelopes and non-array data as UNKNOWN, never not-found', async () => {
    // {code: 50001, message: "busy"} — provider error must NOT read as "confirmed no task"
    let calls = 0;
    const busy = mockFetch(() => {
      calls++;
      if (calls === 1) return jsonResponse(500, {});
      return jsonResponse(200, { code: 50001, message: 'busy' });
    });
    await expect(
      klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, busy),
    ).rejects.toThrow(/lookup could not complete|MAY exist/);

    // {code: 0, data: {}} — data not a task list ⇒ also unknown
    calls = 0;
    const badShape = mockFetch(() => {
      calls++;
      if (calls === 1) return jsonResponse(500, {});
      return jsonResponse(200, { code: 0, data: {} });
    });
    await expect(
      klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, badShape),
    ).rejects.toThrow(/lookup could not complete|MAY exist/);

    // {code: 0, data: []} — the ONLY shape allowed to mean "confirmed not created"
    calls = 0;
    const clean = mockFetch(() => {
      calls++;
      if (calls === 1) return jsonResponse(500, {});
      return jsonResponse(200, { code: 0, data: [] });
    });
    await expect(
      klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, clean),
    ).rejects.toThrow(/confirmed NO task was created.*Safe to retry/);
  });

  it('aborted + recovery unknown throws AmbiguousSubmitError (shot gets parked, not resubmitted)', async () => {
    const { AmbiguousSubmitError } = await import('../errors.js');
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = mockFetch(() => {
      throw new Error('network dead');
    });
    try {
      await klingAdapter.submit(provider, 'kling-3.0-turbo', { prompt: 'x' }, fetchImpl, ac.signal);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousSubmitError);
    }
  });

  it('treats 2xx without a task id as ambiguous', async () => {
    const { AmbiguousSubmitError } = await import('../errors.js');
    await expect(
      klingAdapter.submit(
        provider,
        'kling-3.0-turbo',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(200, { code: 0, data: {} })),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
  });

  it('fails fast on 4xx and rejects missing apiKey', async () => {
    const f400 = mockFetch(() => jsonResponse(400, {}));
    await expect(klingAdapter.submit(provider, 'kling-3.0', { prompt: 'x' }, f400)).rejects.toThrow(
      /HTTP 400/,
    );
    await expect(
      klingAdapter.submit(
        { style: 'kling', baseUrl: provider.baseUrl },
        'm',
        { prompt: 'x' },
        f400,
      ),
    ).rejects.toThrow(/api key/i);
  });

  it('rejects envelope errors (code != 0)', async () => {
    const badCode = mockFetch(() => jsonResponse(200, { code: 40001, message: 'bad model' }));
    await expect(klingAdapter.submit(provider, 'nope', { prompt: 'x' }, badCode)).rejects.toThrow(
      /code 40001/,
    );
  });
});

describe('klingAdapter.inspect (API 2.0)', () => {
  const handle = {
    taskId: 'kt-9',
    submittedAt: '',
    requestFingerprint: 'fp',
    meta: { taskType: 'text-to-video' },
  };

  it('queries /tasks?task_ids= and maps statuses', async () => {
    const cases: [string, unknown][] = [
      ['submitted', { phase: 'pending' }],
      ['processing', { phase: 'running' }],
      ['succeeded', { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' }],
      ['failed', { phase: 'failed', message: 'boom' }],
    ];
    for (const [status, expected] of cases) {
      let seenUrl = '';
      const fetchImpl = mockFetch((url) => {
        seenUrl = url;
        return jsonResponse(200, {
          code: 0,
          data: [
            {
              id: 'kt-9',
              status,
              message: 'boom',
              outputs: [{ type: 'video', url: 'https://cdn.example/v.mp4' }],
            },
          ],
        });
      });
      expect(await klingAdapter.inspect(provider, handle, fetchImpl)).toEqual(expected);
      expect(seenUrl).toBe('https://api-singapore.klingai.com/tasks?task_ids=kt-9');
    }
  });

  it('throws when the task id is absent from the result list', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(200, { code: 0, data: [{ id: 'other', status: 'submitted' }] }),
    );
    await expect(klingAdapter.inspect(provider, handle, fetchImpl)).rejects.toThrow(/not found/);
  });
});
