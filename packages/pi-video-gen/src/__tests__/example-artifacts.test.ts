import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
let dir: string;

describe('video-gen example package artifacts', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-video-gen-example-artifacts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ships editable example source without installed dependencies or generated audio', () => {
    copyFileSync(join(packageRoot, 'package.json'), join(dir, 'package.json'));
    const examples = 'skills/video-gen/examples';
    const demo = `${examples}/continuous-demo`;
    for (const path of [
      `${demo}/product/RequestWorkspace.tsx`,
      `${demo}/node_modules/local/index.js`,
      `${demo}/public/music.wav`,
      `${demo}/public/effects.wav`,
      `${demo}/public/score.wav`,
      `${demo}/public/audio-report.json`,
    ]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), 'fixture');
    }
    const ignore = join(packageRoot, examples, '.npmignore');
    if (existsSync(ignore)) copyFileSync(ignore, join(dir, examples, '.npmignore'));
    const [pack] = JSON.parse(
      execFileSync(
        'npm',
        [
          'pack',
          '--dry-run',
          '--json',
          '--ignore-scripts',
          '--offline',
          '--cache',
          join(dir, 'cache'),
        ],
        { cwd: dir, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 },
      ),
    ) as Array<{
      files: Array<{ path: string }>;
    }>;
    expect(
      pack!.files.map((file) => file.path).filter((path) => path.startsWith('skills/')),
    ).toEqual([`${demo}/product/RequestWorkspace.tsx`]);
  });
});
