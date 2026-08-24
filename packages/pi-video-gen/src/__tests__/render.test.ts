import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveModel } from '../config.js';
import { httpStatusError } from '../errors.js';
import { ActiveJobs, loadRenderJob, saveRenderJob } from '../jobs/store.js';
import { BUILT_IN_VIDEO_MODELS } from '../providers/models.js';
import { requestFingerprint } from '../providers/request.js';
import { CancelledError, RateLimiter } from '../providers/task.js';
import { type RenderInput, runRender } from '../render.js';
import type { GenerateVideoParams, ResolvedModel, VideoProviderAdapter } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-render');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

function fakeMp4(): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('ftyp', 4, 'ascii');
  return buf;
}

function mockAdapter(calls: {
  submit: number;
  download: number;
  params: GenerateVideoParams[];
}): VideoProviderAdapter {
  return {
    async submit(_p, model, params) {
      calls.submit++;
      calls.params.push(structuredClone(params));
      return {
        taskId: `task-${calls.submit}`,
        submittedAt: 'now',
        requestFingerprint: requestFingerprint(model, params),
      };
    },
    async inspect() {
      return { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
    },
    async downloadTo(_p, _h, _url, destPath) {
      calls.download++;
      writeFileSync(destPath, fakeMp4());
      return { path: destPath, bytes: 32 };
    },
  };
}

function baseResolved(): ResolvedModel {
  return resolveModel({ providers: { ark: { apiKey: 'k' } } })!;
}

function noFlfResolved(): ResolvedModel {
  const entry = BUILT_IN_VIDEO_MODELS[0]!;
  return {
    entry: {
      ...entry,
      capabilities: { ...entry.capabilities, supportsFirstLastFrame: false },
    },
    remoteId: entry.id,
    provider: { style: 'ark', apiKey: 'k', baseUrl: 'https://ark.example' },
  };
}

function makeJob(cwd: string, spec: RenderInput) {
  const jobDir = join(cwd, '.video-gen', 'job-x');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'render-input.json'), JSON.stringify(spec));
  return jobDir;
}

function makeFrame(cwd: string, name: string, content = 'frame-bytes'): string {
  const dir = join(cwd, 'frames');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(content)]));
  return p;
}

function baseOpts(
  cwd: string,
  adapter: VideoProviderAdapter,
  concatCalls: { inputs: string[][] },
  resolved = baseResolved(),
) {
  return {
    settings: {},
    cwd,
    resolved,
    adapter,
    activeJobs: new ActiveJobs(),
    rateLimiter: new RateLimiter(),
    ffmpegPath: 'unused-ffmpeg',
    concatImpl: (async ({ inputs, outputPath }: { inputs: string[]; outputPath: string }) => {
      concatCalls.inputs.push(inputs);
      writeFileSync(outputPath, fakeMp4());
    }) as never,
    onUpdate: vi.fn(),
  };
}

