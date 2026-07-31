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
    expect(publishWorkflow).toContain('runner: ubuntu-22.04');
    expect(publishWorkflow).toContain('Verify FFmpeg binary');
    expect(publishWorkflow).toContain('vtool -show-build');
    expect(publishWorkflow).not.toContain('vars.X264_SHA256');
    expect(publishWorkflow).toContain('timeline-smoke');
    expect(publishWorkflow).toContain('timeline-smoke.jpg');
    expect(publishWorkflow).toContain('atrim=0:0.2');
    expect(publishWorkflow).toContain('zoompan=');
    expect(publishWorkflow).toContain('xfade=');
    expect(publishWorkflow).toContain('overlay=');
    expect(publishWorkflow).toContain('concat=n=2:v=0:a=1');
    expect(publishWorkflow).toContain('amix=inputs=2');
    expect(publishWorkflow).toContain('mov_text');
    expect(publishWorkflow).toContain('timeline-smoke-qc.png');
    expect(publishWorkflow).toContain('mixed-media-smoke');
    expect(publishWorkflow).toContain('volume=0.5[src]');
    expect(publishWorkflow).toContain('duration=first:normalize=0');
    expect(publishWorkflow).toContain('alimiter=limit=0.95:level=false');
    expect(publishWorkflow).toContain('libx264');
  });

  it('executes cross-compiled release binaries before publishing them', () => {
    expect(publishWorkflow).toContain('qemu-aarch64 -L /usr/aarch64-linux-gnu "$bin" -version');
    expect(publishWorkflow).toContain(`WINEDEBUG=-all /usr/lib/wine/wine64 "\${bin}.exe" -version`);
    expect(publishWorkflow).toContain(`probe="\${bin%/*}/ffprobe"`);
    expect(publishWorkflow).toContain(`gpl_probe="\${gpl%/*}/ffprobe-gpl"`);
    expect(publishWorkflow).not.toContain(`\${bin/ffmpeg/ffprobe}`);
    expect(publishWorkflow).not.toContain(`\${gpl/ffmpeg/ffprobe}`);
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
