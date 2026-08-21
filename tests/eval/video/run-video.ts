#!/usr/bin/env node
/**
 * pi-video-gen quality eval on ViMax-Bench (HKUDS/ViMax, MIT): render pre-planned
 * multi-shot story specs through the REAL shot-book pipeline (real `pi` CLI, real
 * image_generate + video_render) and record artifacts for VLM judging
 * (scripts/judge-video.ts).
 *
 * The shot book is converted deterministically from each ViMax story spec — the
 * LLM only EXECUTES it (frame generation + one video_render call), so the numbers
 * reflect render/compose/orchestration quality, not planning variance.
 *
 * COST WARNING: every story is 8-16 PAID video clips + ~1 image per shot. Slice
 * with --samples/--tier/--story. See README.
 *
 * Usage (local — reuses your ~/.pi/agent video/image provider config):
 *   pnpm --filter @amaster.ai/pi-eval eval:video -- --use-default-pi --samples 2 --tier medium
 *
 * CI shape (generated extension settings from env, mirrors integration.yml):
 *   PI_INTEGRATION_BASE_URL=... PI_INTEGRATION_API_KEY=... PI_EVAL_IMAGE_MODEL=doubao-seedream-5-0-lite-260128 \
 *     pnpm --filter @amaster.ai/pi-eval eval:video -- --samples 2 --models /path/to/models.json
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadVideoGenSettings, resolveModel } from '../../../packages/pi-video-gen/src/config.js';
import type { VideoGenSettings } from '../../../packages/pi-video-gen/src/types.js';
import { getFlag } from '../src/judge-client.js';
import {
  type DriveResult,
  drivePrompt,
  type FailureMode,
  parseCommonArgs,
  setupHarness,
  toHarnessConfig,
} from '../src/pi-harness.js';
import { loadVimax, type VimaxStory, type VimaxTier, type VimaxType } from '../src/loaders/vimax.js';

const TOOLS = 'read,write,ls,image_generate,video_capabilities,video_render';
const EVAL_DIR = path.resolve(import.meta.dirname, '..');
const ARTIFACTS_DIR = path.join(EVAL_DIR, 'results', 'artifacts');

interface VideoArgs {
  samples: number;
  tier: VimaxTier | 'all';
  storyId: string;
  videoModel: string;
  imageModel: string;
  durationSec: number;
}

function parseVideoArgs(): VideoArgs {
  const argv = process.argv.slice(2);
  const durationSecRaw = getFlag(argv, '--duration-sec', '5');
  const durationSec = Number(durationSecRaw);
  // Reject malformed input at t=0 — a NaN/negative would otherwise surface only
  // after paid frame generation. The model range check runs later in main()
  // against the actually-resolved active model (mode-dependent).
  if (!Number.isInteger(durationSec) || durationSec <= 0) {
    throw new Error(`--duration-sec must be a positive integer, got "${durationSecRaw}".`);
  }
  return {
    samples: Number(getFlag(argv, '--samples', '2')),
    tier: getFlag(argv, '--tier', 'medium') as VideoArgs['tier'],
    storyId: getFlag(argv, '--story', ''),
    // CI-proven ids from integration.yml; override for other gateways.
    videoModel: getFlag(argv, '--video-model', process.env.PI_EVAL_VIDEO_MODEL || 'doubao-seedance-2-0-260128'),
    imageModel: getFlag(argv, '--image-model', process.env.PI_EVAL_IMAGE_MODEL || ''),
    // Per-shot clip length. 5 keeps smoke cheap; use 10-15 for scored runs —
    // longer clips expose within-shot motion drift.
    durationSec,
  };
}

/**
 * Gateway baseUrl for the gen extensions in isolated mode: --base-url /
 * PI_INTEGRATION_BASE_URL, else read it off the --models file's provider.
 */
