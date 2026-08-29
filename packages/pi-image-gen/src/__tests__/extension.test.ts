import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import piImageGenExtension, {
  buildImageGuidelines,
  buildImageToolParameters,
  type ImageToolCapabilities,
  QUALITY_VALUES,
  resolveImageToolCapabilities,
  sizeDescription,
} from '../index.js';
import { findBuiltInModel } from '../models.js';
import type { ImageGenSettings } from '../types.js';

const geminiCaps = findBuiltInModel('gemini-3-pro-image')!.capabilities!;
const qwenCaps = findBuiltInModel('qwen-image-3.0')!.capabilities!;
const seedreamCaps = findBuiltInModel('doubao-seedream-5-0-260128')!.capabilities!;

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

type ToolDef = {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<unknown>;
};
type CommandDef = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
type Handler = (event: unknown, ctx: unknown) => unknown;

function setup() {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const handlers = new Map<string, Handler>();
  const mockPi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((t: ToolDef) => tools.set(t.name, t)),
    registerCommand: vi.fn((name: string, opts: CommandDef) => commands.set(name, opts)),
    appendEntry: vi.fn(),
  };
  piImageGenExtension(mockPi as any);
  return { tools, commands, handlers };
}

// The tool is registered inside session_start (after settings load), matching
// pi-web-access / pi-memory. Fire it so `tools` is populated. With no settings
// on disk the resolved api is null, which yields the fully-featured schema.
async function startSession(handlers: Map<string, Handler>, cwd = '/tmp') {
  await handlers.get('session_start')?.(
    {},
    { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: vi.fn() } },
  );
}

function caps(
  api: ImageToolCapabilities['api'],
  quality: readonly string[] | null,
  model: ImageToolCapabilities['model'] = null,
): ImageToolCapabilities {
  return { api, quality, model };
}

/**
 * Isolate the global/agent-dir settings layers: the developer's real
 * ~/.pi/agent/settings.json would otherwise leak a configured defaultModel
 * into these tests and shape the registered schema. loadPiSettings reads the
 * global layer via os.homedir(), so HOME must be stubbed too. Returns the temp
 * dir for the caller's afterEach cleanup.
 */
function stubIsolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-image-gen-home-'));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('PI_AGENT_HOME', dir);
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  return dir;
}

