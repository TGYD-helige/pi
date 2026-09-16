import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const script = fileURLToPath(new URL('./build-typescript.mjs', import.meta.url));

test('builds workspace projects without shell expansion and preserves compiler failures', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-typescript-build-'));
  try {
    for (const name of ['first', 'package with spaces']) {
      const directory = path.join(cwd, 'packages', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { composite: true, outDir: 'dist', types: [] },
        files: ['index.ts'],
      }));
      writeFileSync(path.join(directory, 'index.ts'), 'export const answer: number = 42;');
    }

    const run = () => spawnSync(process.execPath, [script, '--pretty', 'false'], {
      cwd,
      encoding: 'utf8',
    });
    const success = run();
    assert.equal(success.status, 0, success.stdout + success.stderr);
    for (const name of ['first', 'package with spaces']) {
      assert.match(readFileSync(path.join(cwd, 'packages', name, 'dist/index.d.ts'), 'utf8'), /answer: number/);
    }

    writeFileSync(path.join(cwd, 'packages/first/index.ts'), 'export const answer: number = "wrong";');
    const failure = run();
    assert.notEqual(failure.status, 0);
    assert.match(failure.stdout + failure.stderr, /TS2322/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
