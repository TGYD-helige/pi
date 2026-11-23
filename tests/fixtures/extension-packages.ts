import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const packagesDir = resolve(import.meta.dirname, '../../packages');
export const extensionPackageNames = globSync('pi-*/package.json', { cwd: packagesDir })
  .map(dirname)
  .sort();

export function extensionSourcePaths(packageName: string): string[] {
  const packageDir = join(packagesDir, packageName);
  const { pi } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const entries: string[] = pi?.extensions;
  assert(Array.isArray(entries) && entries.length > 0, `${packageName} must declare pi.extensions`);

  return entries.map((entry) =>
    join(packageDir, entry.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')),
  );
}
