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
process.exit(result.status ?? 1);