function resolveGatewayBaseUrl(args: ReturnType<typeof parseCommonArgs>): string {
  if (args.baseUrl) return args.baseUrl;
  if (args.modelsPath) {
    try {
      const models = JSON.parse(readFileSync(args.modelsPath, 'utf8')) as {
        providers?: Record<string, { baseUrl?: string }>;
      };
      const url = models.providers?.[args.provider]?.baseUrl;
      if (url) return url;
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(
    'isolated mode needs a gen gateway baseUrl: --base-url (or PI_INTEGRATION_BASE_URL), ' +
      'or a --models file whose provider carries baseUrl',
  );
}

/**
 * Extension settings for the isolated config dir, mirroring integration.yml's
 * ci-gateway shape: `${ENV}` interpolation keeps secrets off disk (loadPiSettings
 * expands them from the agent-dir layer at runtime).
 */
function buildSettings(args: ReturnType<typeof parseCommonArgs>, vargs: VideoArgs) {
  if (!vargs.imageModel) {
    throw new Error(
      'isolated mode needs an image model: --image-model <id> or PI_EVAL_IMAGE_MODEL ' +
        '(or use --use-default-pi to reuse your ~/.pi/agent config)',
    );
  }
  const baseUrl = resolveGatewayBaseUrl(args);
  if (!process.env[args.apiKeyEnv]) {
    throw new Error(
      `API key env var "${args.apiKeyEnv}" is not set — the isolated extension settings reference it by name.`,
    );
  }
  const apiKey = '${' + args.apiKeyEnv + '}';
  return {
    'pi-image-gen': {
      defaultModel: vargs.imageModel,
      outputDir: path.join(ARTIFACTS_DIR, 'images'),
      customProviders: {
        'eval-gateway': { api: 'openai', baseUrl, apiKey },
      },
    },
    'pi-video-gen': {
      defaultModel: 'eval-video',
      outputDir: path.join(ARTIFACTS_DIR, 'video'),
      customProviders: {
        'eval-gateway': {
          api: 'newapi',
          baseUrl,
          apiKey,
          models: [{ id: vargs.videoModel, alias: 'eval-video' }],
        },
      },
    },
  };
}

/** ViMax story → VideoProject shot book (skill §B schema), deterministically. */
function toShotBook(story: VimaxStory, durationSec: number) {
  return {
    title: story.theme,
    characters: [],
    shots: story.shots.map((s) => ({
      id: s.shotId,
      intent: s.videoPrompt,
      firstFrame: s.firstFrame,
      action: s.videoPrompt,
      durationSec,
      continuityGroup: `scene-${s.sceneNum}`,
    })),
  };
}

function buildPrompt(story: VimaxStory, shotBookPath: string, renderSpecHint: string): string {
  return `Render a pre-planned multi-shot video from an existing shot book. This is an unattended evaluation run: all costs and confirmation gates in the video-gen skill are PRE-APPROVED — never ask for confirmation, never wait for input, never negotiate degradations (accept them and note it).

Shot book (VideoProject JSON): ${shotBookPath} — read it first with the read tool.

Execute exactly:
1. Call video_capabilities first. If the shot book's durationSec is outside the active model's duration range, STOP and report the mismatch — do not generate any frames (they are paid).
2. Image stage: for each shot in order, generate its first frame with image_generate (text-to-image, 16:9) using the shot's firstFrame text VERBATIM as the prompt. Record each returned absolute image path immediately.
3. Write render-input.json (${renderSpecHint}): {"title","aspectRatio":"16:9","shots":[{"id","prompt":{"visuals","action"},"firstFramePath","durationSec"}...]} — prompt.action is the shot book shot's action text VERBATIM, prompt.visuals describes camera/framing ("Static camera" when the action text implies no camera move), firstFramePath the generated frame path from step 2.
4. Call video_render ONCE with that spec path.
5. Reply with the final video path.

Constraints: do not rewrite, reorder, add, or drop shots; no character portraits; no last frames. If image_generate fails for a shot, retry once, then continue with the remaining shots and note the failure in your final reply.`;
}

/** The render tool result carries finalVideoPath; fall back to any final_video path. */
function extractFinalVideoPath(drive: DriveResult): string {
  // answer is scanned too: the prompt requires the final path in the reply, and
  // in useDefaultPi mode the render output may be lost to observed truncation.
  const haystack = `${drive.observed}\n${drive.answer}`;
  const m = /"finalVideoPath"\s*:\s*"([^"]+)"/.exec(haystack) ?? /(\/[^\s"']*final_video\.mp4)/.exec(haystack);
  return m?.[1] ?? '';
}

