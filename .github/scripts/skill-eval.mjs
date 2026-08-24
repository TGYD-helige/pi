#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKILL_PATH = /^(packages\/[^/]+\/skills\/[^/]+)(?:\/|$)/;

export function selectSkillChanges(changedFiles, hasPath) {
  const roots = [
    ...new Set(changedFiles.map((file) => SKILL_PATH.exec(file)?.[1]).filter(Boolean)),
  ].sort();

  return roots.flatMap((path) => {
    if (!changedFiles.some((file) => file.startsWith(`${path}/`) && file !== `${path}/evals.json`)) {
      return [];
    }
    const skillFile = `${path}/SKILL.md`;
    const inBase = hasPath('base', skillFile);
    const inHead = hasPath('head', skillFile);
    if (!inHead) return [];
    return [{ type: inBase ? 'modified' : 'added', path }];
  });
}

function requireString(value, label, max = 20_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string up to ${max} characters`);
  }
}

function requireStringList(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`${label} must be a non-empty array with at most 20 entries`);
  }
  for (const [index, item] of value.entries()) requireString(item, `${label}[${index}]`, 500);
}

export function validateEvalSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evals.json must contain an object');
  }
  requireString(value.skill_name, 'skill_name', 64);
  if (!/^[a-z0-9-]+$/.test(value.skill_name)) {
    throw new Error('skill_name must use lowercase letters, digits, and hyphens');
  }
  if (!Array.isArray(value.evals) || value.evals.length < 3 || value.evals.length > 5) {
    throw new Error('evals must contain between 3 and 5 cases');
  }

  const ids = new Set();
  for (const [index, item] of value.evals.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`evals[${index}] must be an object`);
    }
    const id = String(item.id ?? '');
    requireString(id, `evals[${index}].id`, 80);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error('eval id must use lowercase letters, digits, and hyphens');
    }
    if (ids.has(id)) throw new Error(`duplicate eval id "${id}"`);
    ids.add(id);
    requireString(item.prompt, `evals[${index}].prompt`);
    requireString(item.expected_output, `evals[${index}].expected_output`);
    if (!Array.isArray(item.expectations) || item.expectations.length === 0 || item.expectations.length > 20) {
      throw new Error(`evals[${index}].expectations must be a non-empty array with at most 20 entries`);
    }
    for (const [expectationIndex, expectation] of item.expectations.entries()) {
      const label = `evals[${index}].expectations[${expectationIndex}]`;
      if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
        throw new Error(`${label} must be an object`);
      }
      requireString(expectation.text, `${label}.text`, 500);
      requireStringList(expectation.includes, `${label}.includes`);
      requireStringList(expectation.includes_any, `${label}.includes_any`);
      requireStringList(expectation.excludes, `${label}.excludes`);
      if (!expectation.includes && !expectation.includes_any && !expectation.excludes) {
        throw new Error(`${label} must define includes, includes_any, or excludes`);
      }
    }
  }
  return value;
}

export function selectRegressionEvalSet(base, head) {
  if (base.skill_name !== head.skill_name) throw new Error('base and head skill_name must match');
  return base;
}

const normalizeForMatching = (value) =>
  value.toLowerCase().replace(/\bdon['’]t\b/g, 'do not').replace(/[*_`]+/g, '');

