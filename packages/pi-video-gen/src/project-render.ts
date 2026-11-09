import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { resolveOutputDir } from './config.js';
import { VideoGenError } from './errors.js';
import {
  probeStreams,
  probeVideoDuration,
  resolveFfprobe,
  resolveGplFfmpeg,
  runFfmpegCommand,
} from './ffmpeg.js';
import { hyperframesRunner, resolveHyperframesProject } from './hyperframes.js';
import {
  type ActiveJobs,
  assertSafeId,
  hashFileSha256,
  readJsonFile,
  writeJsonAtomic,
} from './jobs/store.js';
import type { VideoGenSettings } from './types.js';

export type ProjectEngine = 'hyperframes' | 'remotion';
export type ProjectSpec = {
  projectDir: string;
  entryPoint?: string;
  compositionId?: string;
  durationSec?: number;
  shotTimesSec?: Record<string, number>;
  assets?: Record<string, string>;
  inputProps?: Record<string, unknown>;
  browserExecutable?: string;
  qcTimesSec?: number[];
};

type ProjectManifest = {
  kind: ProjectEngine;
  fingerprint: string;
  finalVideoPath: string;
  finalVideoHash: string;
  shotTimesSec?: Record<string, number> | undefined;
  qcHashes?: Record<string, string> | undefined;
};
class ProjectCleanupError extends VideoGenError {}
const namespace = '__pi_video_gen__';
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const execFileAsync = promisify(execFile);

async function descendantGroups(rootPid: number, timeoutMs: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid, pgid]) =>
      [pid, ppid, pgid].every(
        (value) => value !== undefined && Number.isSafeInteger(value) && value > 0,
      ),
    );
  const family = new Set([rootPid]);
  let previousSize = 0;
  while (family.size !== previousSize) {
    previousSize = family.size;
    for (const [pid, ppid] of rows) if (family.has(ppid!)) family.add(pid!);
  }
  return [...new Set(rows.filter(([pid]) => family.has(pid!)).map(([, , pgid]) => pgid!))];
}

export function parseProjectSpec(raw: string, engine: ProjectEngine = 'hyperframes'): ProjectSpec {
  let spec: ProjectSpec;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw new VideoGenError(`${engine}-input.json is not valid JSON.`, 'project: json');
  }
  if (
    !spec ||
    typeof spec !== 'object' ||
    Array.isArray(spec) ||
    typeof spec.projectDir !== 'string' ||
    !isAbsolute(spec.projectDir) ||
    (engine === 'remotion' &&
      (typeof spec.compositionId !== 'string' || !spec.compositionId.trim()))
  )
    throw new VideoGenError(
      engine === 'remotion'
        ? 'Remotion spec requires absolute projectDir and compositionId.'
        : 'HyperFrames spec requires absolute projectDir.',
      'project: spec',
    );
  if (
    spec.entryPoint !== undefined &&
    (typeof spec.entryPoint !== 'string' ||
      isAbsolute(spec.entryPoint) ||
      spec.entryPoint.startsWith('..'))
  )
    throw new VideoGenError('Video project entryPoint must be project-relative.', 'project: entry');
  if (
    spec.assets !== undefined &&
    (!spec.assets || typeof spec.assets !== 'object' || Array.isArray(spec.assets))
  )
    throw new VideoGenError(
      'Video project assets must be an ID-to-path object.',
      'project: assets',
    );
  for (const [id, path] of Object.entries(spec.assets ?? {})) {
    assertSafeId(id, 'asset');
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new VideoGenError(
        `Video project asset "${id}" needs an absolute local path.`,
        'project: asset path',
      );
  }
  if (
    spec.qcTimesSec !== undefined &&
    (!Array.isArray(spec.qcTimesSec) ||
      spec.qcTimesSec.length > 32 ||
      spec.qcTimesSec.some(
        (time) => typeof time !== 'number' || !Number.isFinite(time) || time < 0,
      ))
  )
    throw new VideoGenError(
      'qcTimesSec must contain at most 32 finite, non-negative timestamps in seconds.',
      'project: qc times',
    );
  if (
    spec.inputProps !== undefined &&
    (!spec.inputProps ||
      typeof spec.inputProps !== 'object' ||
      Array.isArray(spec.inputProps) ||
      'videoGenAssets' in spec.inputProps)
  )
    throw new VideoGenError(
      'inputProps must be an object without reserved videoGenAssets.',
      'project: props',
    );
  if (engine === 'hyperframes') {
    if (
      typeof spec.durationSec !== 'number' ||
      !Number.isFinite(spec.durationSec) ||
      spec.durationSec <= 0
    )
      throw new VideoGenError(
        'HyperFrames durationSec must match the positive HTML composition duration.',
        'hyperframes: duration',
      );
    if (spec.qcTimesSec?.some((time) => time >= spec.durationSec!))
      throw new VideoGenError(
        'qcTimesSec must be within the composition duration.',
        'hyperframes: qc times',
      );
    if (
      spec.shotTimesSec !== undefined &&
      (!spec.shotTimesSec ||
        typeof spec.shotTimesSec !== 'object' ||
        Array.isArray(spec.shotTimesSec) ||
        Object.values(spec.shotTimesSec).some(
          (time) =>
            typeof time !== 'number' ||
            !Number.isFinite(time) ||
            time < 0 ||
            time >= spec.durationSec!,
        ))
    )
      throw new VideoGenError(
        'HyperFrames shotTimesSec must map shot IDs to times within durationSec.',
        'hyperframes: shot times',
      );
    if (spec.inputProps !== undefined)
      throw new VideoGenError(
        'HyperFrames uses HTML source and window.videoGenAssets; inputProps is Remotion-only.',
        'hyperframes: props',
      );
  }
  return spec;
}

