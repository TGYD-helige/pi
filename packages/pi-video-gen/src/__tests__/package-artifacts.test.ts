import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const platformsRoot = join(packageRoot, 'platforms');
const publishWorkflow = readFileSync(
  join(packageRoot, '..', '..', '.github', 'workflows', 'npm-publish.yml'),
  'utf-8',
);
const ffmpegBuildWorkflow = readFileSync(
  join(packageRoot, '..', '..', '.github', 'workflows', 'ffmpeg-build.yml'),
  'utf-8',
);
const mainPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
  files: string[];
  optionalDependencies?: Record<string, string>;
};

const targets = [
  { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64', executable: 'ffmpeg' },
  { suffix: 'darwin-x64', os: 'darwin', cpu: 'x64', executable: 'ffmpeg' },
  {
    suffix: 'linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    executable: 'ffmpeg',
    libc: ['glibc'],
  },
  { suffix: 'linux-x64', os: 'linux', cpu: 'x64', executable: 'ffmpeg', libc: ['glibc'] },
  { suffix: 'win32-x64', os: 'win32', cpu: 'x64', executable: 'ffmpeg.exe' },
] as const;

describe('pi-video-gen package artifacts', () => {
  it('ships the Seedance public material Asset ID catalog', () => {
    const catalog = readFileSync(
      join(packageRoot, 'skills', 'video-gen', 'references', 'seedance-public-material-library.md'),
      'utf-8',
    );
    const assetIds = catalog.match(/asset-[0-9]{14}-[a-z0-9]+/g) ?? [];

    expect(assetIds).toHaveLength(187);
    expect(new Set(assetIds).size).toBe(assetIds.length);
    expect(catalog).toContain('| 东北大花袄 | `asset-');
    expect(catalog).toContain('| 华尔兹 | `asset-');
    expect(catalog).toContain('| 少年_少女-女-少儿故事 | 11.4s | `asset-');
    expect(catalog).toContain('search it through the persona workflow');
  });

  it('ships the complete structured Seedance persona catalog', () => {
    const personas = JSON.parse(
      readFileSync(
        join(packageRoot, 'skills', 'video-gen', 'references', 'seedance-personas.json'),
        'utf8',
      ),
    ) as Array<{
      group_id: string;
      人物标签: string;
      人物小传: string;
      assets: { 半身像?: string; 全身照?: string };
    }>;

    expect(personas).toHaveLength(8741);
    expect(new Set(personas.map((persona) => persona.group_id)).size).toBe(8741);
    expect(personas.filter((persona) => persona.assets.半身像).length).toBe(8741);
    expect(personas.filter((persona) => persona.assets.全身照).length).toBe(2696);
  });

  it('searches the bundled Seedance persona catalog with bounded output', () => {
    const script = join(
      packageRoot,
      'skills',
      'video-gen',
      'scripts',
      'search-seedance-personas.mjs',
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [script, '--query', '尼泊尔 青训营教练', '--framing', 'full', '--limit', '1'],
        { encoding: 'utf8' },
      ),
    ) as {
      totalMatches: number;
      returned: number;
      results: Array<{ label: string; selectedFraming: string; selectedAssetId: string }>;
    };

    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.returned).toBe(1);
    expect(result.results[0]).toMatchObject({
      label: '尼泊尔 53岁 男 青训营教练',
      selectedFraming: 'full',
      selectedAssetId: 'asset-20260804202332-vxhpn',
    });
  });

  it('installs FFmpeg through platform-specific optional packages', () => {
    const gitignore = readFileSync(join(packageRoot, '..', '..', '.gitignore'), 'utf-8');
    expect(mainPackage.files).not.toContain('bin');
    expect(gitignore).toContain('packages/pi-video-gen/platforms/ffmpeg-*/GPLv2.txt');
    expect(gitignore).toContain('packages/pi-video-gen/platforms/ffmpeg-*/ZLIB_LICENSE.txt');
    expect(mainPackage.optionalDependencies).toEqual(
      Object.fromEntries(
        targets.map(({ suffix }) => [`@amaster.ai/pi-video-gen-ffmpeg-${suffix}`, 'workspace:*']),
      ),
    );
  });

  it('builds every platform from pinned source archives', () => {
    const script = readFileSync(join(packageRoot, 'scripts', 'build-ffmpeg.sh'), 'utf-8');
    expect(script).toContain('FFMPEG_SHA256=');
    expect(script).toContain(
      'ZLIB_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16',
    );
    expect(script).toContain(
      'X264_SHA256=cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9',
    );
    expect(script).not.toContain('X264_SHA256="${X264_SHA256:');
    expect(script).toContain('--disable-autodetect');
    expect(script).toContain('--disable-everything');
    expect(script).toContain('wrapped_avframe');
    expect(script).toContain('pcm_u8');
    expect(script).toMatch(/--enable-decoder=[^\n]*mjpeg/);
    expect(script).toMatch(/--enable-decoder=[^\n]*webp/);
    expect(script).toMatch(/--enable-decoder=[^\n]*gif/);
    expect(script).toMatch(/--enable-filter=[^\n]*alimiter/);
    expect(script).toContain('MACOSX_DEPLOYMENT_TARGET=11.0');
    expect(script).toMatch(/linux-arm64\)[\s\S]*--pkg-config=pkg-config/);
    expect(script).toMatch(/win32-x64\)[\s\S]*--pkg-config=pkg-config/);
    // Base (LGPL) build has NO third-party codec libs; the opt-in GPL_VARIANT
    // branch may add libx264 only inside its own guarded section.
    const gplMarker =
      'if [ "' +
      String.fromCharCode(36) +
      '{GPL_VARIANT:-' +
      String.fromCharCode(125) +
      '" = "1" ]; then';
    const baseSection = script.split(gplMarker)[0]!;
    expect(baseSection).not.toMatch(/--enable-lib[a-z0-9]/);
    for (const { suffix } of targets) expect(script).toContain(`${suffix})`);
  });

  it('builds against declared platform baselines and verifies release binaries', () => {
    expect(ffmpegBuildWorkflow).toContain('fail-fast: false');
    expect(ffmpegBuildWorkflow).toContain('runner: ubuntu-22.04');
    expect(ffmpegBuildWorkflow).toMatch(/- target: win32-x64\n\s+runner: ubuntu-22\.04/);
    expect(ffmpegBuildWorkflow).not.toContain('sudo -n');
    expect(ffmpegBuildWorkflow).toContain('docker run --detach');
    expect(ffmpegBuildWorkflow).toContain('ubuntu:22.04 sleep infinity');
    expect(ffmpegBuildWorkflow).toContain('docker exec --user');
    expect(ffmpegBuildWorkflow).toContain('gcc gcc-mingw-w64-x86-64');
    expect(ffmpegBuildWorkflow).toContain('libc6-dev');
    expect(ffmpegBuildWorkflow).toContain('/tmp/runner-home');
    expect(ffmpegBuildWorkflow).toContain('/usr/lib/wine/wine64');
    expect(ffmpegBuildWorkflow).toContain('Verify FFmpeg binary');
    expect(ffmpegBuildWorkflow).toContain('vtool -show-build');
    expect(ffmpegBuildWorkflow).not.toContain('vars.X264_SHA256');
    expect(ffmpegBuildWorkflow).toContain('timeline-smoke');
    expect(ffmpegBuildWorkflow).not.toContain('timeline-smoke.jpg');
    expect(ffmpegBuildWorkflow).toContain('-i packages/pi-video-gen/preview.png');
    expect(ffmpegBuildWorkflow).toContain('-nostdin -xerror');
    expect(ffmpegBuildWorkflow).toContain('atrim=0:0.2');
    expect(ffmpegBuildWorkflow).toContain('zoompan=');
    expect(ffmpegBuildWorkflow).toContain('xfade=');
    expect(ffmpegBuildWorkflow).toContain('overlay=');
    expect(ffmpegBuildWorkflow).toContain('concat=n=2:v=0:a=1');
    expect(ffmpegBuildWorkflow).toContain('amix=inputs=2');
    expect(ffmpegBuildWorkflow).toContain('mov_text');
    expect(ffmpegBuildWorkflow).toContain('timeline-smoke-qc.png');
    expect(ffmpegBuildWorkflow).toContain('mixed-media-smoke');
    expect(ffmpegBuildWorkflow).toContain('volume=0.5[src]');
    expect(ffmpegBuildWorkflow).toContain('duration=first:normalize=0');
    expect(ffmpegBuildWorkflow).toContain('alimiter=limit=0.95:level=false');
    expect(ffmpegBuildWorkflow).toContain('libx264');
  });

  it('executes cross-compiled release binaries before publishing them', () => {
    expect(ffmpegBuildWorkflow).toContain('qemu-aarch64 -L /usr/aarch64-linux-gnu "$bin" -version');
    expect(ffmpegBuildWorkflow).toContain(
      `run_win_container /usr/lib/wine/wine64 "\${bin}.exe" -version`,
    );
    expect(ffmpegBuildWorkflow).toContain(`probe="\${bin%/*}/ffprobe"`);
    expect(ffmpegBuildWorkflow).toContain(`gpl_probe="\${gpl%/*}/ffprobe-gpl"`);
    expect(ffmpegBuildWorkflow).not.toContain(`\${bin/ffmpeg/ffprobe}`);
    expect(ffmpegBuildWorkflow).not.toContain(`\${gpl/ffmpeg/ffprobe}`);
  });

  it('publishes FFmpeg platform packages from the dedicated ffmpeg-build workflow only', () => {
    // ffmpeg-build.yml builds the binaries and publishes the five platform
    // packages at their committed versions. npm-publish.yml never builds
    // FFmpeg itself: it may invoke ffmpeg-build.yml as a reusable workflow
    // (build_ffmpeg input), and otherwise reuses the committed platform
    // versions already published on npm.
    expect(ffmpegBuildWorkflow).toContain('workflow_dispatch');
    expect(ffmpegBuildWorkflow).toContain('workflow_call');
    expect(ffmpegBuildWorkflow).toContain('packages/pi-video-gen/scripts/**');
    expect(ffmpegBuildWorkflow).toContain('packages/pi-video-gen/platforms/**');
    expect(ffmpegBuildWorkflow).toContain('pnpm publish --access public --no-git-checks');
    expect(publishWorkflow).not.toContain('build-video-ffmpeg');
    expect(publishWorkflow).not.toContain('pi-video-gen-ffmpeg-');
    expect(publishWorkflow).not.toContain('platformPackageFiles');
    expect(publishWorkflow).toContain('Verify FFmpeg platform packages are published');
    expect(publishWorkflow).toContain('Unpack published FFmpeg binaries for checks');
    expect(publishWorkflow).toContain('npm pack "${name}@${version}" --silent');
    expect(publishWorkflow).toContain('build_ffmpeg');
    expect(publishWorkflow).toContain('uses: ./.github/workflows/ffmpeg-build.yml');
  });

  for (const target of targets) {
    it(`publishes the ${target.suffix} FFmpeg executables for ${target.os}/${target.cpu}`, () => {
      const packageJson = JSON.parse(
        readFileSync(join(platformsRoot, `ffmpeg-${target.suffix}`, 'package.json'), 'utf-8'),
      ) as {
        license: string;
        os: string[];
        cpu: string[];
        libc?: string[];
        files: string[];
        bin?: Record<string, string>;
        publishConfig: { executableFiles: string[] };
        exports: Record<string, string>;
      };

      expect(packageJson.os).toEqual([target.os]);
      expect(packageJson.cpu).toEqual([target.cpu]);
      expect(packageJson.libc).toEqual('libc' in target ? target.libc : undefined);
      expect(packageJson.license).toBe('SEE LICENSE IN SOURCE.md');
      expect(packageJson.files).toEqual([
        'bin',
        'LICENSE',
        'GPLv2.txt',
        'ZLIB_LICENSE.txt',
        'SOURCE.md',
        'source',
      ]);
      expect(packageJson.bin).toBeUndefined();
      const probeExecutable = target.executable === 'ffmpeg.exe' ? 'ffprobe.exe' : 'ffprobe';
      const gplExecutable = target.executable === 'ffmpeg.exe' ? 'ffmpeg-gpl.exe' : 'ffmpeg-gpl';
      const gplProbeExecutable =
        target.executable === 'ffmpeg.exe' ? 'ffprobe-gpl.exe' : 'ffprobe-gpl';
      expect(packageJson.publishConfig.executableFiles).toEqual([
        `./bin/${target.executable}`,
        `./bin/${probeExecutable}`,
        `./bin/${gplExecutable}`,
        `./bin/${gplProbeExecutable}`,
      ]);
      expect(packageJson.exports).toEqual({
        './ffmpeg': `./bin/${target.executable}`,
        './ffprobe': `./bin/${probeExecutable}`,
      });
    });
  }
});
