import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { VideoGenError } from './errors.js';
import type { ProjectSpec } from './project-render.js';

export async function resolveHyperframesProject(spec: ProjectSpec, projectDir: string) {
  const entryPoint = await realpath(join(projectDir, spec.entryPoint ?? 'index.html')).catch(
    () => null,
  );
  if (!entryPoint?.startsWith(`${projectDir}${sep}`) || !(await stat(entryPoint)).isFile())
    throw new VideoGenError(
      'HyperFrames entryPoint must be an HTML file inside the trusted project.',
      'hyperframes: entry',
    );
  if ((await stat(entryPoint)).size > 5 * 1024 * 1024)
    throw new VideoGenError(
      'HyperFrames HTML entry must not exceed 5 MB.',
      'hyperframes: entry size',
    );
  if (!entryPoint.endsWith('.html'))
    throw new VideoGenError(
      'HyperFrames entryPoint must be an HTML file.',
      'hyperframes: entry type',
    );
  const cli = join(projectDir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
  if (!existsSync(cli))
    throw new VideoGenError(
      'Install hyperframes locally in the video project before rendering.',
      'hyperframes: cli missing',
    );
  const browserExecutable =
    spec.browserExecutable ??
    process.env.HYPERFRAMES_BROWSER_PATH ??
    [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].find(existsSync);
  if (!browserExecutable || !(await stat(browserExecutable).catch(() => null))?.isFile())
    throw new VideoGenError(
      'An installed Chrome/Chromium is required. Set browserExecutable or HYPERFRAMES_BROWSER_PATH; no browser is downloaded.',
      'hyperframes: browser missing',
    );
  return { projectDir, entryPoint, browserExecutable };
}

// The CLI runs only against a job-owned snapshot; it cannot rewrite the editable source project.
export const hyperframesRunner = String.raw`
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {readFile, writeFile, stat} = require('node:fs/promises');
const {join, relative, dirname, isAbsolute} = require('node:path');
let stage = 19;
(async () => {
  const x = JSON.parse(process.argv[1]);
  const cli = join(x.projectDir, 'node_modules/hyperframes/bin/hyperframes.mjs');
  const entry = relative(x.projectDir, x.entryPoint);
  const shotTimes = x.spec.shotTimesSec;
  if (x.shotIds && (!shotTimes || x.shotIds.some(id => !Number.isFinite(shotTimes[id]) || shotTimes[id] < 0 || shotTimes[id] >= x.spec.durationSec))) {
    stage = 21; throw new Error('shotTimesSec required');
  }
  const assets = Object.fromEntries(Object.entries(x.inputProps.videoGenAssets).map(([id, path]) => [id, '/' + path]));
  const payload = JSON.stringify(assets).replace(/</g, '\\u003c');
  const entryPath = join(x.publicDir, entry);
  if ((await stat(entryPath)).size > 5*1024*1024) throw new Error('HTML entry exceeds 5 MB');
  let html = await readFile(entryPath, 'utf8');
  const base = entry !== 'index.html' && !/<base\b/i.test(html)
    ? '<base href="/' + dirname(entry).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/') + '/">' : '';
  const bootstrap = base + '<script>window.videoGenAssets=' + payload + ';</script>';
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, match => match + bootstrap);
  else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, match => match + '<head>' + bootstrap + '</head>');
  else html = html.replace(/^(\s*<!doctype[^>]*>)?/i, match => match + '<head>' + bootstrap + '</head>');
  await writeFile(join(x.publicDir, 'index.html'), html);
  const env = {...process.env, HYPERFRAMES_BROWSER_PATH: x.browserExecutable, HYPERFRAMES_FFMPEG_PATH: isAbsolute(x.ffmpegPath) ? x.ffmpegPath : undefined, HYPERFRAMES_FFPROBE_PATH: isAbsolute(x.ffprobePath) ? x.ffprobePath : undefined, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1'};
  stage = 24;
  const {stdout} = await promisify(execFile)(process.execPath, [cli, 'info', x.publicDir, '--json'], {cwd:x.publicDir, env, maxBuffer:64*1024, timeout:30000});
  const duration = JSON.parse(stdout).duration;
  if (!Number.isFinite(duration) || Math.abs(duration - x.spec.durationSec) > 0.001) throw new Error('HTML duration mismatch');
  const args = x.mode === 'preflight'
    ? ['snapshot', x.publicDir, '--at', '0', '--no-end', '--output', join(x.publicDir, '.pi-preflight'), '--json']
    : ['render', x.publicDir, '--output', x.output, '--format', 'mp4', '--workers', '1', '--experimental-fast-capture=false'];
  stage = x.mode === 'preflight' ? 22 : 23;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {cwd: x.publicDir, env, stdio: 'ignore'});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('HyperFrames CLI failed')));
  });
  if (x.metadataPath && x.shotIds) await writeFile(x.metadataPath, JSON.stringify(Object.fromEntries(x.shotIds.map(id => [id, shotTimes[id]]))));
})().catch(() => {process.exitCode = stage;});`;