async function projectFiles(
  dir: string,
  prefix = '',
  ignoreBuild = true,
  excludeDir?: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (ignoreBuild && !prefix && ['node_modules', '.git'].includes(entry.name)) continue;
    const rel = join(prefix, entry.name);
    if (join(dir, rel) === excludeDir) continue;
    if (entry.isSymbolicLink())
      throw new VideoGenError(`Video project contains a symlink: ${rel}.`, 'project: symlink');
    if (entry.isDirectory()) files.push(...(await projectFiles(dir, rel, ignoreBuild, excludeDir)));
    else if (entry.isFile()) files.push(rel);
    if (files.length > 10_000)
      throw new VideoGenError(
        'Video project exceeds 10000 files. Use a dedicated video project directory.',
        'project: file limit',
      );
  }
  return files.sort();
}

async function projectFingerprint(
  projectDir: string,
  excludedDir: string,
  engine: ProjectEngine,
): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of await projectFiles(projectDir, '', true, excludedDir)) {
    hash.update(rel);
    hash.update(await hashFileSha256(join(projectDir, rel)));
  }
  for (const name of engine === 'hyperframes'
    ? ['hyperframes']
    : ['remotion', '@remotion/bundler', '@remotion/renderer', 'react', 'react-dom']) {
    const packageFile = join(projectDir, 'node_modules', name, 'package.json');
    const pkg = JSON.parse(
      await readFile(packageFile, 'utf8').catch(() => {
        throw new VideoGenError(
          `Video project needs ${name} installed locally.`,
          'project: dependency missing',
        );
      }),
    ) as { version?: string };
    if (typeof pkg.version !== 'string')
      throw new VideoGenError(
        `Video project dependency ${name} has no readable version.`,
        'project: dependency version',
      );
    hash.update(`${name}@${pkg.version}`);
  }
  return hash.digest('hex');
}

