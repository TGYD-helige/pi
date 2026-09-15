#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(join(packageRoot, 'driver-release.json'), 'utf8'));
const target = process.argv[2] ?? (process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`);
const artifact = release.targets[target];
if (!artifact) throw new Error(`Unsupported Cua Driver target: ${target}`);

const work = mkdtempSync(join(tmpdir(), `pi-cua-driver-${target}-`));
try {
  const archive = join(work, artifact.asset);
  const response = await fetch(`https://github.com/trycua/cua/releases/download/${release.tag}/${artifact.asset}`);
  if (!response.ok) throw new Error(`Cua Driver download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256) throw new Error(`Cua Driver checksum mismatch for ${target}.`);
  writeFileSync(archive, bytes);

  const unpacked = join(work, 'unpacked');
  mkdirSync(unpacked);
  if (artifact.asset.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archive, '-d', unpacked]);
  } else {
    execFileSync('tar', ['-xf', artifact.asset, '-C', 'unpacked'], { cwd: work });
  }

  const sourceRoot = join(unpacked, readdirSync(unpacked)[0]);
  const packageBin = join(packageRoot, 'platforms', `cua-driver-${target}`, 'bin');
  rmSync(packageBin, { recursive: true, force: true });
  mkdirSync(packageBin, { recursive: true });

  const entries = target === 'darwin-universal'
    ? ['CuaDriver.app']
    : target.startsWith('win32-')
      ? ['cua-driver.exe', 'cua-driver-uia.exe', 'cua-cursor-theme.exe']
      : ['cua-driver', 'cua-cursor-theme', 'wayland-helper'];
  for (const entry of entries) cpSync(join(sourceRoot, entry), join(packageBin, basename(entry)), { recursive: true });
  writeFileSync(join(packageBin, '.version'), `${release.tag}\n`);
  process.stdout.write(`${packageBin}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
