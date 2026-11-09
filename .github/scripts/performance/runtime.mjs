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
import { availableMetrics, discoverExtensions, extensions } from './plugins.mjs';

const script = fileURLToPath(import.meta.url);
const dispersion = (values) => {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
};
const regressed = (base, head, slack) => head > base * 1.3 + slack;

function compare(metrics, base, head, baselineExtensions, candidateExtensions) {
  const baselineMetrics = availableMetrics(metrics, baselineExtensions);
  const candidateMetrics = availableMetrics(metrics, candidateExtensions);
  const inventoryChanged =
    JSON.stringify(baselineExtensions) !== JSON.stringify(candidateExtensions);
  return Object.entries(metrics).flatMap(([metric, { unit, slack }]) => {
    const hasBase = metric in baselineMetrics;
    const hasHead = metric in candidateMetrics;
    if (!hasBase && !hasHead) return [];
    for (const row of hasBase ? base : [])
      assert.ok(
        Number.isFinite(row[metric]) && row[metric] >= 0,
        `Invalid baseline metric: ${metric}`,
      );
    for (const row of hasHead ? head : [])
      assert.ok(
        Number.isFinite(row[metric]) && row[metric] >= 0,
        `Invalid candidate metric: ${metric}`,
      );
    const baseline = hasBase ? median(base.map((row) => row[metric])) : null;
    const current = hasHead ? median(head.map((row) => row[metric])) : null;
    const baselineMad = hasBase ? dispersion(base.map((row) => row[metric])) : null;
    const effectiveSlack = hasBase ? Math.max(slack, 3 * baselineMad) : null;
    const status = !hasBase
      ? 'ADDED'
      : !hasHead
        ? 'REMOVED'
        : inventoryChanged && (metric.startsWith('profile.all.') || metric.startsWith('soak'))
          ? 'NOT_COMPARABLE'
          : 'COMPARED';
    const failed = status === 'COMPARED' && regressed(baseline, current, effectiveSlack);
    return [
      {
        metric,
        unit,
        configuredSlack: slack,
        slack: effectiveSlack,
        baselineMad,
        baseline,
        current,
        limit: status === 'COMPARED' ? baseline * 1.3 + effectiveSlack : null,
        status,
        failed,
      },
    ];
  });
}
const display = (value) => (value === null ? '—' : value.toFixed(3));

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
  const coverageMetrics = {
    shared: { unit: 'ms', slack: 1 },
    added: { unit: 'ms', slack: 1, plugin: 'new' },
    removed: { unit: 'ms', slack: 1, plugin: 'old' },
    'profile.all.startupMs': { unit: 'ms', slack: 1 },
    soakCycleMedianMs: { unit: 'ms', slack: 1 },
  };
  const baseSample = { shared: 10, removed: 3, 'profile.all.startupMs': 4, soakCycleMedianMs: 2 };
  const headSample = { shared: 20, added: 5, 'profile.all.startupMs': 8, soakCycleMedianMs: 7 };
  const coverage = compare(coverageMetrics, [baseSample], [headSample], ['old'], ['new']);
  assert.deepEqual(
    coverage.map(({ status }) => status),
    ['COMPARED', 'ADDED', 'REMOVED', 'NOT_COMPARABLE', 'NOT_COMPARABLE'],
  );
  assert.equal(coverage[0].failed, true);
  assert.equal(coverage[1].baseline, null);
  assert.equal(coverage[2].current, null);
  assert.equal(coverage[3].limit, null);
  assert.deepEqual(availableMetrics({ combo: { requires: ['old', 'new'] } }, ['old']), {});
  const combinationMetrics = {
    'profile.all.startupMs': { unit: 'ms', slack: 1 },
    soakCycleMedianMs: { unit: 'ms', slack: 1 },
  };
  const sameInventory = compare(combinationMetrics, [baseSample], [headSample], [], []);
  assert.ok(sameInventory.every(({ status, failed }) => status === 'COMPARED' && failed));

  assert.throws(
    () => compare(coverageMetrics, [baseSample], [{}], ['old'], ['new']),
    /Invalid candidate metric/,
  );
  assert.throws(
    () => compare(coverageMetrics, [{}], [headSample], ['old'], ['new']),
    /Invalid baseline metric/,
  );
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
  const baselineExtensions = await discoverExtensions(mode);
  const candidateExtensions = await discoverExtensions(candidate);
  assert.deepEqual(
    candidateExtensions,
    [...extensions].sort(),
    'Update performance coverage when adding or removing an extension',
  );
  const addedExtensions = candidateExtensions.filter((name) => !baselineExtensions.includes(name));
  const removedExtensions = baselineExtensions.filter(
    (name) => !candidateExtensions.includes(name),
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
  const results = compare(metrics, base, head, baselineExtensions, candidateExtensions);
  const report = [
    `## ${suite} performance`,
    '',
    `Same-runner comparison, ${pairs} fresh process(es) per revision. Values are medians per operation (or per named batch). TCP connections and fetch requests are forbidden; model tasks and service validation belong in Integration.`,
    '',
    `Added extensions: ${addedExtensions.join(', ') || 'none'}. Removed extensions: ${removedExtensions.join(', ') || 'none'}. ADDED/REMOVED metrics have no two-sided comparison. All-extension profile and soak metrics are NOT_COMPARABLE when extension inventories differ; their measurements and assertions still run.`,
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
        `| ${row.metric} | ${row.unit} | ${display(row.baseline)} | ${display(row.current)} | ${display(row.baselineMad)} | ${display(row.slack)} | ${display(row.limit)} | ${row.status === 'COMPARED' ? (row.failed ? 'FAIL' : 'PASS') : row.status} |`,
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
        coverage: { baselineExtensions, candidateExtensions, addedExtensions, removedExtensions },
      },
      null,
      2,
    ),
  );
  process.stdout.write(report);
  if (results.some((row) => row.failed)) process.exitCode = 1;
}