async function resolveProject(
  spec: ProjectSpec,
  cwd: string,
  engine: ProjectEngine,
  signal?: AbortSignal,
) {
  const projectDir = await realpath(spec.projectDir).catch(() => {
    throw new VideoGenError('Video project directory is missing.', 'project: project');
  });
  const realCwd = await realpath(cwd);
  if (projectDir !== realCwd && !projectDir.startsWith(`${realCwd}${sep}`))
    throw new VideoGenError(
      'Video project must be inside the trusted working directory.',
      'project: untrusted project',
    );
  if (!(await stat(join(projectDir, 'package.json')).catch(() => null))?.isFile())
    throw new VideoGenError(
      'Video project needs package.json and installed dependencies.',
      'project: package',
    );
  if (engine === 'hyperframes') return resolveHyperframesProject(spec, projectDir, signal);
  const candidates = ['src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx'].filter(
    (p) => existsSync(join(projectDir, p)),
  );
  const entry = spec.entryPoint ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!entry)
    throw new VideoGenError(
      'Specify entryPoint; the Video project entry is missing or ambiguous.',
      'project: entry ambiguous',
    );
  const entryPath = await realpath(join(projectDir, entry)).catch(() => null);
  if (!entryPath?.startsWith(`${projectDir}${sep}`))
    throw new VideoGenError(
      'Video project entryPoint escapes the project or is missing.',
      'project: entry escape',
    );
  const browserExecutable =
    spec.browserExecutable ??
    process.env.REMOTION_BROWSER_EXECUTABLE ??
    [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].find(existsSync);
  if (!browserExecutable || !(await stat(browserExecutable).catch(() => null))?.isFile())
    throw new VideoGenError(
      'A local Chrome or Chromium executable is required. Set browserExecutable or REMOTION_BROWSER_EXECUTABLE; no browser is downloaded.',
      'project: browser missing',
    );
  for (const name of ['@remotion/bundler', '@remotion/renderer']) {
    if (!existsSync(join(projectDir, 'node_modules', name)))
      throw new VideoGenError(
        `Video project must install ${name} locally.`,
        'project: dependency missing',
      );
  }
  return { projectDir, entryPoint: entryPath, browserExecutable };
}

function assertOutputLocation(projectDir: string, outputDir: string, entryPoint: string): void {
  const publicDir = join(projectDir, 'public');
  if (
    projectDir === outputDir ||
    projectDir.startsWith(`${outputDir}${sep}`) ||
    outputDir === publicDir ||
    outputDir.startsWith(`${publicDir}${sep}`)
  )
    throw new VideoGenError(
      'Video project output directory must be outside the project public/ and cannot contain the project.',
      'project: output overlap',
    );
  if (entryPoint === outputDir || entryPoint.startsWith(`${outputDir}${sep}`))
    throw new VideoGenError(
      'Video project entryPoint cannot be inside the video output directory, which is excluded from the frozen project fingerprint.',
      'project: entry in output',
    );
}

async function snapshotPublic(
  projectDir: string,
  dest: string,
  assets: Record<string, string>,
  placeholder: string | undefined,
  engine: ProjectEngine,
  excludedDir: string,
): Promise<Record<string, string>> {
  if (await lstat(dest).catch(() => null))
    throw new VideoGenError(
      'Video project public snapshot path already exists.',
      'project: snapshot exists',
    );
  await mkdir(dest);
  try {
    const publicDir = engine === 'hyperframes' ? projectDir : join(projectDir, 'public');
    if (existsSync(publicDir)) {
      if (existsSync(join(publicDir, namespace)))
        throw new VideoGenError(
          `Project public/ occupies reserved ${namespace}/ namespace.`,
          'project: public collision',
        );
      for (const rel of await projectFiles(publicDir, '', engine === 'hyperframes', excludedDir)) {
        if (rel === namespace || rel.startsWith(`${namespace}${sep}`))
          throw new VideoGenError(
            `Project public/ occupies reserved ${namespace}/ namespace.`,
            'project: public collision',
          );
        const target = join(dest, rel);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(publicDir, rel), target);
        if ((await hashFileSha256(join(publicDir, rel))) !== (await hashFileSha256(target)))
          throw new VideoGenError(
            `Original public resource ${rel} changed while being copied.`,
            'project: public race',
          );
      }
    }
    await mkdir(join(dest, namespace), { recursive: true });
    const mapped: Record<string, string> = {};
    for (const [id, source] of Object.entries(assets)) {
      const ext = extname(source).toLowerCase() || '.mp4';
      if (!/^[.][a-z0-9]{1,8}$/.test(ext))
        throw new VideoGenError(`Unsupported asset extension for ${id}.`, 'project: extension');
      const rel = `${namespace}/${id}${ext}`;
      if (placeholder && /\.(mp4|mov|webm|m4v)$/.test(ext))
        await copyFile(placeholder, join(dest, rel));
      else await copyFile(source, join(dest, rel));
      mapped[id] = rel;
    }
    return mapped;
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
}

