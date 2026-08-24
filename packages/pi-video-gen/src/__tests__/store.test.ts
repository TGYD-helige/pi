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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ActiveJobs,
  assertSafeId,
  loadComposeJob,
  loadRenderJob,
  loadSingleJob,
  loadTimelineJob,
  newJobId,
  readJsonFile,
  saveSingleJob,
  singleJobDir,
  writeJsonAtomic,
} from '../jobs/store.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-store');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

describe('assertSafeId', () => {
  it('accepts safe ids and rejects path traversal', () => {
    expect(() => assertSafeId('gen-2026_abc-DEF123', 'job')).not.toThrow();
    for (const bad of [
      '../x',
      'a/b',
      'a\\b',
      '.',
      '..',
      '',
      '-lead',
      'with space',
      'ümlaut',
      'x'.repeat(65),
    ]) {
      expect(() => assertSafeId(bad, 'job')).toThrow(/Invalid job id/);
    }
  });
});

describe('newJobId', () => {
  it('produces unique safe ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newJobId('gen')));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(() => assertSafeId(id, 'job')).not.toThrow();
  });
});

describe('manifest persistence', () => {
  beforeEach(() => {
    mkdirSync(suiteDir, { recursive: true });
  });

  it('never follows a pre-placed tmp symlink when writing atomically', async () => {
    const dir = join(suiteDir, `oxcl-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'atomic.json');
    const victim = join(dir, 'victim.json');
    writeFileSync(victim, 'precious');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(victim, `${path}.tmp-${process.pid}-0`, 'file');
    writeJsonAtomic(path, { ok: true });
    expect(readFileSync(victim, 'utf-8')).toBe('precious');
    expect(readJsonFile<{ ok: boolean }>(path)?.ok).toBe(true);
  });

  it('writes JSON atomically (no temp files left)', () => {
    const dir = join(suiteDir, `atomic-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'm.json');
    writeJsonAtomic(path, { a: 1 });
    expect(readJsonFile<{ a: number }>(path)?.a).toBe(1);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('round-trips a single-clip job manifest', () => {
    const jobId = newJobId('gen');
    saveSingleJob(suiteDir, {
      jobId,
      kind: 'single',
      state: 'submitted',
      handle: { taskId: 't-1', submittedAt: 'now', requestFingerprint: 'fp' },
      requestFingerprint: 'fp',
      updatedAt: 'now',
    });
    const loaded = loadSingleJob(suiteDir, jobId);
    expect(loaded?.state).toBe('submitted');
    expect(loaded?.handle?.taskId).toBe('t-1');
    expect(existsSync(singleJobDir(suiteDir, jobId))).toBe(true);
  });

  it('refuses a single handle whose fingerprint is not bound to the frozen request', () => {
    const jobId = 'gen-mismatch';
    saveSingleJob(suiteDir, {
      jobId,
      kind: 'single',
      state: 'submitted',
      handle: { taskId: 't-1', submittedAt: 'now', requestFingerprint: 'handle-fp' },
      requestFingerprint: 'expected-fp',
      updatedAt: 'now',
    });
    expect(() => loadSingleJob(suiteDir, jobId)).toThrow(/request fingerprint/);
  });

  it('refuses structurally broken (but valid JSON) render manifests', () => {
    const jobDir = join(suiteDir, 'render-job');
    mkdirSync(jobDir, { recursive: true });
    for (const bad of [
      {},
      { kind: 'single' },
      { kind: 'render', jobId: 'x' },
      { kind: 'render', jobId: 'x', specFingerprint: 'fp' },
    ]) {
      writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(bad));
      expect(() => loadRenderJob(jobDir)).toThrow(/not a valid render manifest/);
    }
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId: 'render-job',
        kind: 'render',
        state: 'rendering',
        specFingerprint: 'fp',
        frameHashes: {},
        shots: {},
        updatedAt: 'x',
      }),
    );
    expect(loadRenderJob(jobDir)?.jobId).toBe('render-job');
  });

  it('refuses structurally broken compose and timeline manifests', () => {
    const composeDir = join(suiteDir, 'compose-job');
    const timelineDir = join(suiteDir, 'timeline-job');
    mkdirSync(composeDir, { recursive: true });
    mkdirSync(timelineDir, { recursive: true });

    writeFileSync(
      join(composeDir, 'manifest.json'),
      JSON.stringify({
        kind: 'compose',
        jobId: 'compose-job',
        state: 'done',
        fingerprint: 'fp',
        clipHashes: null,
        updatedAt: 'x',
      }),
    );
    writeFileSync(
      join(timelineDir, 'manifest.json'),
      JSON.stringify({
        kind: 'timeline',
        jobId: 'timeline-job',
        state: 'done',
        fingerprint: 'fp',
        imageHashes: {},
        segments: null,
        updatedAt: 'x',
      }),
    );

    expect(() => loadComposeJob(composeDir)).toThrow(/valid compose manifest/);
    expect(() => loadTimelineJob(timelineDir)).toThrow(/valid timeline manifest/);
  });

  it('refuses a timeline manifest with no artifact hash map', () => {
    const jobDir = join(suiteDir, 'timeline-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        kind: 'timeline',
        jobId: 'timeline-job',
        state: 'working',
        fingerprint: 'fp',
        imageHashes: {},
        segments: {},
        updatedAt: 'x',
      }),
    );

    expect(() => loadTimelineJob(jobDir)).toThrow(/valid timeline manifest/);
  });

  it('refuses truncated shot entries (submitted/done/polling_stopped without handle)', () => {
    const jobDir = join(suiteDir, 'render-job');
    mkdirSync(jobDir, { recursive: true });
    const base = {
      jobId: 'render-job',
      kind: 'render',
      state: 'rendering',
      specFingerprint: 'fp',
      frameHashes: { 'shots/s1/first_frame.png': 'a'.repeat(64) },
      updatedAt: 'x',
    };
    for (const state of ['submitted', 'done', 'polling_stopped']) {
      writeFileSync(
        join(jobDir, 'manifest.json'),
        JSON.stringify({ ...base, shots: { s1: { state } } }),
      );
      expect(() => loadRenderJob(jobDir)).toThrow(/broken entry for shot "s1"/);
    }
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...base, shots: { s1: { state: 'exploded' } } }),
    );
    expect(() => loadRenderJob(jobDir)).toThrow(/broken entry for shot "s1"/);
    // ambiguous WITHOUT handle is legal by design (blocked at render level)
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...base, shots: { s1: { state: 'ambiguous' } } }),
    );
    expect(loadRenderJob(jobDir)?.shots.s1?.state).toBe('ambiguous');
    // submitted WITH handle is valid
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        ...base,
        shots: {
          s1: {
            state: 'submitted',
            handle: { taskId: 't', submittedAt: 'x', requestFingerprint: 'fp' },
            requestFingerprint: 'fp',
          },
        },
      }),
    );
    expect(loadRenderJob(jobDir)?.shots.s1?.state).toBe('submitted');
  });

  it('returns undefined only for missing manifests; corrupted ones REFUSE', () => {
    expect(loadSingleJob(suiteDir, 'no-such-job')).toBeUndefined();
    // corrupted JSON must throw, not silently re-initialize (would re-bill)
    const jobId = newJobId('gen');
    const dir = singleJobDir(suiteDir, jobId);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, 'manifest.json'), '{"jobId":"x","kind":"single"');
    writeFileSync(join(dir, 'manifest.json'), '{not json');
    expect(() => loadSingleJob(suiteDir, jobId)).toThrow(/corrupted/);
  });

  it('refuses structurally broken single manifests instead of treating them as absent', () => {
    const jobId = newJobId('gen');
    const dir = singleJobDir(suiteDir, jobId);
    mkdirSync(dir, { recursive: true });
    for (const bad of [
      {},
      { kind: 'render', jobId },
      { kind: 'single', jobId, state: 'submitted', updatedAt: 'x' },
      {
        kind: 'single',
        jobId,
        state: 'submitted',
        handle: {},
        modelId: 'm',
        providerStyle: 'ark',
        providerBaseUrl: 'https://ark.example',
        updatedAt: 'x',
      },
    ]) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(bad));
      expect(() => loadSingleJob(suiteDir, jobId)).toThrow(/valid single manifest|broken handle/);
    }
  });

  it('validates the single root before creating a job directory', () => {
    const outputDir = join(suiteDir, `single-root-${Math.random().toString(36).slice(2, 8)}`);
    const outside = join(suiteDir, `outside-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(outputDir, 'single'), 'dir');

    expect(() =>
      saveSingleJob(outputDir, {
        jobId: 'gen-safe',
        kind: 'single',
        state: 'ambiguous',
        updatedAt: 'x',
      }),
    ).toThrow(/outside/);
    expect(readdirSync(outside)).toHaveLength(0);
  });
});

describe('manifest validation', () => {
  it('refuses a manifest whose embedded jobId does not match the directory', () => {
    const jobId = newJobId('gen');
    saveSingleJob(suiteDir, {
      jobId,
      kind: 'single',
      state: 'submitted',
      handle: { taskId: 't-1', submittedAt: 'x', requestFingerprint: 'fp' },
      requestFingerprint: 'fp',
      updatedAt: 'x',
    });
    expect(loadSingleJob(suiteDir, jobId)?.jobId).toBe(jobId);
    // tamper: same directory, foreign jobId inside
    writeFileSync(
      join(singleJobDir(suiteDir, jobId), 'manifest.json'),
      JSON.stringify({ jobId: 'gen-foreign', kind: 'single', state: 'submitted', updatedAt: 'x' }),
    );
    expect(() => loadSingleJob(suiteDir, jobId)).toThrow(/jobId "gen-foreign"/);
  });

  it('accepts frameless shots but refuses malformed frame hashes', () => {
    const jobDir = join(suiteDir, 'render-job');
    mkdirSync(jobDir, { recursive: true });
    const base = {
      jobId: 'render-job',
      kind: 'render',
      state: 'rendering',
      specFingerprint: 'fp',
      updatedAt: 'x',
    };
    const h64 = 'a'.repeat(64);
    const shots = { s1: { state: 'pending' }, s2: { state: 'pending' } };
    // Asset-only shots legitimately have no local frame hashes. Exact
    // spec coverage is checked by runRender before a paid submit.
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...base, frameHashes: {}, shots }),
    );
    expect(loadRenderJob(jobDir)?.frameHashes).toEqual({});
    // A mix of framed and frameless shots may have fewer hashes than shots.
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...base, frameHashes: { 'shots/s1/first_frame.png': h64 }, shots }),
    );
    expect(loadRenderJob(jobDir)?.frameHashes).toEqual({ 'shots/s1/first_frame.png': h64 });
    // non-hex value
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        ...base,
        frameHashes: { a: h64, b: 'not-a-hash' },
        shots,
      }),
    );
    expect(() => loadRenderJob(jobDir)).toThrow(/invalid frame hash/);
    // arrays are not a hash map
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...base, frameHashes: [h64, h64], shots }),
    );
    expect(() => loadRenderJob(jobDir)).toThrow(/not a valid render manifest/);
    // shots must be a keyed object; arrays drop string shot-id properties when serialized.
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        ...base,
        frameHashes: { 'shots/s1/first_frame.png': h64 },
        shots: [{ state: 'pending' }],
      }),
    );
    expect(() => loadRenderJob(jobDir)).toThrow(/not a valid render manifest/);
    // structurally valid keyed maps pass; exact spec coverage is checked by runRender.
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        ...base,
        frameHashes: {
          'shots/s1/first_frame.png': h64,
          'shots/s2/first_frame.png': h64,
        },
        shots,
      }),
    );
    expect(loadRenderJob(jobDir)?.jobId).toBe('render-job');
  });
});

describe('ActiveJobs', () => {
  it('refuses a render manifest whose jobId does not equal the directory name', () => {
    const jobDir = join(suiteDir, 'job-a');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({
        jobId: 'job-b',
        kind: 'render',
        state: 'rendering',
        specFingerprint: 'fp',
        frameHashes: { a: 'a'.repeat(64) },
        shots: { s1: { state: 'pending' } },
        updatedAt: 'x',
      }),
    );
    expect(() => loadRenderJob(jobDir)).toThrow(/declares jobId "job-b" but lives in "job-a"/);
  });

  it('rejects concurrent acquisition and allows reacquire after release', () => {
    const jobs = new ActiveJobs();
    const release = jobs.acquire('/tmp/job-a');
    expect(() => jobs.acquire('/tmp/job-a')).toThrow(/already running/);
    jobs.acquire('/tmp/job-b'); // different dir is fine
    release();
    expect(() => jobs.acquire('/tmp/job-a')).not.toThrow();
  });
});