/**
 * Completion = the final video EXISTS ON DISK from THIS run. Both candidates
 * require mtime >= runStart: pi-video-gen resumes jobs by directory, and a
 * stale path can leak into this run's observed via the agent's ls/read of the
 * old job dir. An honest this-run render always rewrites final_video.mp4
 * (concat reruns unconditionally), so the guard costs no true positives.
 */
function resolveFinalVideo(story: VimaxStory, drive: DriveResult, runStart: number): string {
  const candidates = [
    extractFinalVideoPath(drive),
    path.join(ARTIFACTS_DIR, 'video', story.id, 'final_video.mp4'),
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (statSync(p).mtimeMs >= runStart) return p;
    } catch {
      // not there
    }
  }
  return '';
}

/**
 * Execution-contract check: the LLM must render the shot book verbatim.
 * Compares the written render-input.json's shot ids/order against the spec.
 * Runs whether or not the render completed (a re-planned spec whose render
 * then failed is still a violation). Stale specs from previous runs are
 * skipped via runStart. Returns undefined when no fresh spec was produced.
 */
function checkSpecPreserved(
  story: VimaxStory,
  finalVideoPath: string,
  runStart: number,
): number | undefined {
  const candidates = [
    ...(finalVideoPath ? [path.join(path.dirname(finalVideoPath), 'render-input.json')] : []),
    path.join(ARTIFACTS_DIR, 'video', story.id, 'render-input.json'),
  ];
  for (const p of candidates) {
    try {
      if (statSync(p).mtimeMs < runStart) continue;
      const spec = JSON.parse(readFileSync(p, 'utf8')) as { shots?: Array<{ id?: unknown }> };
      const ids = (spec.shots ?? []).map((s) => String(s.id ?? ''));
      // JSON.stringify both sides: LLM-controlled ids could otherwise join to
      // the same string as a different sequence (['a','b'] vs ['a,b']).
      return JSON.stringify(ids) === JSON.stringify(story.shots.map((s) => s.shotId)) ? 1 : 0;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

interface Row {
  story: string;
  type: VimaxType;
  tier: VimaxTier;
  shots: number;
  completed: number;
  specPreserved?: number;
  finalVideoPath: string;
  turns: number;
  toolCalls: number;
  failureMode: FailureMode;
  answer: string;
  error?: string;
}

function scoreStory(story: VimaxStory, drive: DriveResult, runStart: number): Row {
  const finalVideoPath = resolveFinalVideo(story, drive, runStart);
  let failureMode = drive.failureMode;
  if (failureMode === 'ok' && !finalVideoPath) {
    failureMode = drive.sawToolError ? 'tool-error' : 'check-failed';
  }
  const specPreserved = checkSpecPreserved(story, finalVideoPath, runStart);
  return {
    story: story.id,
    type: story.type,
    tier: story.tier,
    shots: story.shots.length,
    completed: finalVideoPath ? 1 : 0,
    ...(specPreserved !== undefined ? { specPreserved } : {}),
    finalVideoPath,
    turns: drive.turns,
    toolCalls: drive.toolCalls,
    failureMode,
    answer: drive.answer,
    ...(drive.error ? { error: drive.error } : {}),
  };
}

async function main() {
  // No hardcoded LLM default (spec): the driver model is always explicit.
  const args = parseCommonArgs({ model: '', timeoutMs: 7_200_000 });
  if (!args.model) {
    throw new Error('no default LLM is hardcoded — pass --model <id> or set PI_EVAL_MODEL');
  }
  const vargs = parseVideoArgs();
  const hcfg = toHarnessConfig(args);

  const stories = await loadVimax();
  let selected = vargs.storyId
    ? stories.filter((s) => s.id === vargs.storyId)
    : stories.filter((s) => vargs.tier === 'all' || s.tier === vargs.tier);
  if (vargs.samples > 0) selected = selected.slice(0, vargs.samples);
  if (selected.length === 0) throw new Error('no stories selected');

  const clips = selected.reduce((a, s) => a + s.shots.length, 0);
  process.stderr.write(
    `[eval:video] stories=${selected.length} plannedClips=${clips} model=${args.provider}/${args.model}\n`,
  );

  const harness = await setupHarness(hcfg, {
    pkg: 'pi-video-gen',
    alsoInstall: ['pi-image-gen'],
    // useDefaultPi mode writes no settings — the user's own config drives.
    settings: hcfg.useDefaultPi ? {} : buildSettings(args, vargs),
  });

  // Duration preflight against the ACTIVE model's real capabilities — isolated
  // mode resolves the harness-written settings; --use-default-pi resolves the
  // user's own config. Fail closed before any paid frame generation.
  const videoSettings = hcfg.useDefaultPi
    ? loadVideoGenSettings(process.cwd(), false)
    : (buildSettings(args, vargs)['pi-video-gen'] as VideoGenSettings);
  const activeVideo = resolveModel(videoSettings);
  if (!activeVideo) {
    throw new Error(
      'Cannot resolve the active video model for the duration preflight — refusing to start paid generation.',
    );
  }
  const [minD, maxD] = activeVideo.entry.capabilities.durations;
  if (vargs.durationSec < minD || vargs.durationSec > maxD) {
    throw new Error(
      `--duration-sec ${vargs.durationSec} is outside ${minD}-${maxD}s for the active video model (${activeVideo.entry.id}).`,
    );
  }

  const shotBooksDir = path.join(ARTIFACTS_DIR, 'shotbooks');
  mkdirSync(shotBooksDir, { recursive: true });
  const outDir = path.join(EVAL_DIR, 'results');
  mkdirSync(outDir, { recursive: true });
  const resultsPath = path.join(outDir, 'video-vimax.json');

  const summarize = (rows: Row[]) => {
    const completed = rows.filter((r) => r.completed === 1);
    const failureMix: Record<string, number> = {};
    for (const r of rows) failureMix[r.failureMode] = (failureMix[r.failureMode] ?? 0) + 1;
    return {
      model: `${args.provider}/${args.model}`,
      videoModel: vargs.videoModel,
      durationSec: vargs.durationSec,
      n: rows.length,
      completed: completed.length,
      completionRate: completed.length / Math.max(1, rows.length),
      specViolations: rows.filter((r) => r.specPreserved === 0).length,
      avgTurns: completed.reduce((a, r) => a + r.turns, 0) / Math.max(1, completed.length),
      failureMix,
    };
  };
  // Incremental write: a killed run (CI job timeout, Ctrl-C) keeps the
  // completed stories' rows instead of losing everything.
  const writeResults = (rows: Row[]) =>
    writeFileSync(resultsPath, JSON.stringify({ summary: summarize(rows), rows }, null, 2));

  const rows: Row[] = [];
  try {
    // Sequential: paid generation; a parallel fleet would also trip rate limits.
    for (const story of selected) {
      const shotBookPath = path.join(shotBooksDir, `${story.id}.json`);
      writeFileSync(shotBookPath, JSON.stringify(toShotBook(story, vargs.durationSec), null, 2));
      const renderSpecHint = hcfg.useDefaultPi
        ? `under the video-gen output dir as job '${story.id}', i.e. <outputDir>/${story.id}/render-input.json`
        : path.join(ARTIFACTS_DIR, 'video', story.id, 'render-input.json');
      process.stderr.write(`[eval:video] start ${story.id} (type ${story.type}, ${story.shots.length} shots)\n`);
      const runStart = Date.now();
      const drive = await drivePrompt(harness, hcfg, buildPrompt(story, shotBookPath, renderSpecHint), TOOLS);
      const row = scoreStory(story, drive, runStart);
      rows.push(row);
      writeResults(rows);
      process.stderr.write(
        `[eval:video] done ${story.id}: completed=${row.completed} mode=${row.failureMode} turns=${row.turns}${row.error ? ` err=${row.error.slice(0, 80)}` : ''}\n`,
      );
    }
  } finally {
    harness.cleanup();
  }

  process.stderr.write(`[eval:video] ${JSON.stringify(summarize(rows))}\n`);
}

main().catch((err) => {
  process.stderr.write(`[eval:video] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
