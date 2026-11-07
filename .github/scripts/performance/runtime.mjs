import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measure, median, metrics as runtimeMetrics } from './workloads.mjs';
import {
  measureSessions,
  percentile,
  profileMetrics,
  sessionMetrics,
  soakMetrics,
} from './sessions.mjs';
import { OFFLINE_MESSAGE } from './no-network.mjs';
import { connect } from 'node:net';

const script = fileURLToPath(import.meta.url);
const dispersion = (values) => {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
};
const regressed = (base, head, slack) => head > base * 1.3 + slack;

function sample(root, label) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', script, '--sample', root, '', suite, String(soakMinutes)],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(suite === 'soak'
            ? { PI_PERFORMANCE_PROGRESS_PATH: path.resolve(output, `${label}-checkpoints.jsonl`) }
            : {}),
        },
        timeout: suite === 'soak' ? soakMinutes * 60_000 + 120_000 : 240_000,
        maxBuffer: 512 * 1024,
      },
    ),
  );
}

const [mode, candidate, output, suite = 'runtime', soakText = '60'] = process.argv.slice(2);
assert.ok(['runtime', 'sessions', 'profiles', 'soak'].includes(suite));
const soakMinutes = Number(soakText);
if (suite === 'soak')
  assert.ok(Number.isInteger(soakMinutes) && soakMinutes >= 1 && soakMinutes <= 120);
const pairs = suite === 'soak' ? 1 : 7;
const metrics =
  suite === 'soak'
    ? soakMetrics
    : suite === 'profiles'
      ? profileMetrics
      : suite === 'sessions'
        ? sessionMetrics
        : runtimeMetrics;
if (mode === '--self-test') {
  assert.equal(regressed(10, 12, 0.2), false);
  assert.equal(regressed(10, 14, 0.2), true);
  assert.equal(regressed(0.01, 0.1, 0.2), false);
  assert.equal(median([9, 1, 3, 2, 4]), 3);
  assert.equal(dispersion([1, 2, 2, 3, 100]), 1);
  assert.equal(dispersion([4, 4, 4, 4, 4]), 0);
  assert.equal(regressed(0, 7, runtimeMetrics.telemetryRetainedHeapMiB.slack), false);
  assert.equal(regressed(0, 9, runtimeMetrics.telemetryRetainedHeapMiB.slack), true);
  for (const { slack } of Object.values(metrics)) assert.ok(slack >= 0);
  for (const { slack } of Object.values(sessionMetrics)) assert.ok(slack >= 0);
  assert.throws(() => connect({ host: '127.0.0.1', port: 9 }), { message: OFFLINE_MESSAGE });
  await assert.rejects(fetch('https://example.invalid'), { message: OFFLINE_MESSAGE });
  const ordered = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(ordered, 0.95), 95);
  assert.equal(percentile(ordered, 0.99), 99);
} else if (mode === '--import') {
  const manifest = JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8'));
  const started = performance.now();
  for (const entry of manifest.pi.extensions) {
    const extension = await import(pathToFileURL(path.resolve(candidate, entry)).href);
    assert.equal(typeof extension.default, 'function');
  }
  process.stdout.write(JSON.stringify({ durationMs: performance.now() - started }));
} else if (mode === '--sample') {
  process.stdout.write(
    JSON.stringify(
      await (suite === 'runtime'
        ? measure(candidate)
        : measureSessions(candidate, {
            profiles: suite === 'profiles',
            soakMinutes: suite === 'soak' ? soakMinutes : 0,
            progressPath: process.env.PI_PERFORMANCE_PROGRESS_PATH,
          })),
    ),
  );
} else {
  assert.ok(
    mode && candidate && output,
    'Usage: runtime.mjs <baseline-root> <candidate-root> <output-dir> [runtime|sessions|profiles|soak] [soak-minutes]',
  );
  mkdirSync(output, { recursive: true });
  const base = [];
  const head = [];
  // Separate processes retain cold imports; alternate ordering to reduce thermal/time bias.
  for (let i = 0; i < pairs; i++) {
    if (i % 2 === 0) {
      base.push(sample(mode, `base-${i}`));
      head.push(sample(candidate, `head-${i}`));
    } else {
      head.push(sample(candidate, `head-${i}`));
      base.push(sample(mode, `base-${i}`));
    }
  }
  const results = Object.entries(metrics).map(([metric, { unit, slack }]) => {
    const baselineValues = base.map((row) => row[metric]);
    const baseline = median(baselineValues);
    const baselineMad = dispersion(baselineValues);
    const effectiveSlack = Math.max(slack, 3 * baselineMad);
    const current = median(head.map((row) => row[metric]));
    assert.ok(
      Number.isFinite(baseline) && baseline >= 0 && Number.isFinite(current) && current >= 0,
    );
    return {
      metric,
      unit,
      configuredSlack: slack,
      slack: effectiveSlack,
      baselineMad,
      baseline,
      current,
      limit: baseline * 1.3 + effectiveSlack,
      failed: regressed(baseline, current, effectiveSlack),
    };
  });
  const report = [
    `## ${suite} performance`,
    '',
    `Same-runner comparison, ${pairs} fresh process(es) per revision. Values are medians per operation (or per named batch). TCP connections and fetch requests are forbidden; model tasks and service validation belong in Integration.`,
    '',
    ...(suite === 'profiles'
      ? [
          'Each extension and the all-extension combination runs its unchanged factory and SDK lifecycle handlers. Fixed external transport fixtures replace CLI, MCP, Mem0 and telemetry delivery. SDK startup excludes cold imports, which are measured separately in the runtime suite.',
          '',
        ]
      : suite === 'soak'
        ? [
            `Each revision runs for ${soakMinutes} minute(s), with a 100 ms duty-cycle pause, a rolling 256-cycle latency window, and resource checkpoints every minute. The baseline and candidate run sequentially on the same runner.`,
            '',
          ]
        : suite === 'sessions'
          ? [
              'CLI readiness includes process startup and RPC initialization with no configured model. Hook pipelines dispatch real lifecycle events and project static contexts without submitting provider requests or executing tools. Resource growth is the maximum of checkpoints after 100/200/300/400/500 create/hook/shutdown cycles, relative to a warmed process after forced GC.',
              '',
            ]
          : [
              'Cold imports exclude Node startup. File I/O uses warm filesystem caches. Telemetry uses an in-memory SDK sink; its retained heap metric covers 100 exporter cycles.',
              '',
            ]),
    'Failure limit: baseline × 1.30 + max(configured margin, 3 × baseline median absolute deviation), shown below. Soak uses one long-lived process per revision and its configured margin. Initial margins need hosted-runner calibration. Resource-growth probes do not replace production soak tests.',
    '',
    '| Metric | Unit | Baseline | Candidate | Baseline MAD | Noise margin | Limit | Result |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...results.map(
      (row) =>
        `| ${row.metric} | ${row.unit} | ${row.baseline.toFixed(3)} | ${row.current.toFixed(3)} | ${row.baselineMad.toFixed(3)} | ${row.slack.toFixed(3)} | ${row.limit.toFixed(3)} | ${row.failed ? 'FAIL' : 'PASS'} |`,
    ),
    '',
  ].join('\n');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'report.md'), report);
  writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        suite,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        base,
        head,
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(report);
  if (results.some((row) => row.failed)) process.exitCode = 1;
}