describe('piImageGenExtension', () => {
  let isolatedHome = '';
  beforeEach(() => {
    isolatedHome = stubIsolatedHome();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  it('registers the /image-gen command at factory time', () => {
    const { commands } = setup();
    expect(commands.has('image-gen')).toBe(true);
  });

  it('registers the image_generate tool on session_start with snippet and guidelines', async () => {
    const { tools, handlers } = setup();
    // Not registered until a session starts and settings are loaded.
    expect(tools.has('image_generate')).toBe(false);
    await startSession(handlers);
    const tool = tools.get('image_generate');
    expect(tool).toBeDefined();
    expect(tool?.promptSnippet).toBeTruthy();
    expect(Array.isArray(tool?.promptGuidelines)).toBe(true);
    expect(tool?.promptGuidelines?.length).toBeGreaterThan(0);
    // The guidance should point to the skill, steer away from icons/logos, and
    // clarify `n` semantics.
    const guidelines = (tool?.promptGuidelines ?? []).join('\n');
    expect(guidelines).toMatch(/read the `image-gen` skill/i);
    expect(guidelines).toMatch(/icon|logo|svg/i);
    expect(guidelines).toMatch(/\bn\b/);
    // Invariant params are always present regardless of provider.
    const props = tool?.parameters.properties ?? {};
    expect(props).toHaveProperty('prompt');
    expect(props).toHaveProperty('image');
    expect(props).toHaveProperty('n');
    expect(props).toHaveProperty('size');
    expect(props).toHaveProperty('filename');
    expect(props).toHaveProperty('outputDir');
  });

  it('/image-gen generate with no prompt notifies an error and does not generate', async () => {
    const { commands, handlers } = setup();
    const notify = vi.fn();
    const ctx = { cwd: '/tmp', hasUI: true, ui: { notify } };
    await handlers.get('session_start')?.({}, ctx);
    await commands.get('image-gen')?.handler('generate', ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Usage:/), 'error');
  });

  it('/image-gen reload reloads settings and re-registers the tool', async () => {
    const { commands, tools } = setup();
    const notify = vi.fn();
    await commands.get('image-gen')?.handler('reload', { cwd: '/tmp', ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/reloaded/i), 'info');
    // Reload re-registers so the schema tracks the freshly loaded model.
    expect(tools.has('image_generate')).toBe(true);
  });

  it('/image-gen list includes ARK_API_KEY when no provider is configured', async () => {
    for (const name of [
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'DASHSCOPE_API_KEY',
      'OPENROUTER_API_KEY',
      'ARK_API_KEY',
    ]) {
      vi.stubEnv(name, undefined);
    }
    try {
      const { commands } = setup();
      const notify = vi.fn();
      await commands.get('image-gen')?.handler('', { cwd: '/tmp', ui: { notify } });
      expect(String(notify.mock.calls[0]?.[0])).toContain('ARK_API_KEY');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveImageToolCapabilities', () => {
  // These cases set provider API-key env vars so the model resolves. Use
  // vi.stubEnv so the mutations are auto-reverted after each test rather than
  // leaking into other tests sharing this worker (which lost the original value).
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes the quality enum for the built-in openai provider', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const c = resolveImageToolCapabilities({ defaultModel: 'gpt-image-2' });
    expect(c.api).toBe('openai');
    expect(c.quality).toEqual(QUALITY_VALUES);
  });

  it('exposes the quality enum for the built-in openrouter provider', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    const settings: ImageGenSettings = {
      defaultModel: 'openrouter/openai/gpt-image-2',
    };
    const c = resolveImageToolCapabilities(settings);
    expect(c.api).toBe('openrouter');
    expect(c.quality).toEqual(QUALITY_VALUES);
  });

  it('omits quality for openai/dall-e-3 on the built-in provider (non-gpt-image vocab)', () => {
    // Routing DALL·E 3 through the built-in openai provider (slash form) still
    // must NOT advertise low|medium|high|auto — DALL·E 3 uses standard/hd and
    // would 400. The gate keys on the gpt-image model id, not the openai wire.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const c = resolveImageToolCapabilities({ defaultModel: 'openai/dall-e-3' });
    expect(c.api).toBe('openai');
    expect(c.quality).toBeNull();
  });

  it('omits quality for an OpenRouter route to a non-gpt-image model', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    const c = resolveImageToolCapabilities({
      defaultModel: 'openrouter/bytedance-seed/seedream-4.5',
    });
    expect(c.api).toBe('openrouter');
    expect(c.quality).toBeNull();
  });

  it('omits quality for gemini, dashscope, and ark built-ins', () => {
    vi.stubEnv('GEMINI_API_KEY', 'gem-test');
    vi.stubEnv('DASHSCOPE_API_KEY', 'ds-test');
    vi.stubEnv('ARK_API_KEY', 'ark-test');
    expect(resolveImageToolCapabilities({ defaultModel: 'nano-banana' }).quality).toBeNull();
    expect(resolveImageToolCapabilities({ defaultModel: 'qwen-image-2.0' }).quality).toBeNull();
    expect(resolveImageToolCapabilities({ defaultModel: 'seedream' }).quality).toBeNull();
  });

  it('omits quality for a CUSTOM openai-compatible provider (vocab unknown, e.g. DALL·E 3)', () => {
    // A self-hosted / third-party OpenAI-wire model may use a different quality
    // vocabulary (DALL·E 3: standard/hd) or none — wire format != capability.
    const settings: ImageGenSettings = {
      defaultModel: 'dall-e-3',
      customProviders: {
        myopenai: {
          api: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'k',
          models: [{ id: 'dall-e-3', alias: 'dall-e-3' }],
        },
      },
    };
    const c = resolveImageToolCapabilities(settings);
    expect(c.api).toBe('openai');
    expect(c.quality).toBeNull();
  });

  it('falls back to the full schema (quality present) when the model is unset', () => {
    expect(resolveImageToolCapabilities({}).quality).toEqual(QUALITY_VALUES);
    expect(resolveImageToolCapabilities({}).api).toBeNull();
  });

  it('falls back to the full schema when the model cannot be resolved', () => {
    const c = resolveImageToolCapabilities({ defaultModel: 'no-such-model-xyz' });
    expect(c.quality).toEqual(QUALITY_VALUES);
    expect(c.api).toBeNull();
  });

  it('attaches the registry contract for built-in models', () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'ds-test');
    vi.stubEnv('GEMINI_API_KEY', 'gem-test');
    const qwen = resolveImageToolCapabilities({ defaultModel: 'qwen-image-3.0' });
    expect(qwen.model?.sizeRange?.separator).toBe('*');
    const gemini = resolveImageToolCapabilities({ defaultModel: 'nano-banana-pro' });
    expect(gemini.model?.aspectRatios).toContain('16:9');
  });

  it('keeps the generic schema (model null) for custom models without a contract', () => {
    const settings: ImageGenSettings = {
      defaultModel: 'my-model',
      customProviders: {
        gateway: {
          api: 'openai',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'k',
          models: ['my-model'],
        },
      },
    };
    expect(resolveImageToolCapabilities(settings).model).toBeNull();
  });

  it('inherits the registry contract for a custom model naming a built-in id', () => {
    const settings: ImageGenSettings = {
      defaultModel: 'qwen-image-3.0',
      customProviders: {
        gateway: {
          api: 'dashscope',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'k',
          models: ['qwen-image-3.0'],
        },
      },
    };
    const c = resolveImageToolCapabilities(settings);
    expect(c.api).toBe('dashscope');
    expect(c.model?.sizeRange?.separator).toBe('*');
  });
});

