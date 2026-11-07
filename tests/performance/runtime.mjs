import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measure, median, metrics as runtimeMetrics } from './workloads.mjs';
import { measureSessions, percentile, sessionMetrics } from './sessions.mjs';
import { OFFLINE_MESSAGE } from './no-network.mjs';
import { connect } from 'node:net';

const script = fileURLToPath(import.meta.url);
const regressed = (base, head, slack) => head > base * 1.3 + slack;

function sample(root) {
  return JSON.parse(
    execFileSync(process.execPath, ['--expose-gc', script, '--sample', root, '', suite], {
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 64 * 1024,
    }),
  );
}

const [mode, candidate, output, suite = 'runtime'] = process.argv.slice(2);
assert.ok(['runtime', 'sessions'].includes(suite));
const metrics = suite === 'sessions' ? sessionMetrics : runtimeMetrics;
if (mode === '--self-test') {
  assert.equal(regressed(10, 12, 0.2), false);
  assert.equal(regressed(10, 14, 0.2), true);
  assert.equal(regressed(0.01, 0.1, 0.2), false);
  assert.equal(median([9, 1, 3, 2, 4]), 3);
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
    JSON.stringify(await (suite === 'sessions' ? measureSessions : measure)(candidate)),
  );
} else {
  assert.ok(
    mode && candidate && output,
    'Usage: runtime.mjs <baseline-root> <candidate-root> <output-dir> [runtime|sessions]',
  );
  const base = [];
  const head = [];
  // Separate processes retain cold imports; alternate ordering to reduce thermal/time bias.
  for (let i = 0; i < 7; i++) {
    if (i % 2 === 0) {
      base.push(sample(mode));
      head.push(sample(candidate));
    } else {
      head.push(sample(candidate));
      base.push(sample(mode));
    }
  }
  const results = Object.entries(metrics).map(([metric, { unit, slack }]) => {
    const baseline = median(base.map((row) => row[metric]));
    const current = median(head.map((row) => row[metric]));
    assert.ok(
      Number.isFinite(baseline) && baseline >= 0 && Number.isFinite(current) && current >= 0,
    );
    return {
      metric,
      unit,
      slack,
      baseline,
      current,
      limit: baseline * 1.3 + slack,
      failed: regressed(baseline, current, slack),
    };
  });
  const report = [
    `## ${suite === 'sessions' ? 'Session engineering' : 'Runtime'} performance`,
    '',
    'Same-runner comparison, seven fresh processes per revision. Values are medians per operation (or per named batch). TCP connections and fetch requests are forbidden in performance workers; model tasks and service validation belong in Integration.',
    '',
    ...(suite === 'sessions'
      ? [
          'CLI readiness includes process startup and RPC initialization with no configured model. Hook pipelines dispatch real lifecycle events and project static contexts without submitting provider requests or executing tools. Resource growth is the maximum of checkpoints after 100/200/300/400/500 create/hook/shutdown cycles, relative to a warmed process after forced GC.',
          '',
        ]
      : [
          'Cold imports exclude Node startup. File I/O uses warm filesystem caches. Telemetry uses an in-memory SDK sink; its retained heap metric covers 100 exporter cycles.',
          '',
        ]),
    'Failure limit: baseline × 1.30 + per-metric noise margin, shown below. Initial margins need hosted-runner calibration. Resource-growth probes do not replace production soak tests.',
    '',
    '| Metric | Unit | Baseline | Candidate | Noise margin | Limit | Result |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...results.map(
      (row) =>
        `| ${row.metric} | ${row.unit} | ${row.baseline.toFixed(3)} | ${row.current.toFixed(3)} | ${row.slack} | ${row.limit.toFixed(3)} | ${row.failed ? 'FAIL' : 'PASS'} |`,
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
