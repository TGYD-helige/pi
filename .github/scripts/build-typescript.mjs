import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { createRequire } from 'node:module';

// Expand projects in Node: Windows package-script shells do not expand globs.
const result = spawnSync(process.execPath, [
  createRequire(import.meta.url).resolve('typescript/bin/tsc'),
  '-b',
  ...globSync('packages/*/tsconfig.json').sort(),
  ...process.argv.slice(2),
], { stdio: 'inherit' });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!process.argv.includes('--clean')) {
  await import('../../packages/pi-browser-use/scripts/prepare-tool-categories.mjs');
}