describe('buildImageToolParameters', () => {
  it('includes a constrained quality enum when capabilities allow it', () => {
    const props = buildImageToolParameters(caps('openai', QUALITY_VALUES)).properties as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(props).toHaveProperty('quality');
    expect(props.quality?.enum).toEqual([...QUALITY_VALUES]);
  });

  it('omits quality when capabilities disallow it', () => {
    for (const api of ['gemini', 'dashscope', 'ark'] as const) {
      const props = buildImageToolParameters(caps(api, null)).properties as Record<string, unknown>;
      expect(props).not.toHaveProperty('quality');
    }
  });

  it('always exposes the invariant params', () => {
    const cases: ImageToolCapabilities[] = [
      caps('openai', QUALITY_VALUES),
      caps('gemini', null),
      caps('ark', null),
      caps(null, QUALITY_VALUES),
    ];
    for (const c of cases) {
      const props = buildImageToolParameters(c).properties as Record<string, unknown>;
      for (const key of ['prompt', 'image', 'n', 'size', 'filename', 'outputDir']) {
        expect(props).toHaveProperty(key);
      }
    }
  });

  it('gemini-style models swap size for aspectRatio (+imageSize when tiered)', () => {
    const pro = buildImageToolParameters(caps('gemini', null, geminiCaps)).properties as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(pro).not.toHaveProperty('size');
    expect(pro.aspectRatio?.enum).toContain('16:9');
    expect(pro.imageSize?.enum).toEqual(['1K', '2K', '4K']);

    // A single-tier model hides imageSize; a tier-less model hides both.
    const lite = buildImageToolParameters(
      caps('gemini', null, { ...geminiCaps, imageSizes: ['1K'] }),
    ).properties as Record<string, unknown>;
    expect(lite).not.toHaveProperty('imageSize');
    // Destructure the tier list away — exactOptionalPropertyTypes forbids an
    // explicit `imageSizes: undefined` in the object literal.
    const { imageSizes: _tiers, ...geminiWithoutTiers } = geminiCaps;
    const fixed = buildImageToolParameters(caps('gemini', null, geminiWithoutTiers))
      .properties as Record<string, unknown>;
    expect(fixed).not.toHaveProperty('imageSize');
    expect(fixed).toHaveProperty('aspectRatio');
  });

  it('carries the documented n ceiling as advice (no maximum) and hides n when there is no count knob', () => {
    // Advisory, not gated: no schema maximum — a private deployment may allow
    // more than the cloud docs, and the provider's error is the backstop.
    const qwen = buildImageToolParameters(caps('dashscope', null, qwenCaps)).properties as Record<
      string,
      { maximum?: number; description?: string }
    >;
    expect(qwen.n?.maximum).toBeUndefined();
    expect(qwen.n?.description).toContain('up to 6');

    const seedream = buildImageToolParameters(caps('ark', null, seedreamCaps)).properties as Record<
      string,
      unknown
    >;
    expect(seedream).not.toHaveProperty('n');
  });

  it('drives the size schema from the model contract', () => {
    // qwen: description spells out the documented form and limits — with NO
    // schema pattern, so out-of-range values reach the provider (advisory).
    const qwen = buildImageToolParameters(caps('dashscope', null, qwenCaps)).properties as Record<
      string,
      { pattern?: string; description?: string }
    >;
    expect(qwen.size?.pattern).toBeUndefined();
    expect(qwen.size?.description).toContain('<width>*<height>');
    expect(qwen.size?.description).toContain('Documented limits');

    // discrete list → string enum.
    const fixed = buildImageToolParameters(
      caps('openai', null, {
        sizes: ['1024x1024', '1792x1024'],
        nMax: 1,
        maxReferenceImages: 0,
        inputFormats: ['PNG'],
        inputMaxBytes: 4 * 1024 * 1024,
      }),
    ).properties as Record<string, { enum?: unknown[] }>;
    expect(fixed.size?.enum).toEqual(['1024x1024', '1792x1024']);
  });

  it('spells out the reference-image contract in the image description', () => {
    const props = buildImageToolParameters(caps('dashscope', null, qwenCaps)).properties as Record<
      string,
      { description?: string }
    >;
    expect(props.image?.description).toContain('JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF');
    expect(props.image?.description).toContain('documents up to 3');
    // The fallback schema keeps the generic description.
    const generic = buildImageToolParameters(caps(null, QUALITY_VALUES)).properties as Record<
      string,
      { description?: string }
    >;
    expect(generic.image?.description).not.toContain('documents up to');
  });
});