const runner = `
const {createRequire} = require('node:module');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');
let stage = 19;
(async () => {
  const x = JSON.parse(process.argv[1]);
  const req = createRequire(join(x.projectDir, 'package.json'));
  const {bundle} = req('@remotion/bundler');
  const {selectComposition, renderStill, renderMedia} = req('@remotion/renderer');
  stage = 20;
  const serveUrl = await bundle({entryPoint: x.entryPoint, rootDir: x.projectDir, publicDir: x.publicDir});
  stage = 21;
  const composition = await selectComposition({serveUrl, id: x.compositionId, inputProps: x.inputProps, browserExecutable: x.browserExecutable});
  stage = 24;
  if (x.qcTimesSec && x.qcTimesSec.some((t) => t >= composition.durationInFrames / composition.fps)) throw new Error('qcTimesSec outside composition');
  stage = 21;
  if (x.shotIds) {
    const times = composition.props.videoGenShotTimesSec;
    if (!times || typeof times !== 'object' || Array.isArray(times) || x.shotIds.some((id) => !Number.isFinite(times[id]) || times[id] < 0 || times[id] >= composition.durationInFrames / composition.fps)) {
      throw new Error('Composition must expose videoGenShotTimesSec for every shot.');
    }
    if (x.metadataPath) writeFileSync(x.metadataPath, JSON.stringify(Object.fromEntries(x.shotIds.map((id) => [id, times[id]]))));
  }
  if (x.mode === 'preflight') { stage = 22; await renderStill({serveUrl, composition, inputProps: x.inputProps, output: x.output, frame: 0, browserExecutable: x.browserExecutable}); }
  else { stage = 23; await renderMedia({serveUrl, composition, inputProps: x.inputProps, codec: 'h264', outputLocation: x.output, browserExecutable: x.browserExecutable}); }
})().catch(() => { process.exitCode = stage; });`;

