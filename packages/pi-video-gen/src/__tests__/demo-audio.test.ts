import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const example = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../skills/video-gen/examples/continuous-demo',
);
let dir: string;

describe('continuous-demo audio preparation', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-video-gen-demo-audio-'));
    for (const file of ['prepare-audio.mjs', 'timing.mjs'])
      copyFileSync(join(example, file), join(dir, file));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exports reproducible music and effects stems whose mix preserves the calibrated landings', () => {
    const prepare = () => execFileSync(process.execPath, [join(dir, 'prepare-audio.mjs')]);
    prepare();
    const music = readFileSync(join(dir, 'public/music.wav'));
    const effects = readFileSync(join(dir, 'public/effects.wav'));
    const score = readFileSync(join(dir, 'public/score.wav'));
    expect(music.length).toBe(44 + 26 * 48000 * 4);
    expect(effects.length).toBe(music.length);
    expect(score.length).toBe(music.length);
    let maxMixError = 0;
    for (let offset = 44; offset < score.length; offset += 2)
      maxMixError = Math.max(
        maxMixError,
        Math.abs(
          music.readInt16LE(offset) + effects.readInt16LE(offset) - score.readInt16LE(offset),
        ),
      );
    expect(maxMixError).toBeLessThanOrEqual(1);
    for (const at of [4.2, 7.6, 11, 14.8, 18.5, 22.8]) {
      const center = Math.round(at * 48000);
      let peakFrame = center - 2400;
      for (let frame = center - 2400; frame < center + 2400; frame++)
        if (
          Math.abs(effects.readInt16LE(44 + frame * 4)) >
          Math.abs(effects.readInt16LE(44 + peakFrame * 4))
        )
          peakFrame = frame;
      expect(Math.abs(peakFrame - center)).toBeLessThanOrEqual(1);
    }
    prepare();
    expect(readFileSync(join(dir, 'public/score.wav')).equals(score)).toBe(true);
  });
});
