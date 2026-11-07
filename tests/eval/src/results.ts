import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './pi-harness.js';

export interface TrialRow {
  task: string;
  trial: number;
  success: number;
  failureMode: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  totalTokens?: number;
}

export interface EvalResults {
  suite: string;
  taskSetHash: string;
  configuration: { model: string; thinking: string; piVersion: string };
  revision: string;
  dirty: boolean;
  expectedTrials: number;
  memoryEnabled?: boolean;
  rows: TrialRow[];
}

export function summarize(rows: TrialRow[]) {
  const passed = rows.filter((row) => row.success === 1);
  const nonCrash = rows.filter((row) => row.failureMode !== 'crash');
  const tasks = [...new Set(rows.map((row) => row.task))];
  const avg = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const failureMix: Record<string, number> = {};
  for (const row of rows) failureMix[row.failureMode] = (failureMix[row.failureMode] ?? 0) + 1;
  return {
    n: rows.length,
    successRate: rows.length ? passed.length / rows.length : null,
    nonCrashSuccessRate: nonCrash.length
      ? nonCrash.filter((row) => row.success === 1).length / nonCrash.length
      : null,
    crashRate: rows.length ? (rows.length - nonCrash.length) / rows.length : null,
    consistentTaskRate: tasks.length
      ? tasks.filter((task) =>
          rows.filter((row) => row.task === task).every((row) => row.success === 1),
        ).length / tasks.length
      : null,
    avgTurns: avg(passed.map((row) => row.turns)),
    avgToolCalls: avg(rows.map((row) => row.toolCalls)),
    avgDurationMs: avg(rows.map((row) => row.durationMs)),
    avgTokens:
      rows.length &&
      rows.every((row) => row.failureMode !== 'crash' && row.totalTokens !== undefined)
        ? avg(rows.map((row) => row.totalTokens!))
        : null,
    failureMix,
  };
}

export function resultMetadata(
  suite: string,
  files: string[],
  packageRoot: string,
  model: string,
  thinking: string,
  hcfg: HarnessConfig,
) {
  const taskSetHash = createHash('sha256');
  for (const file of [...files, 'src/pi-harness.ts', 'src/results.ts']) {
    taskSetHash.update(readFileSync(path.resolve(import.meta.dirname, '..', file)));
  }
  const provider = hcfg.modelsPath
    ? JSON.parse(readFileSync(hcfg.modelsPath, 'utf8')).providers?.[hcfg.provider]
    : { baseUrl: hcfg.baseUrl, api: hcfg.api };
  const providerHash = createHash('sha256')
    .update(JSON.stringify(provider ?? {}))
    .digest('hex');
  return {
    suite,
    taskSetHash: taskSetHash.digest('hex'),
    configuration: {
      model,
      thinking,
      providerHash,
      platform: process.platform,
      nodeVersion: process.version,
      piVersion: execFileSync('pi', ['--no-extensions', '--no-mcp', '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    },
    revision: execFileSync('git', ['-C', packageRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    dirty: Boolean(
      execFileSync(
        'git',
        ['-C', packageRoot, 'status', '--porcelain', '--untracked-files=normal', '--', 'packages'],
        { encoding: 'utf8' },
      ).trim(),
    ),
  };
}

const percent = (value: number | null) =>
  value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`;

export function compareResults(base: EvalResults, head: EvalResults): string {
  if (
    base.suite !== head.suite ||
    base.taskSetHash !== head.taskSetHash ||
    JSON.stringify(base.configuration) !== JSON.stringify(head.configuration)
  ) {
    throw new Error('Comparison requires the same suite, graders, model, thinking and Pi version.');
  }
  if (
    !Number.isInteger(base.expectedTrials) ||
    base.expectedTrials < 1 ||
    !Number.isInteger(head.expectedTrials) ||
    head.expectedTrials < 1 ||
    base.rows.length !== base.expectedTrials ||
    head.rows.length !== head.expectedTrials
  )
    throw new Error('Cannot compare incomplete runs.');
  const validate = (rows: TrialRow[]) => {
    if (!rows.length) throw new Error('Cannot compare empty runs.');
    const keys = rows.map((row) => {
      if (
        !row.task ||
        !Number.isInteger(row.trial) ||
        row.trial < 1 ||
        ![0, 1].includes(row.success)
      )
        throw new Error('Invalid trial row.');
      return JSON.stringify([row.task, row.trial]);
    });
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate task/trial.');
    return keys.sort();
  };
  if (JSON.stringify(validate(base.rows)) !== JSON.stringify(validate(head.rows)))
    throw new Error('Task/trial sets differ.');
  const b = summarize(base.rows);
  const h = summarize(head.rows);
  const lines = [
    `# ${head.suite} comparison`,
    '',
    `Model: ${head.configuration.model}; thinking: ${head.configuration.thinking}; Pi: ${head.configuration.piVersion}.`,
    '',
    `Base: ${base.revision}${base.dirty ? ' (dirty)' : ''}; head: ${head.revision}${head.dirty ? ' (dirty)' : ''}.`,
    '',
    ...(base.memoryEnabled !== undefined
      ? [`Memory enabled: base=${base.memoryEnabled}; head=${head.memoryEnabled}.`, '']
      : []),
    '| Metric | Base | Head |',
    '| --- | ---: | ---: |',
    `| Completion (all trials) | ${percent(b.successRate)} | ${percent(h.successRate)} |`,
    `| Completion (non-crashed trials) | ${percent(b.nonCrashSuccessRate)} | ${percent(h.nonCrashSuccessRate)} |`,
    `| Crashes (cause unclassified) | ${percent(b.crashRate)} | ${percent(h.crashRate)} |`,
    `| Tasks passing every trial | ${percent(b.consistentTaskRate)} | ${percent(h.consistentTaskRate)} |`,
    `| Mean turns (successful trials) | ${b.avgTurns} | ${h.avgTurns} |`,
    `| Mean tool calls | ${b.avgToolCalls} | ${h.avgToolCalls} |`,
    `| Mean duration (ms) | ${b.avgDurationMs} | ${h.avgDurationMs} |`,
    `| Mean tokens (reported) | ${b.avgTokens ?? 'unknown'} | ${h.avgTokens ?? 'unknown'} |`,
    '',
    '| Task | Base passes | Head passes | Change |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const task of new Set(base.rows.map((row) => row.task))) {
    const before = base.rows.filter((row) => row.task === task);
    const after = head.rows.filter((row) => row.task === task);
    const bp = before.reduce((sum, row) => sum + row.success, 0);
    const hp = after.reduce((sum, row) => sum + row.success, 0);
    lines.push(
      `| ${task.replaceAll('|', '\\|')} | ${bp}/${before.length} | ${hp}/${after.length} | ${hp < bp ? 'regression' : hp > bp ? 'improvement' : 'unchanged'} |`,
    );
  }
  return `${lines.join('\n')}\n\nDescriptive comparison only; small trial counts do not establish statistical significance. Crashes remain in the completion denominator.\n`;
}