describe('runRender', () => {
  let cwd: string;
  let calls: { submit: number; download: number; params: GenerateVideoParams[] };
  let concatCalls: { inputs: string[][] };

  beforeEach(() => {
    cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
    calls = { submit: 0, download: 0, params: [] };
    concatCalls = { inputs: [] };
  });

  it('renders an asset-only shot without a first frame and normalizes asset URIs', async () => {
    const jobDir = makeJob(cwd, {
      style: 'cinematic',
      shots: [
        {
          id: 's1',
          prompt: { scene: 'studio', visuals: 'medium shot', action: 'speaks to camera' },
          referenceAssets: [
            { modality: 'image', assetId: 'asset://asset-avatar-1' },
            { modality: 'audio', assetId: 'asset-voice-1' },
          ],
        },
      ],
    });

    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    expect(calls.submit).toBe(1);
    expect(calls.params[0]!.firstFramePath).toBeUndefined();
    expect(calls.params[0]!.referenceAssets).toEqual([
      { modality: 'image', assetId: 'asset-avatar-1' },
      { modality: 'audio', assetId: 'asset-voice-1' },
    ]);
    expect(loadRenderJob(jobDir)!.frameHashes).toEqual({});
  });

  it('applies Seedance reference limits per modality before a paid submit', async () => {
    const firstFrame = makeFrame(cwd, 'first.png');
    const lastFrame = makeFrame(cwd, 'last.png');
    const jobDir = makeJob(cwd, {
      style: 'cinematic',
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'medium shot', action: 'speaks to camera' },
          firstFramePath: firstFrame,
          lastFramePath: lastFrame,
          referenceAssets: [
            ...Array.from({ length: 7 }, (_, index) => ({
              modality: 'image' as const,
              assetId: `asset-image-${index}`,
            })),
            ...Array.from({ length: 3 }, (_, index) => ({
              modality: 'video' as const,
              assetId: `asset-video-${index}`,
            })),
            ...Array.from({ length: 3 }, (_, index) => ({
              modality: 'audio' as const,
              assetId: `asset-audio-${index}`,
            })),
          ],
        },
      ],
    });

    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    expect(calls.submit).toBe(1);
    expect(calls.params[0]!.referenceAssets).toHaveLength(13);
  });

  it('rejects too many Seedance video assets before a paid submit', async () => {
    const jobDir = makeJob(cwd, {
      style: 'cinematic',
      shots: [
        {
          id: 's1',
          prompt: { scene: 'studio', visuals: 'medium shot', action: 'speaks to camera' },
          referenceAssets: Array.from({ length: 4 }, (_, index) => ({
            modality: 'video' as const,
            assetId: `asset-video-${index}`,
          })),
        },
      ],
    });

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/video references \(4\).*at most 3/i);
    expect(calls.submit).toBe(0);
  });

  it('rejects a shot without a local frame or trusted asset before a paid submit', async () => {
    const jobDir = makeJob(cwd, {
      style: 'cinematic',
      shots: [
        {
          id: 's1',
          prompt: { scene: 'studio', visuals: 'medium shot', action: 'speaks to camera' },
        },
      ],
    });

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/firstFramePath or at least one referenceAsset/i);
    expect(calls.submit).toBe(0);
  });

  it('rejects malformed or unsupported trusted assets before a paid submit', async () => {
    const malformedDir = makeJob(cwd, {
      style: 'cinematic',
      shots: [
        {
          id: 's1',
          prompt: { scene: 'studio', visuals: 'medium shot', action: 'speaks' },
          referenceAssets: [{ modality: 'image', assetId: 'not-an-asset' }],
        },
      ],
    } as RenderInput);
    await expect(
      runRender({
        renderSpecPath: join(malformedDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/assetId.*asset-/i);
    expect(calls.submit).toBe(0);

    rmSync(malformedDir, { recursive: true, force: true });
    const unsupportedDir = makeJob(cwd, {
      style: 'cinematic',
      shots: [
        {
          id: 's1',
          prompt: { scene: 'studio', visuals: 'medium shot', action: 'speaks' },
          referenceAssets: [{ modality: 'image', assetId: 'asset-avatar-1' }],
        },
      ],
    });
    const unsupported = noFlfResolved();
    unsupported.entry.capabilities.referenceAssetModalities = undefined;
    await expect(
      runRender({
        renderSpecPath: join(unsupportedDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls, unsupported),
      }),
    ).rejects.toThrow(/does not support trusted asset references/i);
    expect(calls.submit).toBe(0);
  });

  it.each([
    ['numeric string', '5'],
    ['fraction', 4.5],
  ])('rejects a %s duration before a paid submit', async (_label, durationSec) => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      jobId: 'job-x',
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'v', action: 'motion' },
          firstFramePath: frame,
          durationSec,
        },
      ],
    } as unknown as RenderInput);

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/durationSec.*integer/);
    expect(calls.submit).toBe(0);
  });

  it('rejects a shot prompt missing required fields before any paid submit', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { action: 'm1' }, firstFramePath: frame }],
    } as unknown as RenderInput);

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/\.prompt\.visuals is required/);
    expect(calls.submit).toBe(0);
  });

  it('rejects a non-string shot id instead of coercing it', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 42, prompt: { visuals: 'v', action: 'm1' }, firstFramePath: frame }],
    } as unknown as RenderInput);
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/id must be a non-empty string/);
    expect(calls.submit).toBe(0);
  });

  it('rejects a non-string aspectRatio instead of letting it reach the fingerprint', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      aspectRatio: 0,
      shots: [{ id: 's1', prompt: { visuals: 'v', action: 'm1' }, firstFramePath: frame }],
    } as unknown as RenderInput);
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/aspectRatio must be a non-empty string/);
    expect(calls.submit).toBe(0);
  });

  it('rejects a non-string lastFramePath before path operations', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'v', action: 'm1' },
          firstFramePath: frame,
          lastFramePath: 42,
        },
      ],
    } as unknown as RenderInput);
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/lastFramePath must be a path string/);
    expect(calls.submit).toBe(0);
  });

  it('rejects a visibleCharacters reference missing from the film registry', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      characters: [{ id: 'alice', description: 'red scarf' }],
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'v', action: 'm1', visibleCharacters: ['bob'] },
          firstFramePath: frame,
        },
      ],
    });

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/unknown character "bob"/);
    expect(calls.submit).toBe(0);
  });

  it('rejects duplicate film-level character ids', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      characters: [
        { id: 'alice', description: 'd1' },
        { id: 'alice', description: 'd2' },
      ],
      shots: [{ id: 's1', prompt: { visuals: 'v', action: 'm1' }, firstFramePath: frame }],
    });

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/duplicates character id "alice"/);
    expect(calls.submit).toBe(0);
  });

  it('submits the assembled labeled prompt carrying film-level directives', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      style: 'cinematic, 8K',
      characters: [
        { id: 'alice', description: 'long blonde hair, red scarf' },
        { id: 'bob', description: 'tall, black coat' },
      ],
      consistency: 'Faces stay identical, no morphing.',
      negative: 'no text or watermarks',
      shots: [
        {
          id: 's1',
          prompt: {
            scene: 'rainy alley',
            visuals: 'slow push-in',
            action: 'Alice walks in',
            effects: 'rain intensifies',
            audio: '[Sound Effect] rain',
            visibleCharacters: ['alice'],
          },
          firstFramePath: frame,
          durationSec: 5,
        },
      ],
    });

    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    expect(calls.submit).toBe(1);
    expect(calls.params[0]!.prompt).toBe(
      [
        '[Style] cinematic, 8K',
        '[Character] alice: long blonde hair, red scarf',
        '[Scene] rainy alley',
        '[Visuals] slow push-in',
        '[Action] Alice walks in',
        '[Effects] rain intensifies',
        '[Audio] [Sound Effect] rain',
        'Faces stay identical, no morphing.',
        'Negative: no text or watermarks',
      ].join('\n'),
    );
  });

  it('runs a fresh job end-to-end: snapshot → submit → download → concat', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const f2 = makeFrame(cwd, 'b.png');
    const jobDir = makeJob(cwd, {
      title: 't',
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'v1', action: 'motion one' },
          firstFramePath: f1,
          durationSec: 5,
        },
        {
          id: 's2',
          prompt: { visuals: 'v2', action: 'motion two' },
          firstFramePath: f2,
          durationSec: 5,
        },
      ],
    });

    const result = await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    expect(result.shotsDone).toBe(2);
    expect(calls.submit).toBe(2);
    expect(calls.download).toBe(2);
    expect(existsSync(result.finalVideoPath)).toBe(true);
    // snapshots + assets.json + manifest
    expect(existsSync(join(jobDir, 'shots', 's1', 'first_frame.png'))).toBe(true);
    expect(existsSync(join(jobDir, 'assets.json'))).toBe(true);
    const manifest = loadRenderJob(jobDir)!;
    expect(manifest.state).toBe('done');
    expect(Object.keys(manifest.frameHashes)).toHaveLength(2);
    // concat received clips in shot order
    expect(concatCalls.inputs[0]!.map((p) => p.split('/').slice(-2).join('/'))).toEqual([
      's1/video.mp4',
      's2/video.mp4',
    ]);
    // submit used the SNAPSHOT path, not the source path
    expect(calls.params[0]!.firstFramePath).toContain('shots/s1/first_frame');
    expect((calls.params[0] as GenerateVideoParams & { requestId?: string }).requestId).toBe(
      'job-x:s1:1',
    );
  });

  it('resumes without re-billing: done shots skip, submitted shots inspect-resume', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const f2 = makeFrame(cwd, 'b.png');
    const jobDir = makeJob(cwd, {
      shots: [
        { id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 },
        { id: 's2', prompt: { visuals: 'v2', action: 'm2' }, firstFramePath: f2 },
      ],
    });
    const specPath = join(jobDir, 'render-input.json');
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    // simulate crash after s2 submitted but before download
    const manifest = loadRenderJob(jobDir)!;
    manifest.shots.s2 = {
      ...manifest.shots.s2,
      state: 'submitted',
      handle: { ...manifest.shots.s2!.handle!, taskId: 'task-2', submittedAt: 'x' },
    };
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(jobDir, 'manifest.json'), JSON.stringify(manifest));
    const { rmSync } = await import('node:fs');
    rmSync(join(jobDir, 'shots', 's2', 'video.mp4'));

    calls.submit = 0;
    calls.download = 0;
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });
    expect(calls.submit).toBe(0); // s1 done+exists, s2 resumed via persisted handle
    expect(calls.download).toBe(1); // only s2 downloaded
  });

  it('refuses resume when normalized model defaults changed', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    const specPath = join(jobDir, 'render-input.json');
    const resolved = baseResolved();
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls, resolved),
    });

    calls.submit = 0;
    const changed = {
      ...resolved,
      entry: { ...resolved.entry, defaultResolution: '480p' },
    };
    await expect(
      runRender({
        renderSpecPath: specPath,
        ...baseOpts(cwd, mockAdapter(calls), concatCalls, changed),
      }),
    ).rejects.toThrow(/model\/provider config changed|spec drift/i);
    expect(calls.submit).toBe(0);
  });

  it('merges assets.json instead of wiping image-stage entries', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    // image stage pre-registered a portrait
    writeFileSync(
      join(jobDir, 'assets.json'),
      JSON.stringify({ assets: { 'alice/front': { sourcePath: '/img/front.png' } } }),
    );
    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });
    const assets = JSON.parse(readFileSync(join(jobDir, 'assets.json'), 'utf-8')).assets;
    expect(assets['alice/front']).toEqual({ sourcePath: '/img/front.png' });
    expect(assets['s1/firstFrame']).toBeDefined();
  });

  it('refuses a manifest missing a spec shot instead of re-submitting it', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const specPath = join(jobDir, 'render-input.json');
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    // A valid-JSON truncation loses the paid shot entry; this is not proof that
    // the provider created nothing, so resume must fail closed.
    const manifest = loadRenderJob(jobDir)!;
    delete manifest.shots.s1;
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    calls.submit = 0;
    await expect(
      runRender({
        renderSpecPath: specPath,
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/manifest.*shot|shot.*manifest/i);
    expect(calls.submit).toBe(0);
  });

  it('refuses resume when an optional last-frame hash is missing', async () => {
    const first = makeFrame(cwd, 'first.png');
    const last = makeFrame(cwd, 'last.png');
    const jobDir = makeJob(cwd, {
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'v1', action: 'm1' },
          firstFramePath: first,
          lastFramePath: last,
        },
      ],
    });
    const specPath = join(jobDir, 'render-input.json');
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    const manifest = loadRenderJob(jobDir)!;
    delete manifest.frameHashes[join('shots', 's1', 'last_frame.png')];
    manifest.shots.s1 = { state: 'pending' };
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    calls.submit = 0;
    await expect(
      runRender({
        renderSpecPath: specPath,
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/frame hash|snapshot/i);
    expect(calls.submit).toBe(0);
  });

  it('refuses a corrupted manifest instead of re-billing everything', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    writeFileSync(join(jobDir, 'manifest.json'), '{not json');
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/corrupted/);
    expect(calls.submit).toBe(0);
  });

  it('rejects a job directory that escapes outputDir via symlink', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const outside = join(cwd, 'outside-job');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'render-input.json'),
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
      }),
    );
    const linkDir = join(cwd, '.video-gen', 'linked-job');
    mkdirSync(join(cwd, '.video-gen'), { recursive: true });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, linkDir, 'dir');
    await expect(
      runRender({
        renderSpecPath: join(linkDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/must live under/);
    expect(calls.submit).toBe(0);
  });

  it('refuses a pre-placed destination symlink for a frame snapshot', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const outside = join(cwd, 'victim.txt');
    writeFileSync(outside, 'precious');
    const shotDir = join(jobDir, 'shots', 's1');
    mkdirSync(shotDir, { recursive: true });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, join(shotDir, 'first_frame.png'), 'file');

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/not a regular file/);
    expect(readFileSync(outside, 'utf-8')).toBe('precious'); // untouched
    expect(calls.submit).toBe(0);
  });

  it('manifest frame hashes match the SNAPSHOT bytes', async () => {
    const f1 = makeFrame(cwd, 'a.png', 'frame-v1');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });
    const manifest = loadRenderJob(jobDir)!;
    const snap = join(jobDir, 'shots', 's1', 'first_frame.png');
    const { createHash } = await import('node:crypto');
    const expectHash = createHash('sha256').update(readFileSync(snap)).digest('hex');
    expect(manifest.frameHashes[join('shots', 's1', 'first_frame.png')]).toBe(expectHash);
  });

  it('concat cancel ⇒ polling_stopped; concat error ⇒ failed', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const opts = baseOpts(cwd, mockAdapter(calls), concatCalls);
    opts.concatImpl = (async () => {
      const { CancelledError } = await import('../providers/task.js');
      throw new CancelledError();
    }) as never;
    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow(/cancelled/i);
    expect(loadRenderJob(jobDir)!.state).toBe('polling_stopped');

    // generic concat failure on a fresh job ⇒ failed
    const jobDir2 = join(cwd, '.video-gen', 'job-y');
    mkdirSync(jobDir2, { recursive: true });
    writeFileSync(
      join(jobDir2, 'render-input.json'),
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
      }),
    );
    const opts2 = baseOpts(cwd, mockAdapter(calls), concatCalls);
    opts2.concatImpl = (async () => {
      throw new Error('ffmpeg blew up');
    }) as never;
    await expect(
      runRender({ renderSpecPath: join(jobDir2, 'render-input.json'), ...opts2 }),
    ).rejects.toThrow(/blew up|unexpected/i);
    expect(loadRenderJob(jobDir2)!.state).toBe('failed');
  });

  it('concurrency lock collides on the REAL path across lexical aliases', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    // real job inside realOut; aliasOut symlinks to realOut
    const realOut = join(cwd, 'real-out');
    const jobDir = join(realOut, 'job-x');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'render-input.json'),
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
      }),
    );
    const aliasOut = join(cwd, 'alias-out');
    const { symlinkSync, realpathSync } = await import('node:fs');
    symlinkSync(realOut, aliasOut, 'dir');

    const opts = baseOpts(cwd, mockAdapter(calls), concatCalls);
    opts.settings = { outputDir: 'alias-out' }; // run through the ALIAS
    // hold the lock on the REAL job dir
    const release = opts.activeJobs.acquire(realpathSync(jobDir));
    await expect(
      runRender({ renderSpecPath: join(aliasOut, 'job-x', 'render-input.json'), ...opts }),
    ).rejects.toThrow(/already running/);
    release();
  });

  it('refuses resume when a shot dir was swapped for an external symlink', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const specPath = join(jobDir, 'render-input.json');
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    // attacker swaps shots/s1 for a symlink to an outside dir with a same-hash plant
    const outside = join(cwd, 'planted');
    mkdirSync(outside, { recursive: true });
    const { rmSync, symlinkSync, copyFileSync } = await import('node:fs');
    copyFileSync(join(jobDir, 'shots', 's1', 'first_frame.png'), join(outside, 'first_frame.png'));
    rmSync(join(jobDir, 'shots', 's1'), { recursive: true });
    symlinkSync(outside, join(jobDir, 'shots', 's1'), 'dir');

    await expect(
      runRender({ renderSpecPath: specPath, ...baseOpts(cwd, mockAdapter(calls), concatCalls) }),
    ).rejects.toThrow(/resolves outside the job directory/);
    expect(calls.submit).toBe(1); // no new submit on the poisoned resume
  });

  it('corrupted assets.json refuses rather than truncating the image-stage index', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    writeFileSync(join(jobDir, 'assets.json'), '{corrupted');
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/corrupted/);
    expect(readFileSync(join(jobDir, 'assets.json'), 'utf-8')).toBe('{corrupted'); // untouched
    expect(calls.submit).toBe(0);
  });

  it('ambiguous submit parks the shot and blocks automatic resubmit', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const specPath = join(jobDir, 'render-input.json');

    const ambiguousAdapter: VideoProviderAdapter = {
      async submit() {
        const { AmbiguousSubmitError } = await import('../errors.js');
        throw new AmbiguousSubmitError('maybe created', 'ark submit: ambiguous');
      },
      async inspect() {
        return { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
      },
      async downloadTo() {
        throw new Error('unreachable');
      },
    };
    const opts = baseOpts(cwd, ambiguousAdapter, concatCalls);
    await expect(runRender({ renderSpecPath: specPath, ...opts })).rejects.toThrow(/maybe created/);
    expect(loadRenderJob(jobDir)!.shots.s1!.state).toBe('ambiguous');

    // rerun: refuses to auto-resubmit, no second submit attempted
    let submits = 0;
    const countingAdapter: VideoProviderAdapter = {
      ...ambiguousAdapter,
      async submit() {
        submits++;
        return { taskId: 't', submittedAt: 'x', requestFingerprint: 'fp' };
      },
    };
    let blockedMessage = '';
    try {
      await runRender({
        renderSpecPath: specPath,
        ...baseOpts(cwd, countingAdapter, concatCalls),
      });
    } catch (error) {
      blockedMessage = (error as Error).message;
    }
    expect(blockedMessage).toContain('/video-gen recover job-x s1');
    expect(blockedMessage).not.toContain('manifest.json');
    expect(blockedMessage).not.toContain('state "pending"');
    expect(submits).toBe(0);
  });

  it('persists ambiguous before entering the paid submit call', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    let stateAtSubmit = '';
    const adapter: VideoProviderAdapter = {
      async submit() {
        stateAtSubmit = loadRenderJob(jobDir)!.shots.s1!.state;
        const { AmbiguousSubmitError } = await import('../errors.js');
        throw new AmbiguousSubmitError('maybe created', 'submit ambiguous');
      },
      async inspect() {
        throw new Error('unreachable');
      },
      async downloadTo() {
        throw new Error('unreachable');
      },
    };
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, adapter, concatCalls),
      }),
    ).rejects.toThrow(/maybe created/);
    expect(stateAtSubmit).toBe('ambiguous');
  });

  it('retries a definitively failed provider task in the same job', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    let submits = 0;
    const requestIds: Array<string | undefined> = [];
    const adapter: VideoProviderAdapter = {
      async submit(_provider, _model, params) {
        submits++;
        requestIds.push(params.requestId);
        return {
          taskId: `task-${submits}`,
          submittedAt: 'x',
          requestFingerprint: `fp-${submits}`,
        };
      },
      async inspect(_provider, handle) {
        return handle.taskId === 'task-1'
          ? { phase: 'failed', message: 'rejected' }
          : { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
      },
      async downloadTo(_provider, _handle, _url, destPath) {
        writeFileSync(destPath, fakeMp4());
        return { path: destPath, bytes: 32 };
      },
    };
    const opts = baseOpts(cwd, adapter, concatCalls);
    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow(/provider side/);
    expect(loadRenderJob(jobDir)!.shots.s1).toEqual(expect.objectContaining({ state: 'failed' }));
    expect(loadRenderJob(jobDir)!.shots.s1!.handle).toBeUndefined();

    await runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts });
    expect(submits).toBe(2);
    expect(requestIds).toEqual(['job-x:s1:1', 'job-x:s1:2']);
  });

  it('resumes a legacy submitted shot without persisting attempt zero', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    let cancelled = false;
    const adapter: VideoProviderAdapter = {
      async submit(_provider, model, params) {
        return {
          taskId: 'task-1',
          submittedAt: 'x',
          requestFingerprint: requestFingerprint(model, params),
        };
      },
      async inspect() {
        if (!cancelled) {
          cancelled = true;
          throw new CancelledError();
        }
        return { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
      },
      async downloadTo(_provider, _handle, _url, destPath) {
        writeFileSync(destPath, fakeMp4());
        return { path: destPath, bytes: 32 };
      },
    };
    const opts = baseOpts(cwd, adapter, concatCalls);
    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow(/Stopped locally/);

    const legacy = loadRenderJob(jobDir)!;
    delete legacy.shots.s1!.attempt;
    saveRenderJob(jobDir, legacy);

    await runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts });
    expect(loadRenderJob(jobDir)!.shots.s1).toMatchObject({ state: 'done' });
  });

  it('resumes a submitted shot whose legacy fingerprint omitted referenceAssets', async () => {
    const frame = makeFrame(cwd, 'legacy-assets.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    let submits = 0;
    let cancelled = false;
    let submittedModel = '';
    let submittedParams: GenerateVideoParams | undefined;
    const adapter: VideoProviderAdapter = {
      async submit(_provider, model, params) {
        submits++;
        submittedModel = model;
        submittedParams = structuredClone(params);
        return {
          taskId: 'task-legacy-assets',
          submittedAt: 'x',
          requestFingerprint: requestFingerprint(model, params),
        };
      },
      async inspect() {
        if (!cancelled) {
          cancelled = true;
          throw new CancelledError();
        }
        return { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
      },
      async downloadTo(_provider, _handle, _url, destPath) {
        writeFileSync(destPath, fakeMp4());
        return { path: destPath, bytes: 32 };
      },
    };
    const opts = baseOpts(cwd, adapter, concatCalls);
    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow(/Stopped locally/);

    const legacyFingerprint = requestFingerprint(submittedModel, {
      ...submittedParams!,
      referenceAssets: undefined,
    });
    const legacy = loadRenderJob(jobDir)!;
    legacy.shots.s1!.requestFingerprint = legacyFingerprint;
    legacy.shots.s1!.handle!.requestFingerprint = legacyFingerprint;
    saveRenderJob(jobDir, legacy);

    await runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts });
    expect(submits).toBe(1);
    expect(loadRenderJob(jobDir)!.shots.s1).toMatchObject({ state: 'done' });
  });

  it('calls provider cancellation with a fresh signal before parking remaining work', async () => {
    const frame = makeFrame(cwd, 'cancel.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v', action: 'stop' }, firstFramePath: frame }],
    });
    let cancelSignal: AbortSignal | undefined;
    const adapter: VideoProviderAdapter = {
      async submit(_provider, model, params) {
        return {
          taskId: 'cancel-me',
          submittedAt: 'x',
          requestFingerprint: requestFingerprint(model, params),
        };
      },
      async inspect() {
        throw new CancelledError();
      },
      async downloadTo() {
        throw new Error('unreachable');
      },
      async cancel(_provider, _handle, _fetch, signal) {
        cancelSignal = signal;
        return { cancelled: true };
      },
    };

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, adapter, concatCalls),
      }),
    ).rejects.toThrow(/cancelled 1 remote task/);
    expect(cancelSignal?.aborted).toBe(false);
    expect(loadRenderJob(jobDir)!.shots.s1).toMatchObject({
      state: 'failed',
      error: 'cancelled remotely',
    });
    expect(loadRenderJob(jobDir)!.shots.s1!.handle).toBeUndefined();
  });

  it('parks a provider-missing task for explicit recover instead of looping forever', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    let submits = 0;
    const adapter: VideoProviderAdapter = {
      async submit(_provider, model, params) {
        submits++;
        return {
          taskId: 'gone-task',
          submittedAt: 'x',
          requestFingerprint: requestFingerprint(model, params),
        };
      },
      async inspect() {
        throw httpStatusError('ark', 'inspect', 404);
      },
      async downloadTo() {
        throw new Error('unreachable');
      },
    };
    const opts = baseOpts(cwd, adapter, concatCalls);
    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow('/video-gen recover job-x s1');
    expect(loadRenderJob(jobDir)!.shots.s1).toMatchObject({
      state: 'ambiguous',
      handle: { taskId: 'gone-task' },
    });

    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow(/ambiguous submit/);
    expect(submits).toBe(1);
  });

  it('validates the shots parent before creating a shot directory', async () => {
    const frame = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
    });
    const outside = join(cwd, 'outside-shots');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(jobDir, 'shots'), 'dir');

    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/outside|symlink/);
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it('refuses every non-object assets index shape without overwriting it', async () => {
    const invalidDocs: unknown[] = [null, [], 'broken', { assets: null }, { assets: 'broken' }];
    for (const [i, invalid] of invalidDocs.entries()) {
      const caseCwd = join(cwd, `assets-${i}`);
      const f1 = makeFrame(caseCwd, 'a.png');
      const jobDir = makeJob(caseCwd, {
        shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
      });
      const raw = JSON.stringify(invalid);
      writeFileSync(join(jobDir, 'assets.json'), raw);
      await expect(
        runRender({
          renderSpecPath: join(jobDir, 'render-input.json'),
          ...baseOpts(caseCwd, mockAdapter(calls), concatCalls),
        }),
      ).rejects.toThrow(/not a valid asset index/);
      expect(readFileSync(join(jobDir, 'assets.json'), 'utf-8')).toBe(raw);
    }
    expect(calls.submit).toBe(0);
  });

  it('refuses resume when the spec changed (revision ⇒ new job)', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const specPath = join(jobDir, 'render-input.json');
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    writeFileSync(
      specPath,
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v', action: 'CHANGED' }, firstFramePath: f1 }],
      }),
    );
    await expect(
      runRender({ renderSpecPath: specPath, ...baseOpts(cwd, mockAdapter(calls), concatCalls) }),
    ).rejects.toThrow(/NEW job directory/);
  });

  it('refuses resume when a frame snapshot was tampered with', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const specPath = join(jobDir, 'render-input.json');
    await runRender({
      renderSpecPath: specPath,
      ...baseOpts(cwd, mockAdapter(calls), concatCalls),
    });

    writeFileSync(join(jobDir, 'shots', 's1', 'first_frame.png'), 'tampered');
    await expect(
      runRender({ renderSpecPath: specPath, ...baseOpts(cwd, mockAdapter(calls), concatCalls) }),
    ).rejects.toThrow(/no longer trustworthy/);
  });

  it('preflight: lastFrame unsupported fails; allowDegradations drops it', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const f2 = makeFrame(cwd, 'b.png');
    const jobDir = makeJob(cwd, {
      shots: [
        {
          id: 's1',
          prompt: { visuals: 'v1', action: 'm1' },
          firstFramePath: f1,
          lastFramePath: f2,
        },
      ],
    });
    const specPath = join(jobDir, 'render-input.json');

    await expect(
      runRender({
        renderSpecPath: specPath,
        ...baseOpts(cwd, mockAdapter(calls), concatCalls, noFlfResolved()),
      }),
    ).rejects.toThrow(/last-frame interpolation/);

    const result = await runRender({
      renderSpecPath: specPath,
      allowDegradations: ['first-frame-only'],
      ...baseOpts(cwd, mockAdapter(calls), concatCalls, noFlfResolved()),
    });
    expect(result.degraded.join(';')).toContain('first-frame-only');
    expect(calls.params[0]!.lastFramePath).toBeUndefined();
  });

  it('validates spec and job location before anything paid', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    // duplicate ids
    const dupDir = makeJob(cwd, {
      shots: [
        { id: 's1', prompt: { visuals: 'v', action: 'a' }, firstFramePath: f1 },
        { id: 's1', prompt: { visuals: 'v', action: 'b' }, firstFramePath: f1 },
      ],
    });
    await expect(
      runRender({
        renderSpecPath: join(dupDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/Duplicate shot id/);

    // job outside outputDir
    const outside = join(cwd, 'elsewhere', 'job-y');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'render-input.json'),
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v', action: 'a' }, firstFramePath: f1 }],
      }),
    );
    await expect(
      runRender({
        renderSpecPath: join(outside, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/must live under/);

    // wrong spec filename
    const bad = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v', action: 'a' }, firstFramePath: f1 }],
    });
    const { renameSync } = await import('node:fs');
    renameSync(join(bad, 'render-input.json'), join(bad, 'spec.json'));
    await expect(
      runRender({
        renderSpecPath: join(bad, 'spec.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/must be named render-input.json/);

    expect(calls.submit).toBe(0);
  });

  it('rejects non-integer shot durations before anything paid', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [
        { id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1, durationSec: 4.5 },
      ],
    });
    await expect(
      runRender({
        renderSpecPath: join(jobDir, 'render-input.json'),
        ...baseOpts(cwd, mockAdapter(calls), concatCalls),
      }),
    ).rejects.toThrow(/integer number of seconds/);
    expect(calls.submit).toBe(0);
  });

  it('rejects concurrent runs of the same job dir', async () => {
    const f1 = makeFrame(cwd, 'a.png');
    const jobDir = makeJob(cwd, {
      shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: f1 }],
    });
    const opts = baseOpts(cwd, mockAdapter(calls), concatCalls);
    // Hold the job dir's active slot on its REAL path (the lock's key) —
    // /tmp on macOS is itself a symlink, so lexical ≠ real here.
    const { realpathSync } = await import('node:fs');
    const release = opts.activeJobs.acquire(realpathSync(jobDir));
    await expect(
      runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts }),
    ).rejects.toThrow(/already running/);
    release();
    // After release, the same spec runs fine.
    await runRender({ renderSpecPath: join(jobDir, 'render-input.json'), ...opts });
    expect(calls.submit).toBe(1);
  });
});
