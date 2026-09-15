#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CuaDriverClient } from '../dist/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(join(packageRoot, 'driver-release.json'), 'utf8'));
const target = process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`;
const packageBin = join(packageRoot, 'platforms', `cua-driver-${target}`, 'bin');
const binaryPath = process.argv[2] ?? (process.platform === 'darwin'
  ? join(packageBin, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver')
  : join(packageBin, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'));
const reportedVersion = execFileSync(binaryPath, ['--version'], { encoding: 'utf8' }).trim();
if (!reportedVersion.endsWith(` ${release.version}`)) throw new Error(`Expected Cua Driver ${release.version}, received ${reportedVersion}.`);

const client = new CuaDriverClient({ mode: 'path', binaryPath });
try {
  const tools = await client.listAllTools();
  const manifest = { driverVersion: release.version, generatedFrom: target, tools };
  const source = `// biome-ignore-all format: Generated from Cua Driver Rust ${release.version} tools/list. Do not edit manually.\nexport default ${JSON.stringify(manifest, null, 2)} as const;\n`;
  writeFileSync(join(packageRoot, 'src', 'generated', 'cua-driver-tools.ts'), source);
  process.stdout.write(`Generated ${tools.length} tools from ${reportedVersion}.\n`);
} finally {
  await client.close();
}
