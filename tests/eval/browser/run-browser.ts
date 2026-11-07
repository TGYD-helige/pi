#!/usr/bin/env node
/**
 * pi-browser-use L3 eval: task-completion rate, driven through the REAL `pi` CLI.
 *
 * Sets up an isolated pi config dir, installs pi-browser-use, then runs each task
 * in browser/tasks.ts via `pi --mode json -p '<task>' --tools <allowlist>` and
 * scores the result with the task's deterministic `check`. Because the extension
 * is installed and run exactly as shipped, the success rate reflects the real
 * wrapper (snapshot handling, tool descriptions, overlay/stale hints) plus the
 * model — no importing package internals.
 *
 * REQUIRES: `pi` on PATH, a real Chrome (found via CHROME_BIN or common paths),
 * and a working provider — either --models <models.json> or --base-url +
 * PI_INTEGRATION_API_KEY. Runs on Linux/macOS. See README.
 *
 * Usage:
 *   PI_INTEGRATION_BASE_URL=... PI_INTEGRATION_API_KEY=... \
 *     pnpm --filter @amaster.ai/pi-eval eval:browser -- --model deepseek-v4-flash
 *   # or with a ready models.json (what CI does):
 *   pnpm --filter @amaster.ai/pi-eval eval:browser -- --models /path/to/models.json
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type DriveResult,
  drivePrompt,
  parseCommonArgs,
  setupHarness,
  toHarnessConfig,
} from '../src/pi-harness.js';
import { resultMetadata, summarize, type TrialRow } from '../src/results.js';
import { startBrowserFixture } from './fixture.js';
import { BROWSER_TASKS, DEFAULT_BROWSER_TOOLS } from './tasks.js';

/**
 * Locate a Chrome/Chromium binary for chrome-devtools-mcp, cross-platform.
 * Override via CHROME_BIN. Checks common macOS + Linux locations; returns
 * undefined if none found (caller prints the npx-install hint).
 */
function resolveChrome(): string | undefined {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  return candidates.find((c) => existsSync(c));
}

async function main() {
  const args = parseCommonArgs({ model: 'deepseek-v4-flash', timeoutMs: 180_000 });
  if (args.useDefaultPi)
    throw new Error('Browser eval requires isolated configuration; use --models or --base-url.');
  const hcfg = toHarnessConfig(args);
  const chrome = resolveChrome();
  if (!chrome) throw new Error('No Chrome binary found. Set CHROME_BIN.');
  let selected = args.taskId
    ? BROWSER_TASKS.filter((task) => task.id === args.taskId)
    : BROWSER_TASKS;
  if (args.tasks > 0) selected = selected.slice(0, args.tasks);
  if (!selected.length) throw new Error('No tasks selected.');
  const metadata = {
    expectedTrials: selected.length * args.trials,
    ...resultMetadata(
      'browser-v2',
      ['browser/tasks.ts', 'browser/fixture.ts', 'browser/run-browser.ts'],
      args.packageRoot,
      `${args.provider}/${args.model}`,
      args.thinking,
      hcfg,
    ),
  };
  const rows: Array<
    TrialRow & {
      answer: string;
      observed: string;
      state: unknown;
      error?: string;
      toolResults: DriveResult['toolResults'];
    }
  > = [];
  const output = path.resolve(
    args.output || path.join(import.meta.dirname, '..', 'results', 'browser-tasks.json'),
  );
  const save = () => {
    mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          ...metadata,
          complete: rows.length === metadata.expectedTrials,
          summary: summarize(rows),
          rows,
        },
        null,
        2,
      ),
    );
    renameSync(temporary, output);
  };
  save();
  for (const selectedTask of selected) {
    for (let trial = 1; trial <= args.trials; trial++) {
      const fixture = await startBrowserFixture();
      try {
        const task = fixture.tasks.find((task) => task.id === selectedTask.id)!;
        const harness = await setupHarness(hcfg, {
          pkg: 'pi-browser-use',
          settings: {
            'pi-browser-use': {
              headless: true,
              sessionMode: 'isolated',
              viewport: '1280x720',
              executablePath: chrome,
            },
          },
        });
        try {
          const drive = await drivePrompt(
            harness,
            hcfg,
            `Start URL: ${task.startUrl}\nTask: ${task.instruction}\nComplete the task in the browser and report the requested value.`,
            task.tools ?? DEFAULT_BROWSER_TOOLS,
          );
          const success = drive.failureMode === 'ok' && task.check(drive) ? 1 : 0;
          const failureMode =
            drive.failureMode !== 'ok'
              ? drive.failureMode
              : success
                ? 'ok'
                : drive.sawToolError
                  ? 'tool-error'
                  : 'check-failed';
          rows.push({
            task: task.id,
            trial,
            success,
            failureMode,
            turns: drive.turns,
            toolCalls: drive.toolCalls,
            durationMs: drive.durationMs,
            ...(drive.totalTokens !== undefined ? { totalTokens: drive.totalTokens } : {}),
            answer: drive.answer,
            observed: drive.observed,
            toolResults: drive.toolResults,
            state: fixture.state(),
            ...(drive.error ? { error: drive.error } : {}),
          });
          process.stderr.write(
            `[eval:browser] ${task.id} trial=${trial} success=${success} mode=${failureMode}\n`,
          );
          save();
        } finally {
          harness.cleanup();
        }
      } finally {
        await fixture.close();
      }
    }
  }
  process.stderr.write(`[eval:browser] ${JSON.stringify(summarize(rows))}\n`);
}

main().catch(() => {
  process.stderr.write(
    '[eval:browser] Evaluation setup failed. Check configuration, build and Chrome availability.\n',
  );
  process.exitCode = 1;
});