function runRunner(input: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(20 * 60_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (signal.aborted)
    return Promise.reject(
      new VideoGenError('Video project rendering was cancelled.', 'project: cancelled'),
    );
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ['-e', input.engine === 'hyperframes' ? hyperframesRunner : runner, JSON.stringify(input)],
      {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
      },
    );
    let spawnFailed = false;
    let stopTree: Promise<boolean | undefined> | undefined;
    const onAbort = () => {
      if (!child.pid || stopTree) return;
      if (process.platform === 'win32') {
        stopTree = new Promise((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
          killer.once('error', () => {
            child.kill('SIGKILL');
            resolve(false);
          });
          killer.once('close', (code) => {
            if (code !== 0) child.kill('SIGKILL');
            resolve(code === 0);
          });
        });
      } else {
        stopTree = (async () => {
          const rootPid = child.pid!;
          try {
            process.kill(-rootPid, 'SIGSTOP');
          } catch {
            child.kill('SIGKILL');
            return false;
          }
          const groups = new Set([rootPid]);
          let cleanupFailed = false;
          const discoverDeadline = Date.now() + 7_000;
          while (true) {
            const remaining = discoverDeadline - Date.now();
            if (remaining <= 0) {
              cleanupFailed = true;
              break;
            }
            const fresh = (await descendantGroups(rootPid, remaining)).filter(
              (group) => !groups.has(group),
            );
            if (fresh.length === 0) break;
            for (const group of fresh) {
              groups.add(group);
              try {
                process.kill(-group, 'SIGSTOP');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailed = true;
              }
            }
          }
          for (const group of groups) {
            try {
              process.kill(-group, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                if (group === rootPid) child.kill('SIGKILL');
                cleanupFailed = true;
              }
            }
          }
          const deadline = Date.now() + 7_000;
          while (Date.now() < deadline) {
            const alive = [...groups].some((group) => {
              try {
                process.kill(-group, 0);
                return true;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code !== 'ESRCH';
              }
            });
            if (!alive) return !cleanupFailed;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return false;
        })().catch(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          return false;
        });
      }
    };
    child.on('error', () => {
      spawnFailed = true;
    });
    child.on('close', (code) => {
      void (async () => {
        signal?.removeEventListener('abort', onAbort);
        const stopped = await stopTree;
        if (stopped === false)
          throw new ProjectCleanupError(
            'Video project cancellation could not stop the renderer process tree. Stop remaining processes and restart Pi before resuming this job.',
            'project: cancellation cleanup failed',
          );
        if (signal?.aborted)
          throw new VideoGenError(
            deadline.aborted
              ? 'Video project rendering exceeded the 20-minute deadline.'
              : 'Video project rendering was cancelled.',
            'project: cancelled',
          );
        if (spawnFailed)
          throw new VideoGenError('Video project process could not start.', 'project: spawn');
        if (code === 0) return done();
        const reason =
          (
            {
              19: 'Video project dependencies could not load.',
              20: 'Video project bundle failed; check the project entry and source.',
              21:
                input.engine === 'hyperframes'
                  ? 'HyperFrames needs shotTimesSec for every shot within durationSec.'
                  : 'Remotion composition could not be selected; check its ID, videoGenShotTimesSec metadata and browser.',
              22: 'Video project frame preflight failed; check browser access and static assets.',
              23: 'Video project video rendering failed; check media compatibility and project code.',
              24: 'Video project duration metadata is invalid; check durationSec against the HTML composition and qcTimesSec against its duration.',
            } as Record<number, string>
          )[code ?? -1] ?? 'Video project process failed.';
        throw new VideoGenError(reason, `project: process stage ${code}`);
      })().catch(fail);
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function preflightProject(opts: {
  spec: ProjectSpec;
  engine?: ProjectEngine;
  cwd: string;
  jobDir: string;
  outputDir?: string;
  assets: Record<string, string>;
  shotIds?: string[];
  ffmpegPath: string;
  signal?: AbortSignal | undefined;
}) {
  const engine = opts.engine ?? 'hyperframes';
  const project = await resolveProject(opts.spec, opts.cwd, engine, opts.signal);
  const realJob = await realpath(opts.jobDir);
  const realOutput = await realpath(opts.outputDir ?? dirname(realJob));
  assertOutputLocation(project.projectDir, realOutput, project.entryPoint);
  const fingerprint = await projectFingerprint(project.projectDir, realOutput, engine);
  const assemblyDir = join(opts.jobDir, 'assembly');
  await mkdir(assemblyDir, { recursive: true });
  if (!(await realpath(assemblyDir)).startsWith(`${await realpath(opts.jobDir)}${sep}`))
    throw new VideoGenError(
      'Video project assembly directory escapes the job.',
      'project: assembly escape',
    );
  const dir = await mkdtemp(join(assemblyDir, '.preflight-'));
  let cleanupSafe = true;
  try {
    const placeholder = join(dir, 'placeholder.mp4');
    const encoder = await resolveGplFfmpeg(opts.ffmpegPath, opts.signal);
    if (!encoder.runnable)
      throw new VideoGenError(
        'Video project preflight needs an H.264-capable ffmpeg to create browser-playable placeholder video.',
        'project: h264 encoder missing',
      );
    await runFfmpegCommand(
      encoder.path,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=640x360:r=25',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        placeholder,
      ],
      opts.signal,
    );
    const mapped = await snapshotPublic(
      project.projectDir,
      join(dir, 'public'),
      opts.assets,
      placeholder,
      engine,
      realOutput,
    );
    await runRunner(
      {
        ...project,
        engine,
        spec: opts.spec,
        ffmpegPath: encoder.path,
        ffprobePath: (await resolveFfprobe(opts.ffmpegPath, opts.signal)).path,
        publicDir: join(dir, 'public'),
        compositionId: opts.spec.compositionId,
        shotIds: opts.shotIds,
        qcTimesSec: opts.spec.qcTimesSec,
        inputProps: { ...opts.spec.inputProps, videoGenAssets: mapped },
        output: join(dir, 'frame.png'),
        mode: 'preflight',
      },
      opts.signal,
    );
    if ((await projectFingerprint(project.projectDir, realOutput, engine)) !== fingerprint)
      throw new VideoGenError(
        'Video project changed during preflight. Retry in a new job.',
        'project: project preflight race',
      );
    return fingerprint;
  } catch (error) {
    if (error instanceof ProjectCleanupError) cleanupSafe = false;
    throw error;
  } finally {
    if (cleanupSafe) await rm(dir, { recursive: true, force: true });
  }
}

export async function runProject(opts: {
  specPath: string;
  engine?: ProjectEngine;
  cwd: string;
  settings: VideoGenSettings;
  activeJobs: ActiveJobs;
  trusted: boolean;
  signal?: AbortSignal | undefined;
  preflight?: boolean;
  verifyOnly?: boolean;
  verifyMedia?: boolean;
  frozenProjectHash?: string | undefined;
  assets?: Record<string, string>;
  shotIds?: string[];
  ffmpegPath: string;
}) {
  const engine = opts.engine ?? 'hyperframes';
  if (!opts.trusted)
    throw new VideoGenError(
      'Video project execution requires a trusted project.',
      'project: untrusted',
    );
  const abs = resolve(opts.cwd, opts.specPath);
  if (basename(abs) !== `${engine}-input.json`)
    throw new VideoGenError(`Expected ${engine}-input.json.`, 'project: filename');
  const jobDir = await realpath(dirname(abs));
  const output = await realpath(resolveOutputDir(opts.settings, opts.cwd)).catch(() =>
    resolve(resolveOutputDir(opts.settings, opts.cwd)),
  );
  if (!jobDir.startsWith(`${output}${sep}`))
    throw new VideoGenError(
      'Video project job must be inside the video-gen output directory.',
      'project: job location',
    );
  const spec = parseProjectSpec(await readFile(abs, 'utf8'), engine);
  const assets = { ...spec.assets, ...opts.assets };
  const release = opts.activeJobs.acquire(jobDir);
  let releaseLock = true;
  try {
    const project = await resolveProject(spec, opts.cwd, engine, opts.signal);
    assertOutputLocation(project.projectDir, output, project.entryPoint);
    const projectHash = await projectFingerprint(project.projectDir, output, engine);
    if (opts.frozenProjectHash && projectHash !== opts.frozenProjectHash)
      throw new VideoGenError(
        'Video project changed since preflight. Start a new job.',
        'project: project drift',
      );
    if (opts.preflight)
      return {
        jobId: basename(jobDir),
        projectDir: project.projectDir,
        projectHash,
        finalVideoPath: '',
        resumed: false,
        qcFrames: [],
        qcReportPath: undefined,
      };
    const hashes: Record<string, string> = {};
    for (const [id, path] of Object.entries(assets)) {
      if (!(await stat(path).catch(() => null))?.isFile())
        throw new VideoGenError(`Video project asset ${id} is missing.`, 'project: missing asset');
      hashes[id] = await hashFileSha256(path);
    }
    const fingerprint = sha(JSON.stringify({ spec, projectHash, hashes }));
    const manifestPath = join(jobDir, `${engine}-manifest.json`);
    const manifest = readJsonFile<ProjectManifest>(manifestPath);
    if (!manifest) {
      for (const name of [
        'manifest.json',
        'remotion-manifest.json',
        'hyperframes-manifest.json',
        'final_video.mp4',
      ]) {
        if (name === `${engine}-manifest.json`) continue;
        if (
          await lstat(join(jobDir, name)).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          })
        )
          throw new VideoGenError(
            'A video or another job manifest already exists here. Choose a new job directory.',
            'project: existing output',
          );
      }
    }
    if (manifest) {
      if (manifest.kind !== engine || manifest.fingerprint !== fingerprint)
        throw new VideoGenError(
          'Video project or assets changed; use a new job directory.',
          'project: drift',
        );
      if (manifest.finalVideoPath !== join(jobDir, 'final_video.mp4'))
        throw new VideoGenError(
          'Video project manifest final path changed.',
          'project: final path',
        );
      const finalStat = await lstat(manifest.finalVideoPath).catch(() => null);
      if (!finalStat?.isFile() || finalStat.isSymbolicLink())
        throw new VideoGenError(
          'Video project final video is not a regular file.',
          'project: final file invalid',
        );
      const finalHash = await hashFileSha256(manifest.finalVideoPath).catch(() => null);
      if (!finalHash || finalHash !== manifest.finalVideoHash)
        throw new VideoGenError(
          'Video project final video is missing or changed; refusing to silently rebuild.',
          'project: final drift',
        );
      if (
        opts.shotIds?.some(
          (id) =>
            !Number.isFinite(manifest.shotTimesSec?.[id]) ||
            (manifest.shotTimesSec?.[id] ?? -1) < 0,
        )
      )
        throw new VideoGenError(
          'Video project shot timing metadata is missing.',
          'project: shot timings',
        );
      const qcPaths: string[] = [];
      if (manifest.qcHashes !== undefined) {
        if (
          !manifest.qcHashes ||
          typeof manifest.qcHashes !== 'object' ||
          Array.isArray(manifest.qcHashes) ||
          Object.keys(manifest.qcHashes).length > 36
        )
          throw new VideoGenError('Video project QC manifest is invalid.', 'project: qc manifest');
        for (const [rel, expected] of Object.entries(manifest.qcHashes)) {
          if (!/^qc-[a-f0-9-]{36}[/\\](frame_\d{2}\.png|report\.json)$/.test(rel))
            throw new VideoGenError('Video project QC path is invalid.', 'project: qc path');
          const path = join(jobDir, rel);
          const entry = await lstat(path).catch(() => null);
          if (
            !entry?.isFile() ||
            entry.isSymbolicLink() ||
            !(await realpath(path)).startsWith(`${jobDir}${sep}`) ||
            (await hashFileSha256(path, opts.signal)) !== expected
          )
            throw new VideoGenError(
              'Video project QC artifact is missing or changed.',
              'project: qc drift',
            );
          qcPaths.push(path);
        }
        const reportPath = qcPaths.find((path) => path.endsWith('report.json'));
        const report = reportPath
          ? readJsonFile<{
              finalVideoPath?: string;
              finalVideoHash?: string;
              samples?: { path?: string }[];
            }>(reportPath)
          : undefined;
        if (
          !reportPath ||
          report?.finalVideoPath !== manifest.finalVideoPath ||
          report?.finalVideoHash !== manifest.finalVideoHash ||
          !Array.isArray(report.samples) ||
          report.samples.length === 0 ||
          report.samples.length !== qcPaths.length - 1 ||
          report.samples.some(
            (sample, index) =>
              sample?.path !==
                join(
                  basename(dirname(reportPath)),
                  `frame_${String(index).padStart(2, '0')}.png`,
                ) || !Object.hasOwn(manifest.qcHashes!, sample.path),
          )
        )
          throw new VideoGenError(
            'Video project QC evidence is incomplete or inconsistent.',
            'project: qc completeness',
          );
      }
      return {
        jobId: basename(jobDir),
        projectDir: project.projectDir,
        projectHash,
        finalVideoPath: manifest.finalVideoPath,
        resumed: true,
        shotTimesSec: manifest.shotTimesSec,
        qcFrames: qcPaths.filter((path) => path.endsWith('.png')),
        qcReportPath: qcPaths.find((path) => path.endsWith('report.json')),
      };
    }
    if (opts.verifyOnly)
      throw new VideoGenError(
        'Completed Video project assembly manifest is missing; refusing to rebuild.',
        'project: missing manifest',
      );
    const publicDir = join(jobDir, `public-snapshot-${randomUUID()}`);
    const temp = join(jobDir, `final_video.${randomUUID()}.tmp.mp4`);
    const metadataPath = join(jobDir, `shot-times.${randomUUID()}.json`);
    const qcDir = join(jobDir, `qc-${randomUUID()}`);
    let ownsSnapshot = false;
    let retainSnapshot = false;
    let cleanupSafe = true;
    let ownsQc = false;
    try {
      const mapped = await snapshotPublic(
        project.projectDir,
        publicDir,
        assets,
        undefined,
        engine,
        output,
      );
      ownsSnapshot = true;
      for (const [id, expected] of Object.entries(hashes))
        if ((await hashFileSha256(join(publicDir, mapped[id]!))) !== expected)
          throw new VideoGenError(
            `Video project asset "${id}" changed while being copied.`,
            'project: asset race',
          );
      await runRunner(
        {
          ...project,
          engine,
          spec,
          ffmpegPath: opts.ffmpegPath,
          ffprobePath: (await resolveFfprobe(opts.settings.ffmpegPath, opts.signal)).path,
          publicDir,
          compositionId: spec.compositionId,
          shotIds: opts.shotIds,
          qcTimesSec: spec.qcTimesSec,
          metadataPath,
          inputProps: { ...spec.inputProps, videoGenAssets: mapped },
          output: temp,
          mode: 'render',
        },
        opts.signal,
      );
      const outputStat = await stat(temp).catch(() => null);
      if (!outputStat?.isFile() || !outputStat.size)
        throw new VideoGenError('Video project produced no video.', 'project: empty video');
      const shotTimesSec = opts.shotIds
        ? (JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, number>)
        : undefined;
      const finalVideoPath = join(jobDir, 'final_video.mp4');
      const finalVideoHash = await hashFileSha256(temp, opts.signal);
      const qcHashes: Record<string, string> = {};
      const qcFrames: string[] = [];
      let qcReportPath: string | undefined;
      if (opts.verifyMedia !== false) {
        const ffprobe = await resolveFfprobe(opts.settings.ffmpegPath, opts.signal);
        if (!ffprobe.runnable)
          throw new VideoGenError(
            'ffprobe is required to verify Video project output.',
            'project: ffprobe missing',
          );
        const streams = await probeStreams(ffprobe.path, temp, opts.signal);
        const [numerator, denominator = 1] = streams.fps.split('/').map(Number);
        const fps = numerator! / denominator;
        if (!Number.isFinite(fps) || fps <= 0)
          throw new VideoGenError(
            'Video project QC needs a valid video frame rate.',
            'project: qc fps',
          );
        const durationSec = await probeVideoDuration(ffprobe.path, temp, opts.signal);
        if (engine === 'hyperframes' && Math.abs(durationSec - spec.durationSec!) > 1 / fps + 0.001)
          throw new VideoGenError(
            'HyperFrames durationSec does not match the exported HTML composition.',
            'hyperframes: duration mismatch',
          );
        if (spec.qcTimesSec?.some((time) => time >= durationSec))
          throw new VideoGenError(
            'qcTimesSec exceeds the exported video duration.',
            'project: qc duration',
          );
        const lastFrame = Math.max(0, Math.round(durationSec * fps) - 1);
        const edge = Math.min(0.5, durationSec / 4);
        const times = [
          ...new Set([edge, durationSec / 2, durationSec - edge, ...(spec.qcTimesSec ?? [])]),
        ].sort((a, b) => a - b);
        await mkdir(qcDir);
        ownsQc = true;
        const samples: { timeSec: number; frameTimeSec: number; path: string }[] = [];
        for (const [index, timeSec] of times.entries()) {
          const name = `frame_${String(index).padStart(2, '0')}.png`;
          const path = join(qcDir, name);
          const framePosition = timeSec * fps;
          // Preserve exact decimal frame boundaries despite floating-point roundoff.
          const frameTimeSec =
            Math.min(
              lastFrame,
              Math.floor(framePosition + 4 * Number.EPSILON * Math.max(1, framePosition)),
            ) / fps;
          await runFfmpegCommand(
            opts.ffmpegPath,
            ['-ss', frameTimeSec.toFixed(6), '-i', temp, '-frames:v', '1', '-y', path],
            opts.signal,
          );
          const rel = join(basename(qcDir), name);
          qcHashes[rel] = await hashFileSha256(path, opts.signal);
          qcFrames.push(path);
          samples.push({ timeSec, frameTimeSec, path: rel });
        }
        qcReportPath = join(qcDir, 'report.json');
        writeJsonAtomic(qcReportPath, { finalVideoPath, finalVideoHash, durationSec, samples });
        qcHashes[join(basename(qcDir), 'report.json')] = await hashFileSha256(
          qcReportPath,
          opts.signal,
        );
      }
      if ((await projectFingerprint(project.projectDir, output, engine)) !== projectHash)
        throw new VideoGenError(
          'Video project changed during rendering; refusing to commit output.',
          'project: project render race',
        );
      await rename(temp, finalVideoPath);
      writeJsonAtomic(manifestPath, {
        kind: engine,
        fingerprint,
        finalVideoPath,
        finalVideoHash,
        shotTimesSec,
        ...(ownsQc ? { qcHashes } : {}),
      } satisfies ProjectManifest);
      retainSnapshot = true;
      return {
        jobId: basename(jobDir),
        projectDir: project.projectDir,
        projectHash,
        finalVideoPath,
        resumed: false,
        shotTimesSec,
        qcFrames,
        qcReportPath,
      };
    } catch (error) {
      if (error instanceof ProjectCleanupError) cleanupSafe = false;
      throw error;
    } finally {
      if (cleanupSafe) {
        await rm(temp, { force: true });
        await rm(metadataPath, { force: true });
        if (ownsSnapshot && !retainSnapshot) await rm(publicDir, { recursive: true, force: true });
        if (ownsQc && !retainSnapshot) await rm(qcDir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (error instanceof ProjectCleanupError) releaseLock = false;
    throw error;
  } finally {
    if (releaseLock) release();
  }
}
