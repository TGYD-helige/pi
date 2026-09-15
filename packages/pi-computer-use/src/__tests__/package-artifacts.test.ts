import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(packageRoot, '..', '..');
const platformsRoot = join(packageRoot, 'platforms');
const mainPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  files: string[];
  scripts: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const release = JSON.parse(readFileSync(join(packageRoot, 'driver-release.json'), 'utf8')) as {
  version: string;
  tag: string;
  targets: Record<string, { asset: string; sha256: string }>;
};

const targets = [
  { suffix: 'darwin-universal', os: 'darwin', cpu: undefined },
  { suffix: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: ['glibc'] },
  { suffix: 'linux-x64', os: 'linux', cpu: 'x64', libc: ['glibc'] },
  { suffix: 'win32-arm64', os: 'win32', cpu: 'arm64' },
  { suffix: 'win32-x64', os: 'win32', cpu: 'x64' },
] as const;

describe('pi-computer-use package artifacts', () => {
  it('installs Cua Driver through platform-specific optional packages', () => {
    expect(mainPackage.files).not.toContain('bin');
    expect(mainPackage.scripts.postinstall).toBeUndefined();
    expect(mainPackage.optionalDependencies).toEqual(
      Object.fromEntries(
        targets.map(({ suffix }) => [
          `@amaster.ai/pi-computer-use-cua-driver-${suffix}`,
          'workspace:*',
        ]),
      ),
    );
  });

  it('pins one verified upstream release for every platform', () => {
    expect(release.version).toBe('0.28.1');
    expect(release.tag).toBe('cua-driver-rs-v0.28.1');
    expect(Object.keys(release.targets).sort()).toEqual(targets.map(({ suffix }) => suffix).sort());
    for (const target of Object.values(release.targets)) {
      expect(target.asset).toContain('0.28.1');
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  for (const target of targets) {
    it(`publishes only the ${target.suffix} Cua Driver runtime`, () => {
      const pkg = JSON.parse(
        readFileSync(join(platformsRoot, `cua-driver-${target.suffix}`, 'package.json'), 'utf8'),
      ) as {
        name: string;
        version: string;
        cuaDriverVersion: string;
        os: string[];
        cpu?: string[];
        libc?: string[];
        files: string[];
        publishConfig: { executableFiles: string[] };
      };
      expect(pkg.name).toBe(`@amaster.ai/pi-computer-use-cua-driver-${target.suffix}`);
      expect(pkg.version).toBe('0.1.0');
      expect(pkg.cuaDriverVersion).toBe(release.version);
      expect(pkg.os).toEqual([target.os]);
      expect(pkg.cpu).toEqual(target.cpu ? [target.cpu] : undefined);
      expect(pkg.libc).toEqual('libc' in target ? target.libc : undefined);
      expect(pkg.files).toEqual(['bin', 'LICENSE.md', 'SOURCE.md']);
      expect(pkg.publishConfig.executableFiles.length).toBeGreaterThan(0);
    });
  }

  it('publishes platform runtimes before the main package', () => {
    const runtimeWorkflow = readFileSync(
      join(repoRoot, '.github', 'workflows', 'cua-driver-publish.yml'),
      'utf8',
    );
    const publishWorkflow = readFileSync(
      join(repoRoot, '.github', 'workflows', 'npm-publish.yml'),
      'utf8',
    );
    expect(runtimeWorkflow).toContain('workflow_call');
    expect(runtimeWorkflow).toContain('scripts/fetch-driver.mjs');
    expect(runtimeWorkflow).toContain('cuaDriverVersion');
    expect(runtimeWorkflow).toContain('bump the platform package version');
    expect(runtimeWorkflow).toContain('npm pack');
    expect(runtimeWorkflow).not.toContain('pnpm/action-setup');
    expect(runtimeWorkflow).toContain('npm publish');
    expect(publishWorkflow).toContain('publish_cua_driver');
    expect(publishWorkflow).toContain('uses: ./.github/workflows/cua-driver-publish.yml');
    expect(publishWorkflow).toContain('Verify native platform packages are published');
    expect(publishWorkflow).toContain('cuaDriverVersion');
    expect(publishWorkflow).toContain('driver-release.json');
  });
});
