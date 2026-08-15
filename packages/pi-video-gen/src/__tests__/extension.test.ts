import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import piVideoGenExtension from '../index.js';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

const suiteDir = join(tmpdir(), 'pi-video-gen-extension');

type ToolDef = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  promptGuidelines?: string[];
  execute: (...args: unknown[]) => Promise<{
    isError?: true;
    content: { type: string; text: string }[];
    details?: Record<string, unknown>;
  }>;
};

const tools = new Map<string, ToolDef>();
const commands = new Map<
  string,
  { handler: (args: string | undefined, ctx: unknown) => Promise<unknown> }
>();
const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();

const mockPi = {
  on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
    handlers.set(event, handler),
  ),
  registerTool: vi.fn((t: ToolDef) => tools.set(t.name, t)),
  registerCommand: vi.fn(
    (
      name: string,
      opts: { handler: (args: string | undefined, ctx: unknown) => Promise<unknown> },
    ) => commands.set(name, opts),
  ),
  appendEntry: vi.fn(),
};

function fakeCtx(cwd: string, trusted = false) {
  return {
    cwd,
    isProjectTrusted: () => trusted,
    getAllTools: () => [],
    getActiveTools: () => [] as string[],
    ui: { notify: vi.fn() },
  };
}

function notifiedText(ctx: ReturnType<typeof fakeCtx>): string {
  return ctx.ui.notify.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

/** Valid text-only generate params (style+scene are required without a frame). */
const VALID_GENERATE_PARAMS = {
  style: 'cinematic',
  prompt: { scene: 'open sea', visuals: 'static wide shot', action: 'waves rolling' },
};

async function startSession(cwd: string, trusted = false) {
  await handlers.get('session_start')?.(undefined, fakeCtx(cwd, trusted));
}

describe('pi-video-gen extension', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    tools.clear();
    commands.clear();
    handlers.clear();
    mockPi.appendEntry.mockClear();
    safeFetchMock.mockReset().mockImplementation((input, init) => globalThis.fetch(input, init));
    cwd = join(suiteDir, `proj-${Math.random().toString(36).slice(2, 8)}`);
    home = join(suiteDir, `home-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('PI_AGENT_HOME', join(home, '.pi', 'agent'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(home, '.pi', 'agent'));
    piVideoGenExtension(mockPi as never);
    await startSession(cwd);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('registers tools, command, and lifecycle handlers', () => {
    expect(tools.has('video_generate')).toBe(true);
    expect(tools.has('video_render')).toBe(true);
    expect(tools.has('video_compose')).toBe(true);
    expect(tools.has('video_capabilities')).toBe(true);
    expect(commands.has('video-gen')).toBe(true);
    expect(handlers.has('session_start')).toBe(true);
  });

  it('exposes lastFrame in the schema for Seedance 2.0 (supportsFirstLastFrame)', () => {
    const params = tools.get('video_generate')!.parameters;
    const props = params.properties ?? {};
    expect(Object.keys(props)).toContain('lastFrame');
    expect(Object.keys(props)).toContain('prompt');
    expect(Object.keys(props)).toContain('jobId');
    expect(Object.keys(props)).toContain('style');
    expect(Object.keys(props)).toContain('characters');
    // prompt is optional at the schema level so a resume call may pass only jobId;
    // fresh-submit validation enforces it inside execute().
    expect(params.required ?? []).not.toContain('prompt');
    const promptProps =
      (props.prompt as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    expect(Object.keys(promptProps)).toEqual(
      expect.arrayContaining([
        'scene',
        'visuals',
        'action',
        'effects',
        'audio',
        'visibleCharacters',
      ]),
    );
  });

  it('keeps compose identity entirely in the immutable spec path', () => {
    const params = tools.get('video_compose')!.parameters.properties ?? {};
    expect(Object.keys(params)).toEqual(['composeSpecPath']);
  });

  it('guides timeline compose to reuse existing media before generating missing sources', () => {
    const guidance = tools.get('video_compose')!.promptGuidelines?.join('\n') ?? '';
    expect(guidance).toMatch(/reuse existing images\/screenshots\/clips first/i);
    expect(guidance).toMatch(/generate only missing visuals/i);
    expect(guidance).toMatch(/exactly one image or video/i);
    expect(guidance).toMatch(/subtitles\.mode "burn"/i);
    expect(guidance).not.toMatch(/generate images first/i);
  });

  it('video_capabilities lists the registry and active model', async () => {
    const result = await tools.get('video_capabilities')!.execute();
    const text = result.content[0]!.text;
    expect(text).toContain('doubao-seedance-2-0-260128');
    expect(text).toContain('Native audio: yes');
    expect(result.isError).toBeUndefined();
  });

  it('bounds video_capabilities output for a large custom registry', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        'pi-video-gen': {
          customProviders: {
            bulk: {
              api: 'ark',
              apiKey: 'k',
              models: Array.from({ length: 6_000 }, (_, i) => `custom-model-${i}`),
            },
          },
        },
      }),
    );
    await startSession(cwd);
    const result = await tools.get('video_capabilities')!.execute();
    expect(Buffer.byteLength(result.content[0]!.text, 'utf-8')).toBeLessThan(50 * 1024);
  });

  it('video_generate fails with key guidance when no api key is configured', async () => {
    const result = await tools
      .get('video_generate')!
      .execute('call-1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/api key/i);
  });

  it('video_generate parks an ambiguous submit and refuses to submit it again', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    let submits = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          submits++;
          return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error('unexpected request');
      }),
    );
    try {
      const first = await tools
        .get('video_generate')!
        .execute('c1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
      expect(first.isError).toBe(true);
      const jobId = String(first.details?.jobId);
      expect(jobId).toMatch(/^gen-/);
      const manifest = JSON.parse(
        readFileSync(join(cwd, '.video-gen', 'single', jobId, 'manifest.json'), 'utf-8'),
      );
      expect(manifest.state).toBe('ambiguous');
      const input = JSON.parse(
        readFileSync(join(cwd, '.video-gen', 'single', jobId, 'input.json'), 'utf-8'),
      );
      expect(input.requestId).toBe(jobId);

      const resumed = await tools
        .get('video_generate')!
        .execute('c2', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
      expect(resumed.isError).toBe(true);
      expect(resumed.content[0]!.text).toMatch(/ambiguous|MAY exist/i);
      expect(submits).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('video_generate rejects out-of-range duration before any network call', async () => {
    // give it a key so validation reaches the duration check
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    const result = await tools
      .get('video_generate')!
      .execute(
        'call-1',
        { ...VALID_GENERATE_PARAMS, durationSec: 99 },
        undefined,
        undefined,
        fakeCtx(cwd),
      );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/durationSec must be 4-15s/);
  });

  it('/video-gen doctor reports key/ffmpeg/image_generate/trust status', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('doctor', ctx);
    const text = notifiedText(ctx);
    expect(text).toContain('model: doubao-seedance-2-0-260128');
    expect(text).toMatch(/api key missing/i);
    expect(text).toMatch(/ffmpeg/);
    expect(text).toMatch(/libx264/);
    expect(text).toMatch(/image_generate/);
    expect(text).toMatch(/CJK font/);
    expect(text).toMatch(/not trusted/);
  });

  it('/video-gen generate rejects freeform text and points at flag usage', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('generate a cat in the rain', ctx);
    expect(notifiedText(ctx)).toMatch(/Unrecognized text/);
    expect(notifiedText(ctx)).toMatch(/--visuals/);
  });

  it('/video-gen generate rejects unknown flags and non-integer durations', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('generate --visuals "v" --action "a" --bogus x', ctx);
    expect(notifiedText(ctx)).toMatch(/Unknown flag\(s\): --bogus/);

    const ctx2 = fakeCtx(cwd);
    await commands
      .get('video-gen')!
      .handler('generate --visuals "v" --action "a" --duration 4.5', ctx2);
    expect(notifiedText(ctx2)).toMatch(/--duration must be an integer/);
  });

  it('/video-gen generate surfaces structured-prompt validation errors', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('generate --action "waves rolling"', ctx);
    expect(notifiedText(ctx)).toMatch(/visuals is required/);

    const ctx2 = fakeCtx(cwd);
    await commands
      .get('video-gen')!
      .handler('generate --visuals "static wide shot" --action "waves rolling"', ctx2);
    expect(notifiedText(ctx2)).toMatch(/style.*required for text-to-video/);
  });

  it('/video-gen generate assembles the flags into the submitted prompt', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST') {
          submitted = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
        }
        if (u.includes('/contents/generations/tasks/')) {
          return new Response(
            JSON.stringify({
              status: 'succeeded',
              content: { video_url: 'https://93.184.216.34/v.mp4' },
            }),
            { status: 200 },
          );
        }
        const header = Buffer.alloc(16);
        header.write('ftyp', 4, 'ascii');
        return new Response(new Uint8Array(header), { status: 200 });
      }),
    );
    try {
      const ctx = fakeCtx(cwd);
      // escaped quotes inside --audio: dialogue lines carry them by convention
      await commands
        .get('video-gen')!
        .handler(
          'generate --style "cinematic" --scene "open sea" --visuals "static wide shot" --action "waves rolling" --audio "[Speaker] Alice (soft): \\"We\'re here.\\"" --negative "no text" --duration 5',
          ctx,
        );
      expect(notifiedText(ctx)).toMatch(/Video clip ready/);
      const content = (submitted!.content as { type: string; text: string }[])[0]!;
      expect(content.text).toBe(
        '[Style] cinematic\n[Scene] open sea\n[Visuals] static wide shot\n[Action] waves rolling\n[Audio] [Speaker] Alice (soft): "We\'re here."\nNegative: no text',
      );
      expect(submitted!.duration).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('/video-gen doctor reports the active custom provider and its key', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        'pi-video-gen': {
          defaultModel: 'custom-kling',
          customProviders: {
            proxy: { api: 'kling', apiKey: 'k', models: ['custom-kling'] },
          },
        },
      }),
    );
    await startSession(cwd);

    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('doctor', ctx);
    const text = notifiedText(ctx);
    expect(text).toContain('model: custom-kling [kling]');
    expect(text).toContain('Kling API key configured');
    expect(text).not.toContain('ark api key');
  });

  it('video_generate points a missing custom key at the custom provider entry', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        'pi-video-gen': {
          defaultModel: 'custom-kling',
          customProviders: {
            proxy: { api: 'kling', models: ['custom-kling'] },
          },
        },
      }),
    );
    await startSession(cwd);

    const result = await tools
      .get('video_generate')!
      .execute('call-1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('pi-video-gen.customProviders.proxy.apiKey');
    expect(result.content[0]!.text).not.toContain('pi-video-gen.providers.kling.apiKey');
  });

  it('video_generate maps firstFrame→firstFramePath and applies model defaults', async () => {
    // ark key via global settings
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    const framePath = join(cwd, 'frame.png');
    writeFileSync(framePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const seen: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/contents/generations/tasks') && init?.method === 'POST') {
          seen.push({ url: u, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
        }
        if (u.includes('/contents/generations/tasks/')) {
          return new Response(
            JSON.stringify({
              status: 'succeeded',
              content: { video_url: 'https://93.184.216.34/v.mp4' },
            }),
            { status: 200 },
          );
        }
        const header = Buffer.alloc(16);
        header.write('ftyp', 4, 'ascii');
        return new Response(new Uint8Array(header), { status: 200 });
      }),
    );
    try {
      const result = await tools.get('video_generate')!.execute(
        'c1',
        {
          prompt: { visuals: 'static wide shot', action: 'waves rolling' },
          firstFrame: framePath,
        },
        undefined,
        undefined,
        fakeCtx(cwd),
      );
      expect(result.isError).toBeUndefined();
      const submit = seen[0]!.body!;
      const content = submit.content as { type: string; role?: string }[];
      expect(content[1]?.role).toBe('first_frame'); // firstFrame was NOT dropped
      expect(submit.resolution).toBe('1080p'); // model default applied
      expect(submit.ratio).toBe('16:9');
      expect(submit.duration).toBe(5);
      expect(submit.generate_audio).toBe(true); // seedance nativeAudio
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('video_generate resolves relative frame paths against the session cwd', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    // frame lives at <ctx.cwd>/frame.png; passed as a RELATIVE path
    writeFileSync(
      join(cwd, 'frame.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST') {
          submitted = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
        }
        if (u.includes('/contents/generations/tasks/')) {
          return new Response(
            JSON.stringify({
              status: 'succeeded',
              content: { video_url: 'https://93.184.216.34/v.mp4' },
            }),
            { status: 200 },
          );
        }
        const header = Buffer.alloc(16);
        header.write('ftyp', 4, 'ascii');
        return new Response(new Uint8Array(header), { status: 200 });
      }),
    );
    try {
      const result = await tools.get('video_generate')!.execute(
        'c1',
        {
          prompt: { visuals: 'static wide shot', action: 'waves rolling' },
          firstFrame: 'frame.png',
        },
        undefined,
        undefined,
        fakeCtx(cwd),
      );
      expect(result.isError).toBeUndefined(); // would fail with unreadable image if not resolved
      expect((submitted!.content as { role?: string }[])[1]?.role).toBe('first_frame');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resume refuses when the frozen task identity no longer matches settings', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    // a job created under a DIFFERENT model/endpoint
    const jobId = 'gen-old-job';
    const jobDir = join(cwd, '.video-gen', 'single', jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId,
        kind: 'single',
        state: 'submitted',
        handle: { taskId: 't-1', submittedAt: 'x', requestFingerprint: 'fp' },
        requestFingerprint: 'fp',
        modelId: 'doubao-seedance-1-0-old',
        providerStyle: 'ark',
        providerBaseUrl: 'https://alice:old-secret@old-endpoint.example/v3?token=old-query',
        updatedAt: 'x',
      }),
    );

    const result = await tools
      .get('video_generate')!
      .execute('c1', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Restore the previous settings/);
    expect(result.content[0]!.text).toContain('https://old-endpoint.example/v3');
    expect(result.content[0]!.text).not.toContain('old-secret');
    expect(result.content[0]!.text).not.toContain('old-query');
  });

  it('resume refuses a legacy manifest without task identity (fail-closed)', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    const jobId = 'gen-legacy';
    const jobDir = join(cwd, '.video-gen', 'single', jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId,
        kind: 'single',
        state: 'submitted',
        handle: { taskId: 't-1', submittedAt: 'x', requestFingerprint: 'fp' },
        requestFingerprint: 'fp',
        updatedAt: 'x',
      }),
    );

    const result = await tools
      .get('video_generate')!
      .execute('c1', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/before task-identity freezing/);
  });

  it('resume accepts a call carrying only jobId (no prompt)', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    // No manifest on disk — reaching the "no resumable job" error proves the
    // prompt-less call passed structured-prompt validation into the resume path.
    const result = await tools
      .get('video_generate')!
      .execute('c1', { jobId: 'gen-nonexistent' }, undefined, undefined, fakeCtx(cwd));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No resumable job found/);
  });

  it('single-job resume refuses a job symlink that escapes the output directory', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    const jobId = 'gen-linked';
    const outside = join(cwd, 'outside-single');
    mkdirSync(outside, { recursive: true });
    const original = {
      jobId,
      kind: 'single',
      state: 'submitted',
      handle: { taskId: 't-1', submittedAt: 'x', requestFingerprint: 'fp' },
      requestFingerprint: 'fp',
      modelId: 'doubao-seedance-2-0-260128',
      providerStyle: 'ark',
      providerBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      updatedAt: 'x',
    };
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify(original));
    mkdirSync(join(cwd, '.video-gen', 'single'), { recursive: true });
    symlinkSync(outside, join(cwd, '.video-gen', 'single', jobId), 'dir');

    const ac = new AbortController();
    ac.abort();
    const result = await tools
      .get('video_generate')!
      .execute('c1', { ...VALID_GENERATE_PARAMS, jobId }, ac.signal, undefined, fakeCtx(cwd));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/outside|refus/i);
    expect(JSON.parse(readFileSync(join(outside, 'manifest.json'), 'utf-8'))).toEqual(original);
  });

  it('video_render success records last-job via appendEntry', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    // prepare a job with one frame + a REAL mp4 for the concat step
    const frame = join(cwd, 'f.png');
    writeFileSync(frame, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { createRequire } = await import('node:module');
    const { execFileSync } = await import('node:child_process');
    const ffmpegBin = createRequire(import.meta.url)('ffmpeg-static') as string;
    const realClip = join(cwd, 'real.mp4');
    execFileSync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:size=64x64',
      '-t',
      '1',
      realClip,
    ]);
    const realBytes = (await import('node:fs')).readFileSync(realClip);
    const jobDir = join(cwd, '.video-gen', 'job-app');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'render-input.json'),
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
        }
        if (u.includes('/contents/generations/tasks/')) {
          return new Response(
            JSON.stringify({
              status: 'succeeded',
              content: { video_url: 'https://93.184.216.34/v.mp4' },
            }),
            { status: 200 },
          );
        }
        return new Response(new Uint8Array(realBytes), { status: 200 });
      }),
    );
    try {
      const result = await tools
        .get('video_render')!
        .execute(
          'c1',
          { renderSpecPath: join(jobDir, 'render-input.json') },
          undefined,
          undefined,
          fakeCtx(cwd),
        );
      expect(result.isError).toBeUndefined();
      const calls = mockPi.appendEntry.mock.calls.filter(
        (c: unknown[]) => c[0] === 'video-gen:last-job',
      );
      expect(calls.length).toBe(1);
      expect(calls[0]![1]).toMatchObject({ jobId: 'job-app', kind: 'render' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('/video-gen doctor reports ffmpeg by source, not internal absolute paths', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('doctor', ctx);
    const text = notifiedText(ctx);
    expect(text).toMatch(/ffmpeg found \(source: (bundled|path|env)\)|ffmpeg not runnable/);
    expect(text).not.toContain('/node_modules/');
  });

  it('does not expose a configured ffmpeg path in tool errors', async () => {
    const privatePath = join(home, 'private', 'ffmpeg');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        'pi-video-gen': {
          ffmpegPath: privatePath,
          providers: { ark: { apiKey: 'k' } },
        },
      }),
    );
    await startSession(cwd);

    const result = await tools
      .get('video_render')!
      .execute(
        'c1',
        { renderSpecPath: join(cwd, '.video-gen', 'missing', 'render-input.json') },
        undefined,
        undefined,
        fakeCtx(cwd),
      );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('source: settings');
    expect(result.content[0]!.text).not.toContain(privatePath);
  });

  it('/video-gen models includes the active model capability table', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('models', ctx);
    const text = notifiedText(ctx);
    expect(text).toContain('Durations:');
    expect(text).toContain('Resolutions:');
    expect(text).toContain('Native audio:');
    expect(text).toContain('First+last frame:');
  });

  it('/video-gen doctor never follows a pre-placed output probe symlink', async () => {
    const outputDir = join(cwd, '.video-gen');
    const victim = join(cwd, 'victim.txt');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(victim, 'precious');
    symlinkSync(victim, join(outputDir, '.doctor-probe'), 'file');

    await commands.get('video-gen')!.handler('doctor', fakeCtx(cwd));

    expect(readFileSync(victim, 'utf-8')).toBe('precious');
  });

  it('video_generate rejects fractional durations', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    const result = await tools
      .get('video_generate')!
      .execute(
        'c1',
        { ...VALID_GENERATE_PARAMS, durationSec: 4.5 },
        undefined,
        undefined,
        fakeCtx(cwd),
      );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/whole number of seconds|integer number/);
  });

  it('single jobs freeze frame bytes: submit uses the snapshot, tamper refuses resume', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    const frame = join(cwd, 'frame.png');
    const frameBytes = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('frame-bytes-v1'),
    ]);
    writeFileSync(frame, frameBytes);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
        }
        if (u.includes('/contents/generations/tasks/')) {
          return new Response(
            JSON.stringify({
              status: 'succeeded',
              content: { video_url: 'https://93.184.216.34/v.mp4' },
            }),
            { status: 200 },
          );
        }
        const header = Buffer.alloc(16);
        header.write('ftyp', 4, 'ascii');
        return new Response(new Uint8Array(header), { status: 200 });
      }),
    );
    try {
      const result = await tools
        .get('video_generate')!
        .execute(
          'c1',
          { prompt: { visuals: 'static wide shot', action: 'waves rolling' }, firstFrame: frame },
          undefined,
          undefined,
          fakeCtx(cwd),
        );
      expect(result.isError).toBeUndefined();

      // find the job dir created under .video-gen/single/
      const singleRoot = join(cwd, '.video-gen', 'single');
      const [jobId] = (await import('node:fs')).readdirSync(singleRoot);
      expect(jobId).toBeDefined();
      // snapshot exists inside the job and the SUBMIT used it, not the source
      const snap = join(singleRoot, jobId!, 'assets', 'first_frame.png');
      expect(readFileSync(snap)).toEqual(frameBytes);
      expect(
        JSON.parse(readFileSync(join(singleRoot, jobId!, 'input.json'), 'utf-8')).firstFramePath,
      ).toBe(realpathSync(snap));
      // manifest recorded the frozen hash
      const manifest = JSON.parse(readFileSync(join(singleRoot, jobId!, 'manifest.json'), 'utf-8'));
      expect(Object.keys(manifest.frameHashes ?? {})).toHaveLength(1);

      // put the job back into in-flight state (done would short-circuit as cached)
      const m2 = JSON.parse(readFileSync(join(singleRoot, jobId!, 'manifest.json'), 'utf-8'));
      m2.state = 'submitted';
      delete m2.videoPath;
      writeFileSync(join(singleRoot, jobId!, 'manifest.json'), JSON.stringify(m2));
      const { rmSync } = await import('node:fs');
      rmSync(join(singleRoot, jobId!, 'video.mp4'));
      // tamper with the snapshot → resume with jobId refuses
      writeFileSync(snap, 'tampered');
      const resume = await tools
        .get('video_generate')!
        .execute('c2', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
      expect(resume.isError).toBe(true);
      expect(resume.content[0]!.text).toMatch(/no longer trustworthy/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('single-job resume rejects a changed input snapshot before polling', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    const interrupted = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          interrupted.abort();
          return Response.json({ id: 'task-frozen-input' });
        }
        throw new Error('unexpected fetch');
      }),
    );
    const first = await tools
      .get('video_generate')!
      .execute('c1', VALID_GENERATE_PARAMS, interrupted.signal, undefined, fakeCtx(cwd));
    const jobId = String(first.details?.jobId);
    const inputPath = join(cwd, '.video-gen', 'single', jobId, 'input.json');
    const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
    writeFileSync(inputPath, JSON.stringify({ ...input, prompt: 'tampered prompt' }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/tasks/')
          ? Response.json({
              status: 'succeeded',
              content: { video_url: 'https://93.184.216.34/video.mp4' },
            })
          : new Response(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])),
      ),
    );
    try {
      const resumed = await tools
        .get('video_generate')!
        .execute('c2', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));

      expect(resumed.isError).toBe(true);
      expect(resumed.content[0]!.text).toMatch(/frozen input|request identity/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resume on a done single job returns the cached clip without any network call', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);

    const jobId = 'gen-done-job';
    const jobDir = join(cwd, '.video-gen', 'single', jobId);
    mkdirSync(jobDir, { recursive: true });
    const videoPath = join(jobDir, 'video.mp4');
    writeFileSync(videoPath, 'mp4-bytes');
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId,
        kind: 'single',
        state: 'done',
        handle: { taskId: 't-1', submittedAt: 'x', requestFingerprint: 'fp' },
        requestFingerprint: 'fp',
        videoPath,
        modelId: 'doubao-seedance-2-0-260128',
        providerStyle: 'ark',
        providerBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        updatedAt: 'x',
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network must not be touched');
      }),
    );
    try {
      const result = await tools
        .get('video_generate')!
        .execute('c1', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('already rendered');
    } finally {
      vi.unstubAllGlobals();
    }

    // failed job refuses
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId,
        kind: 'single',
        state: 'failed',
        handle: { taskId: 't-1', submittedAt: 'x', requestFingerprint: 'fp' },
        requestFingerprint: 'fp',
        modelId: 'doubao-seedance-2-0-260128',
        providerStyle: 'ark',
        providerBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        updatedAt: 'x',
      }),
    );
    const failed = await tools
      .get('video_generate')!
      .execute('c2', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toMatch(/failed permanently/);
  });

  it('keeps a downloaded-task handle resumable after a transient download failure', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    let downloads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Response.json({ id: 'task-resume' });
        if (url.includes('/tasks/')) {
          return Response.json({
            status: 'succeeded',
            content: { video_url: 'https://93.184.216.34/video.mp4' },
          });
        }
        downloads++;
        if (downloads === 1) return new Response('', { status: 503 });
        return new Response(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
          status: 200,
        });
      }),
    );
    try {
      const first = await tools
        .get('video_generate')!
        .execute('c1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
      expect(first.isError).toBe(true);
      const jobId = String(first.details?.jobId);
      const manifestPath = join(cwd, '.video-gen', 'single', jobId, 'manifest.json');
      expect(JSON.parse(readFileSync(manifestPath, 'utf-8'))).toMatchObject({
        state: 'polling_stopped',
        handle: { taskId: 'task-resume' },
      });

      const resumed = await tools
        .get('video_generate')!
        .execute('c2', { ...VALID_GENERATE_PARAMS, jobId }, undefined, undefined, fakeCtx(cwd));
      expect(resumed.isError).toBeUndefined();
      expect(resumed.content[0]!.text).toContain('Video clip ready');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('parks a single task as ambiguous when inspect returns 404', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({ id: 'task-not-indexed' })
          : new Response('', { status: 404 }),
      ),
    );
    try {
      const result = await tools
        .get('video_generate')!
        .execute('c1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
      const jobId = String(result.details?.jobId);
      const manifest = JSON.parse(
        readFileSync(join(cwd, '.video-gen', 'single', jobId, 'manifest.json'), 'utf-8'),
      );

      expect(result.isError).toBe(true);
      expect(manifest).toMatchObject({
        state: 'ambiguous',
        handle: { taskId: 'task-not-indexed' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds external task metadata in tool details', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    const hugeTaskId = 't'.repeat(10_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Response.json({ id: hugeTaskId });
        if (url.includes('/tasks/')) {
          return Response.json({
            status: 'succeeded',
            content: { video_url: 'https://93.184.216.34/video.mp4' },
          });
        }
        return new Response(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
          status: 200,
        });
      }),
    );
    try {
      const result = await tools
        .get('video_generate')!
        .execute('c1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
      expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(2 * 1024);
      expect(result.details).toEqual({ truncated: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses provider cancellation for a cancelled single-clip task', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        'pi-video-gen': {
          defaultModel: 'happyhorse-1.1',
          providers: { dashscope: { apiKey: 'k' } },
        },
      }),
    );
    await startSession(cwd);
    let cancelSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('video-synthesis')) return Response.json({ output: { task_id: 'd-1' } });
        if (url.endsWith('/cancel')) {
          cancelSignal = init?.signal;
          return new Response('', { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await tools
        .get('video_generate')!
        .execute('c1', VALID_GENERATE_PARAMS, controller.signal, undefined, fakeCtx(cwd));
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('was cancelled');
      expect(cancelSignal?.aborted).toBe(false);
      const manifest = JSON.parse(
        readFileSync(
          join(cwd, '.video-gen', 'single', String(result.details?.jobId), 'manifest.json'),
          'utf-8',
        ),
      );
      expect(manifest.state).toBe('failed');
      expect(manifest.handle).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stores a sanitized provider reason without writing it to stderr or the tool result', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    const providerReason = 'rejected secret-prompt https://signed.example/v?token=abc';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({ id: 'failed-task' })
          : Response.json({ status: 'failed', error: { message: providerReason } }),
      ),
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await tools
        .get('video_generate')!
        .execute('c1', VALID_GENERATE_PARAMS, undefined, undefined, fakeCtx(cwd));
      const surface = `${result.content[0]!.text}\n${stderr.mock.calls.flat().join('\n')}`;
      expect(surface).not.toContain('secret-prompt');
      expect(surface).not.toContain('token=abc');
      const manifest = JSON.parse(
        readFileSync(
          join(cwd, '.video-gen', 'single', String(result.details?.jobId), 'manifest.json'),
          'utf-8',
        ),
      );
      expect(manifest.error).toBe('rejected secret-prompt <url>');
    } finally {
      stderr.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('/video-gen compose runs C0 end-to-end with real clips', async () => {
    const { execFileSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const ffmpegBin = createRequire(import.meta.url)('ffmpeg-static') as string;

    const projectDir = join(cwd, 'Project With Spaces');
    const clipsDir = join(projectDir, 'clips');
    mkdirSync(clipsDir, { recursive: true });
    const mk = (name: string) => {
      const p = join(clipsDir, name);
      execFileSync(ffmpegBin, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=red:size=64x64',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        p,
      ]);
      return p;
    };
    const a = mk('a.mp4');
    const b = mk('b.mp4');

    const jobDir = join(projectDir, '.video-gen', 'job-compose');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'compose-input.json'),
      JSON.stringify({
        clips: [
          { id: 'c1', path: a },
          { id: 'c2', path: b },
        ],
        output: { mode: 'copy' },
      }),
    );

    const ctx = fakeCtx(projectDir);
    await commands.get('video-gen')!.handler(`compose ${join(jobDir, 'compose-input.json')}`, ctx);
    const text = notifiedText(ctx);
    expect(text).toContain('Final video ready');
    expect(text).toContain('2 clips');
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      'video-gen:last-job',
      expect.objectContaining({ jobId: 'job-compose', kind: 'compose' }),
    );
  });

  it('/video-gen recover lists, resets, and adopts ambiguous shots', async () => {
    const jobDir = join(cwd, '.video-gen', 'job-rec');
    mkdirSync(jobDir, { recursive: true });
    const h64 = 'a'.repeat(64);
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId: 'job-rec',
        kind: 'render',
        state: 'polling_stopped',
        specFingerprint: 'fp',
        frameHashes: { 'shots/s1/first_frame.png': h64, 'shots/s2/first_frame.png': h64 },
        shots: { s1: { state: 'ambiguous' }, s2: { state: 'pending' } },
        updatedAt: 'x',
      }),
    );

    // list
    let ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('recover job-rec', ctx);
    expect(notifiedText(ctx)).toContain('s1');
    expect(notifiedText(ctx)).toContain('reset');
    expect(notifiedText(ctx)).toContain('adopt');

    // reset
    ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('recover job-rec s1 reset', ctx);
    const afterReset = JSON.parse(
      (await import('node:fs')).readFileSync(join(jobDir, 'manifest.json'), 'utf-8'),
    );
    expect(afterReset.shots.s1.state).toBe('pending');
    expect(notifiedText(ctx)).toContain('reset to pending');

    // adopt
    ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('recover job-rec s2 adopt task-9', ctx);
    expect(notifiedText(ctx)).toContain('not ambiguous'); // s2 is pending, not ambiguous

    // set back to ambiguous then adopt
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...afterReset, shots: { ...afterReset.shots, s1: { state: 'ambiguous' } } }),
    );
    ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('recover job-rec s1 adopt task-9', ctx);
    const afterAdopt = JSON.parse(
      (await import('node:fs')).readFileSync(join(jobDir, 'manifest.json'), 'utf-8'),
    );
    expect(afterAdopt.shots.s1.state).toBe('submitted');
    expect(afterAdopt.shots.s1.handle.taskId).toBe('task-9');
    expect(notifiedText(ctx)).toContain('task-9');

    // unknown job
    ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('recover no-such-job', ctx);
    expect(notifiedText(ctx)).toContain('No render job found');
  });

  it('/video-gen recover refuses a job symlink that escapes the output directory', async () => {
    const outside = join(cwd, 'outside-job');
    mkdirSync(outside, { recursive: true });
    const original = {
      jobId: 'job-link',
      kind: 'render',
      state: 'polling_stopped',
      specFingerprint: 'fp',
      frameHashes: { 'shots/s1/first_frame.png': 'a'.repeat(64) },
      shots: { s1: { state: 'ambiguous' } },
      updatedAt: 'x',
    };
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify(original));
    mkdirSync(join(cwd, '.video-gen'), { recursive: true });
    symlinkSync(outside, join(cwd, '.video-gen', 'job-link'), 'dir');

    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler('recover job-link s1 reset', ctx);
    expect(notifiedText(ctx)).toMatch(/outside|refus/i);
    expect(JSON.parse(readFileSync(join(outside, 'manifest.json'), 'utf-8'))).toEqual(original);
  });

  it('/video-gen recover refuses to mutate a job while video_render holds its lock', async () => {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ 'pi-video-gen': { providers: { ark: { apiKey: 'k' } } } }),
    );
    await startSession(cwd);
    const f1 = join(cwd, 'f1.png');
    const f2 = join(cwd, 'f2.png');
    writeFileSync(f1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    writeFileSync(f2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jobDir = join(cwd, '.video-gen', 'job-lock');
    const specPath = join(jobDir, 'render-input.json');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      specPath,
      JSON.stringify({
        shots: [
          { id: 's1', prompt: { visuals: 'v1', action: 'one' }, firstFramePath: f1 },
          { id: 's2', prompt: { visuals: 'v2', action: 'two' }, firstFramePath: f2 },
        ],
      }),
    );

    let phase: 'seed' | 'hold' = 'seed';
    let inspectStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      inspectStarted = resolve;
    });
    let releaseInspect!: (response: Response) => void;
    const heldInspect = new Promise<Response>((resolve) => {
      releaseInspect = resolve;
    });
    const succeeded = () =>
      new Response(
        JSON.stringify({
          status: 'succeeded',
          content: { video_url: 'https://93.184.216.34/v.mp4' },
        }),
        { status: 200 },
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST') {
          const body = String(init.body);
          return new Response(JSON.stringify(body.includes('one') ? { id: 'task-1' } : {}), {
            status: 200,
          });
        }
        if (u.includes('/contents/generations/tasks/')) {
          if (phase === 'seed') return succeeded();
          inspectStarted();
          return heldInspect;
        }
        const mp4 = Buffer.alloc(16);
        mp4.write('ftyp', 4, 'ascii');
        return new Response(new Uint8Array(mp4), { status: 200 });
      }),
    );
    try {
      const seed = await tools
        .get('video_render')!
        .execute('seed', { renderSpecPath: specPath }, undefined, undefined, fakeCtx(cwd));
      expect(seed.isError).toBe(true);
      const manifest = JSON.parse(readFileSync(join(jobDir, 'manifest.json'), 'utf-8'));
      manifest.shots.s1.state = 'submitted';
      writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

      phase = 'hold';
      const running = tools
        .get('video_render')!
        .execute('run', { renderSpecPath: specPath }, undefined, undefined, fakeCtx(cwd));
      await started;

      const ctx = fakeCtx(cwd);
      await commands.get('video-gen')!.handler('recover job-lock s2 reset', ctx);
      expect(notifiedText(ctx)).toMatch(/already running/i);

      releaseInspect(succeeded());
      await running;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('/video-gen usage lists recover and render', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler(undefined, ctx);
    const text = notifiedText(ctx);
    expect(text).toContain('recover');
    expect(text).toContain('render');
  });

  it('/video-gen with no args prints usage', async () => {
    const ctx = fakeCtx(cwd);
    await commands.get('video-gen')!.handler(undefined, ctx);
    expect(notifiedText(ctx)).toContain('/video-gen generate');
  });
});
