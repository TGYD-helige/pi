#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const hostDriverTarget = process.platform === 'darwin'
  ? 'darwin-universal'
  : `${process.platform}-${process.arch}`;

export function generateToolManifest(packageBin, target, driverVersion) {
  const binaryPath = target === 'darwin-universal'
    ? join(packageBin, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver')
    : join(packageBin, target.startsWith('win32-') ? 'cua-driver.exe' : 'cua-driver');

  // This metadata command works without a daemon or an interactive desktop.
  const { version, tools } = JSON.parse(execFileSync(binaryPath, ['dump-docs', '--type', 'mcp'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }));
  if (version !== driverVersion) {
    throw new Error(`Expected Cua Driver ${driverVersion}, received ${version}.`);
  }
  if (
    !Array.isArray(tools) ||
    tools.length === 0 ||
    tools.some((tool) =>
      typeof tool?.name !== 'string' ||
      (tool.description !== undefined && typeof tool.description !== 'string') ||
      tool.input_schema?.type !== 'object'
    )
  ) {
    throw new Error('Cua Driver exported an invalid tool catalog.');
  }

  const manifest = {
    driverVersion: version,
    generatedFrom: target,
    tools: tools.map(({ name, description, input_schema }) => ({ name, description, inputSchema: input_schema })),
  };
  writeFileSync(join(packageBin, 'tools.json'), `${JSON.stringify(manifest)}\n`);
  process.stdout.write(`Generated ${tools.length} tools for ${target} from Cua Driver ${version}.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const release = JSON.parse(readFileSync(join(packageRoot, 'driver-release.json'), 'utf8'));
  if (!Object.hasOwn(release.targets, hostDriverTarget)) {
    throw new Error(`Unsupported Cua Driver target: ${hostDriverTarget}`);
  }
  const packageBin = join(packageRoot, 'platforms', `cua-driver-${hostDriverTarget}`, 'bin');
  generateToolManifest(packageBin, hostDriverTarget, release.version);
}