describe('sizeDescription', () => {
  it('warns about the 2K minimum for ark/Seedream', () => {
    expect(sizeDescription('ark')).toMatch(/2K|2048/);
  });

  it('uses the generic 1024x1024 hint for other providers', () => {
    expect(sizeDescription('openai')).toMatch(/1024x1024/);
    expect(sizeDescription(null)).toMatch(/1024x1024/);
  });
});

describe('image_generate execute error surfaces are sanitized', () => {
  // A provider CDN URL whose credential lives in the query — the thing a raw
  // fetch rejection would reproduce into stderr / the tool result if we trusted
  // plain Error messages. It must reach NEITHER surface.
  const SIGNED_URL = 'https://93.184.216.34/gen/out.png?X-Amz-Signature=SECRET&token=USERTOKEN';
  // A 1x1 PNG (magic bytes + minimal IDAT) so materialize() accepts the result
  // and the run reaches the write step, where the output-dir failure fires.
  const PNG_B64 = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082',
    'hex',
  ).toString('base64');
  const pngResponse = () =>
    new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const tmpDirs: string[] = [];
  let realFetch: typeof fetch;
  let isolatedHome = '';

  const makeProject = (settings: ImageGenSettings): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-image-gen-execute-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ 'pi-image-gen': settings }));
    return dir;
  };

  const runExecute = async (cwd: string, params: Record<string, unknown> = { prompt: 'a cat' }) => {
    const { tools, handlers } = setup();
    await handlers.get('session_start')?.(
      {},
      { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: vi.fn() } },
    );
    const tool = tools.get('image_generate');
    if (!tool) throw new Error('tool not registered');
    return (await tool.execute('call-1', params, undefined, undefined, {
      cwd,
    })) as { content: Array<{ text: string }>; isError?: boolean };
  };

  beforeEach(() => {
    tmpDirs.length = 0;
    realFetch = globalThis.fetch;
    safeFetchMock.mockReset().mockImplementation((input, init) => globalThis.fetch(input, init));
    // Keep the developer's global settings (and the default model they
    // configure) out of the execute path.
    isolatedHome = stubIsolatedHome();
    // Stub (don't assign) so it's auto-reverted after each test — a bare
    // process.env write would leak into other tests sharing this worker.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = realFetch;
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    isolatedHome = '';
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('allows image_generate when the image-gen skill was not read', async () => {
    const cwd = makeProject({ defaultModel: 'gpt-image-2' });
    const fetchMock = vi.fn(async () => pngResponse());
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await runExecute(cwd);

    expect(result.isError).not.toBe(true);
    expect(result.content.map((item) => item.text).join('\n')).toMatch(/Generated 1 image/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('leaks neither the signed download URL nor a raw error to stderr or the tool result', async () => {
    // Generation returns a url-style result; the follow-up download rejects with
    // the full signed URL in its message — the exact plain-Error leak path.
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: SIGNED_URL }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`request to ${SIGNED_URL} failed, reason: ECONNREFUSED`);
    }) as typeof fetch;
    globalThis.fetch = fetchImpl;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(makeProject({ defaultModel: 'gpt-image-2' }));
      expect(result.isError).toBe(true);
      const toolText = result.content.map((c) => c.text).join('\n');
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      for (const surface of [toolText, logged]) {
        expect(surface).not.toContain('X-Amz-Signature');
        expect(surface).not.toContain('SECRET');
        expect(surface).not.toContain('USERTOKEN');
        expect(surface).not.toContain('token=');
        expect(surface).not.toContain('ECONNREFUSED');
      }
      // The stderr line is the terse, body-free category summary.
      expect(logged).toContain('generated image download failed');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('classifies a download body that breaks after headers — not a generic failure', async () => {
    // Generation returns a url-style result; the download response's headers
    // arrive OK (200) but the body read (arrayBuffer) rejects mid-stream. Before
    // the fix this escaped as `unexpected AbortError` with a generic user message;
    // now it is a body-free download category, and the signed URL never leaks.
    const brokenBodyResponse = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new DOMException('aborted', 'AbortError'));
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'image/png' },
      },
    );
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: SIGNED_URL }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return brokenBodyResponse;
    }) as typeof fetch;
    globalThis.fetch = fetchImpl;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(makeProject({ defaultModel: 'gpt-image-2' }));
      expect(result.isError).toBe(true);
      const toolText = result.content.map((c) => c.text).join('\n');
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Real, greppable download category — not the empty "unexpected" fallback.
      expect(logged).toContain('generated image download failed');
      expect(logged).not.toContain('unexpected');
      // User gets an actionable download error, not the generic internal-fault line.
      expect(toolText).not.toMatch(/failed unexpectedly/i);
      // The signed URL still leaks to neither surface.
      for (const surface of [toolText, logged]) {
        expect(surface).not.toContain('X-Amz-Signature');
        expect(surface).not.toContain('SECRET');
        expect(surface).not.toContain('USERTOKEN');
        expect(surface).not.toContain('token=');
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs only a body-free config summary when the model is unresolvable', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(makeProject({ defaultModel: 'no-such-model-xyz' }));
      expect(result.isError).toBe(true);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('[pi-image-gen] image_generate failed:');
      expect(logged).toContain('model did not resolve');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('gives an actionable, path-free error when the output dir cannot be created', async () => {
    // Generation succeeds, but writing fails: outputDir is nested UNDER a regular
    // file, so mkdir throws ENOTDIR — the same class as the reviewer's
    // /dev/null/child repro. The user must get an actionable hint (not a generic
    // "check the logs" with nothing in them), and no absolute path may leak.
    const cwd = makeProject({ defaultModel: 'gpt-image-2' });
    const filePath = join(cwd, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const badOutputDir = join(filePath, 'child'); // parent is a file → ENOTDIR

    globalThis.fetch = (async () => pngResponse()) as typeof fetch;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(cwd, { prompt: 'a cat', outputDir: badOutputDir });
      expect(result.isError).toBe(true);
      const toolText = result.content.map((c) => c.text).join('\n');
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Actionable for the user — points at the output directory knob, and is NOT
      // the generic internal-fault fallback.
      expect(toolText).toMatch(/output directory/i);
      expect(toolText).not.toMatch(/failed unexpectedly/i);
      // stderr carries a real, greppable category — not an empty "unexpected".
      expect(logged).toContain('create the output directory failed');
      // No absolute path leaks to either surface.
      for (const surface of [toolText, logged]) {
        expect(surface).not.toContain(badOutputDir);
        expect(surface).not.toContain(cwd);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('buildImageGuidelines', () => {
  it('mentions the quality knob only when the schema exposes it', () => {
    expect(buildImageGuidelines(caps('openai', QUALITY_VALUES)).join('\n')).toMatch(/quality/i);
    expect(buildImageGuidelines(caps('gemini', null)).join('\n')).not.toMatch(/quality/i);
    expect(buildImageGuidelines(caps('ark', null)).join('\n')).not.toMatch(/quality/i);
  });

  it('always steers away from icons/logos and clarifies n semantics', () => {
    const cases: ImageToolCapabilities[] = [
      caps('openai', QUALITY_VALUES),
      caps('gemini', null),
      caps('ark', null),
      caps(null, QUALITY_VALUES),
    ];
    for (const c of cases) {
      const text = buildImageGuidelines(c).join('\n');
      expect(text).toMatch(/icon|logo|svg/i);
      expect(text).toMatch(/\bn\b/);
    }
  });

  it('guides gemini-style models toward aspectRatio and drops n talk when n is hidden', () => {
    const gemini = buildImageGuidelines(caps('gemini', null, geminiCaps)).join('\n');
    expect(gemini).toContain('aspectRatio');
    expect(gemini).toMatch(/no pixel-`size` knob/);

    const seedream = buildImageGuidelines(caps('ark', null, seedreamCaps)).join('\n');
    expect(seedream).not.toMatch(/`n` produces variants/);
    expect(seedream).not.toContain('aspectRatio');
  });
});
