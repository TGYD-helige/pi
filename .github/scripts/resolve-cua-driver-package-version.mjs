import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported platform package version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function selectCuaDriverPackageVersion(baseVersion, driverVersion, releases) {
  const base = parseVersion(baseVersion);
  const line = releases
    .map((release) => ({ ...release, parsed: parseVersion(release.version) }))
    .filter(({ parsed }) => parsed.major === base.major && parsed.minor === base.minor)
    .sort((left, right) => right.parsed.patch - left.parsed.patch);
  const existing = line.find((release) => release.cuaDriverVersion === driverVersion);
  if (existing) return existing.version;
  return `${base.major}.${base.minor}.${Math.max(base.patch, line[0]?.parsed.patch ?? 0) + 1}`;
}

function npmView(packageSpec, field) {
  const output = execFileSync('npm', ['view', packageSpec, field, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  return output ? JSON.parse(output) : undefined;
}

function main() {
  const [packageName, baseVersion, driverVersion] = process.argv.slice(2);
  if (!packageName || !baseVersion || !driverVersion) {
    throw new Error('Usage: resolve-cua-driver-package-version.mjs <package> <base-version> <driver-version>');
  }
  const versions = npmView(packageName, 'versions');
  const releases = (Array.isArray(versions) ? versions : versions ? [versions] : []).map((version) => ({
    version,
    cuaDriverVersion: npmView(`${packageName}@${version}`, 'cuaDriverVersion'),
  }));
  console.log(selectCuaDriverPackageVersion(baseVersion, driverVersion, releases));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