export function gradeExpectations(answer, expectations) {
  const haystack = normalizeForMatching(answer);
  const graded = expectations.map((expectation) => {
    const includes = expectation.includes ?? [];
    const includesAny = expectation.includes_any ?? [];
    const excludes = expectation.excludes ?? [];
    const missing = includes.filter((value) => !haystack.includes(normalizeForMatching(value)));
    const matchedAny = includesAny.filter((value) => haystack.includes(normalizeForMatching(value)));
    const unexpected = excludes.filter((value) => haystack.includes(normalizeForMatching(value)));
    const passed = missing.length === 0 && (includesAny.length === 0 || matchedAny.length > 0) && unexpected.length === 0;

    const evidence = passed
      ? [
          includes.length ? `included: ${includes.join(', ')}` : '',
          includesAny.length ? `included one of: ${includesAny.join(', ')}` : '',
          excludes.length ? `excluded: ${excludes.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ')
      : [
          missing.length ? `missing: ${missing.join(', ')}` : '',
          includesAny.length && matchedAny.length === 0
            ? `missing every alternative: ${includesAny.join(', ')}`
            : '',
          unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ');
    return { text: expectation.text, passed, evidence };
  });
  const passed = graded.filter((expectation) => expectation.passed).length;
  return { passed, total: graded.length, score: passed / graded.length, expectations: graded };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function scoresFor(runs, configuration, evalIds) {
  const allowed = evalIds ? new Set(evalIds.map(String)) : undefined;
  return runs.filter(
    (run) => run.configuration === configuration && (!allowed || allowed.has(String(run.eval_id))),
  );
}

export function evaluateGate({
  type,
  runs,
  baseEvalIds = [],
  minScore = 0.8,
  minDelta = 0.1,
  minCases = 3,
}) {
  const reasons = [];
  const failedRuns = runs.filter((run) => run.failure_mode !== 'ok');
  if (failedRuns.length) reasons.push(`${failedRuns.length} run(s) failed before grading`);

  const gateIds = type === 'modified' && baseEvalIds.length ? baseEvalIds : undefined;
  const candidate = scoresFor(runs, 'candidate', gateIds);
  const baseline = scoresFor(runs, 'baseline', gateIds);
  if (!candidate.length || !baseline.length) reasons.push('candidate and baseline runs are both required');

  const candidateScore = candidate.length ? mean(candidate.map((run) => run.score)) : 0;
  const baselineScore = baseline.length ? mean(baseline.map((run) => run.score)) : 0;
  const delta = candidateScore - baselineScore;

  if (type === 'added') {
    const evalCount = new Set(candidate.map((run) => String(run.eval_id))).size;
    if (evalCount < minCases) reasons.push(`new skills require at least ${minCases} eval cases`);
    if (candidateScore < minScore) reasons.push(`candidate score ${candidateScore.toFixed(3)} is below ${minScore.toFixed(3)}`);
    if (delta < minDelta) reasons.push(`candidate delta ${delta.toFixed(3)} is below +${minDelta.toFixed(3)}`);
  } else {
    if (delta < 0) reasons.push(`candidate aggregate regressed by ${delta.toFixed(3)}`);
    for (const evalId of new Set(candidate.map((run) => String(run.eval_id)))) {
      const candidateEval = candidate.filter((run) => String(run.eval_id) === evalId);
      const baselineEval = baseline.filter((run) => String(run.eval_id) === evalId);
      if (baselineEval.length && mean(candidateEval.map((run) => run.score)) < mean(baselineEval.map((run) => run.score))) {
        reasons.push(`${evalId} regressed`);
      }
    }
  }

  return { passed: reasons.length === 0, candidateScore, baselineScore, delta, reasons };
}

export function formatComment(results, { runUrl, artifactName, error }) {
  const passed = !error && results.length > 0 && results.every((result) => result.gate.passed);
  const lines = [
    `### ${passed ? '✅ Skill Eval — passed' : '❌ Skill Eval — failed'}`,
    '',
    '| skill | change | candidate | baseline | delta | gate |',
    '|---|---|---:|---:|---:|:---:|',
  ];
  for (const result of results) {
    const { gate } = result;
    lines.push(
      `| \`${result.skill}\` | ${result.type} | ${gate.candidateScore.toFixed(3)} | ${gate.baselineScore.toFixed(3)} | ${gate.delta >= 0 ? '+' : ''}${gate.delta.toFixed(3)} | ${gate.passed ? '✅' : '❌'} |`,
    );
  }
  const failures = results.flatMap((result) =>
    result.gate.reasons.map((reason) => `- \`${result.skill}\`: ${reason}`),
  );
  if (failures.length) lines.push('', '**Failures**', '', ...failures);
  if (error) lines.push('', '**Infrastructure failure**', '', error);
  lines.push(
    '',
    'New skills require score ≥ 0.800 and delta ≥ +0.100. Modified skills must not regress on any master eval.',
    '',
    `[Workflow logs](${runUrl}) · Artifact: \`${artifactName}\``,
    '',
    '<sub>Pi skill eval bot</sub>',
  );
  return `${lines.join('\n')}\n`;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
}

function revisionHasPath(revision, file) {
  try {
    git(['cat-file', '-e', `${revision}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

function readJsonAt(revision, file) {
  try {
    return JSON.parse(git(['show', `${revision}:${file}`]));
  } catch (error) {
    throw new Error(`cannot read ${file} at ${revision}: ${error instanceof Error ? error.message : error}`);
  }
}

function materializeSkill(revision, skillRoot, destination) {
  const listing = git(['ls-tree', '-r', '-z', revision, '--', skillRoot]);
  let total = 0;
  for (const record of listing.split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(record);
    if (!match || match[2] !== 'blob' || !match[1].startsWith('100')) {
      throw new Error(`unsupported git entry under ${skillRoot}`);
    }
    const [, , , oid, file] = match;
    const relative = path.relative(skillRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`unsafe skill path: ${file}`);
    }
    const size = Number(git(['cat-file', '-s', oid]));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${file} has an invalid size`);
    total += size;
    if (total > 5 * 1024 * 1024) throw new Error(`${skillRoot} exceeds the 5 MiB skill-eval limit`);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, git(['cat-file', 'blob', oid], { encoding: null, maxBuffer: size + 1024 }));
  }
  if (!revisionHasPath(revision, `${skillRoot}/SKILL.md`)) {
    throw new Error(`${skillRoot}/SKILL.md is missing at ${revision}`);
  }
}

function skillName(skillFile) {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(readFileSync(skillFile, 'utf8'))?.[1] ?? '';
  const name = /^name:\s*["']?([^\s"']+)["']?\s*$/m.exec(frontmatter)?.[1];
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(`${skillFile} has an invalid name`);
  return name;
}

function runPi({ cwd, skillDir, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      '--provider',
      process.env.SKILL_EVAL_PROVIDER || 'deepseek-integration',
      '--model',
      process.env.SKILL_EVAL_MODEL || 'deepseek-v4-flash',
      '--thinking',
      process.env.SKILL_EVAL_THINKING || 'high',
      '--system-prompt',
      'Answer the user request directly. Do not call or simulate tools. Follow any appended skill instructions as the governing workflow.',
      '--no-session',
      '--no-context-files',
      '--approve',
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-tools',
    ];
    if (skillDir) args.push('--append-system-prompt', path.join(skillDir, 'SKILL.md'));
    args.push('--mode', 'text', '-p', prompt);

    const child = spawn('pi', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let killedForSize = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 256 * 1024) {
        killedForSize = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ answer: '', failure_mode: 'crash', error: error.message.slice(0, 300), duration_ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const answer = stdout.trim().slice(0, 20_000);
      const failure =
        killedForSize ? 'Pi output exceeded 256 KiB' : signal === 'SIGKILL' ? `Pi timed out after ${timeoutMs}ms` : code !== 0 ? `Pi exited with code ${code}` : !answer ? 'Pi returned no assistant text' : '';
      resolve({
        answer,
        failure_mode: failure ? 'crash' : 'ok',
        ...(failure ? { error: failure } : {}),
        duration_ms: Date.now() - started,
      });
    });
  });
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);
}

