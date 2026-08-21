import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Catches an implementation that hashes the approved source bytes instead of
 * the final snapshot bytes. The write seam replaces the snapshot payload after
 * source validation; the manifest must still hash what landed on disk.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (dest: string, data: Uint8Array, options?: object) => {
      const snapshotBytes = dest.includes('.tmp-')
        ? Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from('v2-mutated'),
          ])
        : data;
      return actual.writeFile(
        dest,
        snapshotBytes,
        options as Parameters<typeof actual.writeFile>[2],
      );
    }),
  };
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveModel } from '../config.js';
import { ActiveJobs, loadRenderJob } from '../jobs/store.js';
import { requestFingerprint } from '../providers/request.js';
import { RateLimiter } from '../providers/task.js';
import { runRender } from '../render.js';
import type { VideoProviderAdapter } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-snap-hash');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

describe('snapshot hash is of the SNAPSHOT bytes (not a pre-copy source read)', () => {
  it('manifest hash equals sha256 of the on-disk snapshot after mid-copy mutation', async () => {
    const cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    const jobDir = join(cwd, '.video-gen', 'job-x');
    mkdirSync(join(cwd, 'frames'), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    const frame = join(cwd, 'frames', 'a.png');
    writeFileSync(
      frame,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('v1-original'),
      ]),
    );
    writeFileSync(
      join(jobDir, 'render-input.json'),
      JSON.stringify({
        shots: [{ id: 's1', prompt: { visuals: 'v1', action: 'm1' }, firstFramePath: frame }],
      }),
    );

    const adapter: VideoProviderAdapter = {
      async submit(_provider, model, params) {
        return {
          taskId: 't-1',
          submittedAt: 'x',
          requestFingerprint: requestFingerprint(model, params),
        };
      },
      async inspect() {
        return { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
      },
      async downloadTo(_p, _h, _u, destPath) {
        writeFileSync(destPath, 'mp4');
        return { path: destPath, bytes: 3 };
      },
    };

    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      settings: {},
      cwd,
      resolved: resolveModel({ providers: { ark: { apiKey: 'k' } } })!,
      adapter,
      activeJobs: new ActiveJobs(),
      rateLimiter: new RateLimiter(),
      ffmpegPath: 'unused',
      concatImpl: (async () => {}) as never,
    });

    const manifest = loadRenderJob(jobDir)!;
    const snapPath = join(jobDir, 'shots', 's1', 'first_frame.png');
    const snapBytes = readFileSync(snapPath);
    expect(snapBytes.subarray(8).toString()).toBe('v2-mutated'); // the mutation landed in the snapshot
    const expectHash = createHash('sha256').update(snapBytes).digest('hex');
    // Hashing the validated source bytes ('v1-original') would fail here.
    expect(manifest.frameHashes[join('shots', 's1', 'first_frame.png')]).toBe(expectHash);
  });
});
