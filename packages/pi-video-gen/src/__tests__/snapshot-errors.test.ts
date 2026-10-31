import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyFailure = vi.hoisted(() => ({
  destinationMarker: '',
  code: 'ENOSPC',
  sourceLookupCode: '',
  sourceLookupPath: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn(async (src: string, dest: string, mode?: number) => {
      if (dest.includes(copyFailure.destinationMarker)) {
        if (copyFailure.sourceLookupCode) copyFailure.sourceLookupPath = src;
        throw Object.assign(new Error('destination copy failed'), { code: copyFailure.code });
      }
      return actual.copyFile(src, dest, mode);
    }),
    lstat: vi.fn(async (path: string) => {
      if (path === copyFailure.sourceLookupPath) {
        throw Object.assign(new Error('source lookup failed'), {
          code: copyFailure.sourceLookupCode,
        });
      }
      return actual.lstat(path);
    }),
  };
});

vi.mock('node:stream/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:stream/promises')>();
  const pipeline = actual.pipeline as unknown as (...streams: unknown[]) => Promise<void>;
  return {
    ...actual,
    pipeline: vi.fn(async (...streams: unknown[]) => {
      const destination = streams.at(-1) as { path?: string; destroy(error: Error): void };
      const copying = pipeline(...streams);
      if (destination.path?.includes(copyFailure.destinationMarker)) {
        // Let the real pipeline own stream cleanup even when the destination fails.
        destination.destroy(
          Object.assign(new Error('destination copy failed'), { code: copyFailure.code }),
        );
      }
      return copying;
    }),
  };
});

import { runCompose } from '../compose.js';
import { ActiveJobs } from '../jobs/store.js';
import { runTimeline } from '../timeline-render.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-snapshot-errors');

describe('snapshot destination errors', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    copyFailure.destinationMarker = '';
    copyFailure.code = 'ENOSPC';
    copyFailure.sourceLookupCode = '';
    copyFailure.sourceLookupPath = '';
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not misreport a compose destination failure as an unreadable clip', async () => {
    const jobDir = join(cwd, '.video-gen', 'compose-disk-full');
    const first = join(cwd, 'first.mp4');
    const second = join(cwd, 'second.mp4');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    const specPath = join(jobDir, 'compose-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        clips: [
          { id: 'first', path: first },
          { id: 'second', path: second },
        ],
      }),
    );
    copyFailure.destinationMarker = '.clips-staging-';

    await expect(
      runCompose({
        composeSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('preserves destination ENOENT when the compose source still exists', async () => {
    const jobDir = join(cwd, '.video-gen', 'compose-missing-destination');
    const first = join(cwd, 'first.mp4');
    const second = join(cwd, 'second.mp4');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    const specPath = join(jobDir, 'compose-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        clips: [
          { id: 'first', path: first },
          { id: 'second', path: second },
        ],
      }),
    );
    copyFailure.destinationMarker = '.clips-staging-';
    copyFailure.code = 'ENOENT';

    await expect(
      runCompose({
        composeSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an unexpected source lookup failure while classifying ENOENT', async () => {
    const jobDir = join(cwd, '.video-gen', 'compose-source-lookup-failure');
    const first = join(cwd, 'first.mp4');
    const second = join(cwd, 'second.mp4');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    const specPath = join(jobDir, 'compose-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        clips: [
          { id: 'first', path: first },
          { id: 'second', path: second },
        ],
      }),
    );
    copyFailure.destinationMarker = '.clips-staging-';
    copyFailure.code = 'ENOENT';
    copyFailure.sourceLookupCode = 'EACCES';

    await expect(
      runCompose({
        composeSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('does not misreport a timeline destination failure as an unreadable image', async () => {
    const jobDir = join(cwd, '.video-gen', 'timeline-disk-full');
    const image = join(cwd, 'image.png');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(image, 'image');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 'first', image, durationSec: 1 }] }));
    copyFailure.destinationMarker = '.assets-staging-';

    await expect(
      runTimeline({
        timelineSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('preserves destination ENOENT when the timeline image source still exists', async () => {
    const jobDir = join(cwd, '.video-gen', 'timeline-missing-destination');
    const image = join(cwd, 'image.png');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(image, 'image');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 'first', image, durationSec: 1 }] }));
    copyFailure.destinationMarker = '.assets-staging-';
    copyFailure.code = 'ENOENT';

    await expect(
      runTimeline({
        timelineSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not misreport a timeline destination failure as unreadable BGM', async () => {
    const jobDir = join(cwd, '.video-gen', 'timeline-bgm-disk-full');
    const image = join(cwd, 'image.png');
    const bgm = join(cwd, 'music.mp3');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(image, 'image');
    writeFileSync(bgm, 'music');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ bgm, segments: [{ id: 'first', image, durationSec: 1 }] }),
    );
    copyFailure.destinationMarker = 'bgm.mp3';

    await expect(
      runTimeline({
        timelineSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('preserves destination ENOENT when the BGM source still exists', async () => {
    const jobDir = join(cwd, '.video-gen', 'timeline-bgm-missing-destination');
    const image = join(cwd, 'image.png');
    const bgm = join(cwd, 'music.mp3');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(image, 'image');
    writeFileSync(bgm, 'music');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ bgm, segments: [{ id: 'first', image, durationSec: 1 }] }),
    );
    copyFailure.destinationMarker = 'bgm.mp3';
    copyFailure.code = 'ENOENT';

    await expect(
      runTimeline({
        timelineSpecPath: specPath,
        cwd,
        settings: {},
        activeJobs: new ActiveJobs(),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
