import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const script = fileURLToPath(new URL('./build-typescript.mjs', import.meta.url));

test('builds workspace projects without shell expansion and preserves compiler failures', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-typescript-build-'));
  try {
    for (const name of ['first', 'package with spaces', 'pi-browser-use']) {
      const directory = path.join(cwd, 'packages', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { composite: true, outDir: 'dist', types: [] },
        files: ['index.ts'],
      }));
      writeFileSync(path.join(directory, 'index.ts'), 'export const answer: number = 42;');
    }

    const browser = path.join(cwd, 'packages/pi-browser-use');
    mkdirSync(path.join(browser, 'scripts'));
    writeFileSync(path.join(browser, 'scripts/prepare-tool-categories.mjs'),
      'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../dist/tool-categories.json", import.meta.url), "fixture snapshot");');
    const snapshot = path.join(browser, 'dist/tool-categories.json');
    const run = (...args) => spawnSync(process.execPath, [script, '--pretty', 'false', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const success = run();
    assert.equal(success.status, 0, success.stdout + success.stderr);
    assert.equal(readFileSync(snapshot, 'utf8'), 'fixture snapshot');
    rmSync(snapshot);
    const clean = run('--clean');
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(existsSync(snapshot), false);
    const rebuilt = run();
    assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr);
    for (const name of ['first', 'package with spaces']) {
      assert.match(readFileSync(path.join(cwd, 'packages', name, 'dist/index.d.ts'), 'utf8'), /answer: number/);
    }

    writeFileSync(path.join(cwd, 'packages/first/index.ts'), 'export const answer: number = "wrong";');
    rmSync(snapshot);
    const failure = run();
    assert.notEqual(failure.status, 0);
    assert.match(failure.stdout + failure.stderr, /TS2322/);
    assert.equal(existsSync(snapshot), false);
    writeFileSync(path.join(cwd, 'packages/first/index.ts'), 'export const answer: number = 42;');
    rmSync(browser, { recursive: true });
    const withoutBrowser = run();
    assert.equal(withoutBrowser.status, 0, withoutBrowser.stdout + withoutBrowser.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
// Five real compiler processes run sequentially; allow for shared CI CPU contention.
}, 30_000);