function writeRun(workspace, evalItem, configuration, runNumber, run) {
  const evalDir = path.join(workspace, `eval-${safeSegment(evalItem.id)}`);
  const runDir = path.join(evalDir, configuration, `run-${runNumber}`);
  const outputsDir = path.join(runDir, 'outputs');
  mkdirSync(outputsDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'eval_metadata.json'),
    `${JSON.stringify({
      eval_id: evalItem.id,
      eval_name: evalItem.id,
      prompt: evalItem.prompt,
      expected_output: evalItem.expected_output,
    }, null, 2)}\n`,
  );
  writeFileSync(path.join(outputsDir, 'response.md'), `${run.answer || `Evaluation failed: ${run.error ?? 'unknown error'}`}\n`);
  writeFileSync(
    path.join(runDir, 'grading.json'),
    `${JSON.stringify(
      {
        expected_output: evalItem.expected_output,
        expectations: run.grading.expectations,
        summary: {
          passed: run.grading.passed,
          failed: run.grading.total - run.grading.passed,
          total: run.grading.total,
          pass_rate: run.grading.score,
        },
        execution_metrics: { errors_encountered: run.failure_mode === 'ok' ? 0 : 1 },
        timing: { total_duration_seconds: run.duration_ms / 1000 },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(runDir, 'timing.json'),
    `${JSON.stringify({ duration_ms: run.duration_ms, total_duration_seconds: run.duration_ms / 1000 }, null, 2)}\n`,
  );
}

function stats(values) {
  const average = values.length ? mean(values) : 0;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
    : 0;
  return {
    mean: average,
    stddev: Math.sqrt(variance),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

function viewerConfiguration(type, configuration) {
  if (type === 'added') return configuration === 'candidate' ? 'with_skill' : 'without_skill';
  return configuration === 'candidate' ? 'new_skill' : 'old_skill';
}

function buildBenchmark({ skill, skillPath, type, runs, runCount, gate }) {
  const candidate = viewerConfiguration(type, 'candidate');
  const baseline = viewerConfiguration(type, 'baseline');
  const label = (configuration) => viewerConfiguration(type, configuration);
  const grouped = Object.fromEntries(
    [candidate, baseline].map((configuration) => {
      const values = runs.filter((run) => label(run.configuration) === configuration);
      return [
        configuration,
        {
          pass_rate: stats(values.map((run) => run.score)),
          time_seconds: stats(values.map((run) => run.duration_ms / 1000)),
        },
      ];
    }),
  );
  const timeDelta = grouped[candidate].time_seconds.mean - grouped[baseline].time_seconds.mean;
  return {
    metadata: {
      skill_name: skill,
      skill_path: skillPath,
      executor_model: process.env.SKILL_EVAL_MODEL || 'deepseek-v4-flash',
      timestamp: new Date().toISOString(),
      evals_run: [...new Set(runs.map((run) => run.eval_id))],
      runs_per_configuration: runCount,
    },
    runs: runs.map((run) => ({
      eval_id: run.eval_id,
      eval_name: run.eval_id,
      configuration: label(run.configuration),
      run_number: run.run_number,
      result: {
        pass_rate: run.score,
        passed: run.grading.passed,
        failed: run.grading.total - run.grading.passed,
        total: run.grading.total,
        time_seconds: run.duration_ms / 1000,
        tool_calls: 0,
        errors: run.failure_mode === 'ok' ? 0 : 1,
      },
      expectations: run.grading.expectations,
      notes: run.error ? [run.error] : [],
    })),
    run_summary: {
      ...grouped,
      delta: {
        pass_rate: `${gate.delta >= 0 ? '+' : ''}${gate.delta.toFixed(3)}`,
        time_seconds: `${timeDelta >= 0 ? '+' : ''}${timeDelta.toFixed(3)}`,
      },
    },
    notes: gate.reasons,
  };
}

async function evaluateSkill({ change, base, head, tempRoot, outputRoot, cwd, runCount, timeoutMs }) {
  const candidateDir = path.join(tempRoot, 'candidate', change.path);
  materializeSkill(head, change.path, candidateDir);
  const skill = skillName(path.join(candidateDir, 'SKILL.md'));
  const evalPath = `${change.path}/evals.json`;
  if (!revisionHasPath(head, evalPath)) throw new Error(`${evalPath} is required`);
  const headEvals = validateEvalSet(readJsonAt(head, evalPath));
  if (headEvals.skill_name !== skill) throw new Error(`${evalPath} skill_name must be "${skill}"`);

  let evalSet = headEvals;
  let baseEvalIds = [];
  let baselineDir;
  if (change.type === 'modified') {
    baselineDir = path.join(tempRoot, 'baseline', change.path);
    materializeSkill(base, change.path, baselineDir);
    if (!revisionHasPath(base, evalPath)) throw new Error(`modified skills require ${evalPath} on the base revision`);
    const baseEvals = validateEvalSet(readJsonAt(base, evalPath));
    evalSet = selectRegressionEvalSet(baseEvals, headEvals);
    baseEvalIds = baseEvals.evals.map((item) => String(item.id));
  }

  const workspace = path.join(outputRoot, safeSegment(skill));
  mkdirSync(workspace, { recursive: true });
  const runs = [];
  for (const evalItem of evalSet.evals) {
    for (let runNumber = 1; runNumber <= runCount; runNumber++) {
      const [candidateRun, baselineRun] = await Promise.all([
        runPi({ cwd, skillDir: candidateDir, prompt: evalItem.prompt, timeoutMs }),
        runPi({ cwd, skillDir: baselineDir, prompt: evalItem.prompt, timeoutMs }),
      ]);
      for (const [configuration, result] of [
        ['candidate', candidateRun],
        ['baseline', baselineRun],
      ]) {
        const grading = result.failure_mode === 'ok'
          ? gradeExpectations(result.answer, evalItem.expectations)
          : {
              passed: 0,
              total: evalItem.expectations.length,
              score: 0,
              expectations: evalItem.expectations.map((expectation) => ({
                text: expectation.text,
                passed: false,
                evidence: result.error ?? 'evaluation failed',
              })),
            };
        const run = {
          ...result,
          configuration,
          eval_id: String(evalItem.id),
          run_number: runNumber,
          score: grading.score,
          grading,
        };
        runs.push(run);
        const viewerConfig = viewerConfiguration(change.type, configuration);
        writeRun(workspace, evalItem, viewerConfig, runNumber, run);
      }
    }
  }

  const gate = evaluateGate({ type: change.type, runs, baseEvalIds });
  const benchmark = buildBenchmark({
    skill,
    skillPath: change.path,
    type: change.type,
    runs,
    runCount,
    gate,
  });
  writeFileSync(path.join(workspace, 'benchmark.json'), `${JSON.stringify(benchmark, null, 2)}\n`);
  return { skill, type: change.type, path: change.path, gate };
}

function findSkillChanges(base, head) {
  const changedFiles = git(['diff', '--name-only', '--no-renames', '-z', base, head])
    .split('\0')
    .filter(Boolean);
  return selectSkillChanges(changedFiles, (revision, file) =>
    revisionHasPath(revision === 'base' ? base : head, file),
  );
}

function writeReport({ outputRoot, base, head, results, error }) {
  const summary = { base, head, skills: results, ...(error ? { error: 'evaluation infrastructure failed' } : {}) };
  writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const comment = formatComment(results, {
    runUrl: process.env.SKILL_EVAL_RUN_URL || '#',
    artifactName: process.env.SKILL_EVAL_ARTIFACT || 'skill-eval-results',
    error,
  });
  writeFileSync(path.join(outputRoot, 'comment.md'), comment);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, comment, { flag: 'a' });
}

async function main() {
  const base = process.env.SKILL_EVAL_BASE_SHA;
  const head = process.env.SKILL_EVAL_HEAD_SHA;
  if (!base || !head) throw new Error('SKILL_EVAL_BASE_SHA and SKILL_EVAL_HEAD_SHA are required');
  const changes = findSkillChanges(base, head);
  if (process.argv.includes('--detect')) {
    process.stdout.write(changes.map((change) => `${change.type}\t${change.path}`).join('\n'));
    return;
  }

  const runCount = Number(process.env.SKILL_EVAL_RUNS || '3');
  const timeoutMs = Number(process.env.SKILL_EVAL_TIMEOUT_MS || '120000');
  if (!Number.isInteger(runCount) || runCount < 1 || runCount > 5) throw new Error('SKILL_EVAL_RUNS must be 1..5');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('SKILL_EVAL_TIMEOUT_MS must be 1000..600000');

  const cwd = process.cwd();
  const outputRoot = path.resolve(process.env.SKILL_EVAL_OUTPUT_DIR || 'skill-eval-results');
  mkdirSync(outputRoot, { recursive: true });
  if (!changes.length) throw new Error('no added or modified skills found');
  if (changes.length > 3) throw new Error('a single PR may evaluate at most 3 skills');

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-skill-eval-'));
  const results = [];
  try {
    for (const change of changes) {
      process.stderr.write(`[skill-eval] ${change.type} ${change.path}\n`);
      results.push(
        await evaluateSkill({ change, base, head, tempRoot, outputRoot, cwd, runCount, timeoutMs }),
      );
    }
    writeReport({ outputRoot, base, head, results });
    if (results.some((result) => !result.gate.passed)) process.exitCode = 1;
  } catch (error) {
    writeReport({
      outputRoot,
      base,
      head,
      results,
      error: 'Evaluation infrastructure failed before all skills completed. See the workflow logs.',
    });
    throw error;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const outputRoot = path.resolve(process.env.SKILL_EVAL_OUTPUT_DIR || 'skill-eval-results');
    mkdirSync(outputRoot, { recursive: true });
    const comment = [
      '### ❌ Skill Eval — failed',
      '',
      'Evaluation infrastructure failed before producing scores. See the workflow logs.',
      '',
      `[Workflow logs](${process.env.SKILL_EVAL_RUN_URL || '#'})`,
      '',
    ].join('\n');
    if (!existsSync(path.join(outputRoot, 'comment.md'))) writeFileSync(path.join(outputRoot, 'comment.md'), comment);
    if (!existsSync(path.join(outputRoot, 'summary.json'))) {
      writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify({ error: 'evaluation infrastructure failed' }, null, 2)}\n`);
    }
    console.error(`[skill-eval] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
