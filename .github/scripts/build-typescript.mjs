import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Expand projects in Node: Windows package-script shells do not expand globs.
const projects = globSync('packages/*/tsconfig.json').sort();
const result = spawnSync(process.execPath, [
  createRequire(import.meta.url).resolve('typescript/bin/tsc'),
  '-b',
  ...projects,
  ...process.argv.slice(2),
], { stdio: 'inherit' });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!process.argv.includes('--clean') && projects.some((project) =>
  resolve(project) === resolve('packages/pi-browser-use/tsconfig.json'))) {
  await import(pathToFileURL(resolve('packages/pi-browser-use/scripts/prepare-tool-categories.mjs')).href);
}
