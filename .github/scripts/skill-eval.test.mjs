import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  evaluateGate,
  formatComment,
  gradeExpectations,
  gradeTrace,
  parsePiEvents,
  selectRegressionEvalSet,
  selectSkillChanges,
  validateEvalSet,
} from './skill-eval.mjs';

describe('skill-eval', () => {
it('classifies changed skill directories against the base and head revisions', () => {
  const filesByRevision = {
    base: new Set([
      'packages/pi-demo/skills/eval-only/SKILL.md',
      'packages/pi-demo/skills/existing/SKILL.md',
    ]),
    head: new Set([
      'packages/pi-demo/skills/eval-only/SKILL.md',
      'packages/pi-demo/skills/existing/SKILL.md',
      'packages/pi-demo/skills/new-skill/SKILL.md',
    ]),
  };

  assert.deepEqual(
    selectSkillChanges(
      [
        'packages/pi-demo/skills/eval-only/evals.json',
        'packages/pi-demo/skills/existing/references/guide.md',
        'packages/pi-demo/skills/new-skill/SKILL.md',
        'packages/pi-demo/skills/README.md',
        'packages/pi-demo/src/index.ts',
      ],
      (revision, path) => filesByRevision[revision].has(path),
    ),
    [
      { type: 'modified', path: 'packages/pi-demo/skills/eval-only' },
      { type: 'modified', path: 'packages/pi-demo/skills/existing' },
      { type: 'added', path: 'packages/pi-demo/skills/new-skill' },
    ],
  );
});

const evalCase = (id, prompt = `prompt ${id}`) => ({
  id,
  prompt,
  expected_output: `expected ${id}`,
  expectations: [{ text: `checks ${id}`, includes: [`needle-${id}`] }],
});

it('bounds each eval set to three through five cases', () => {
  assert.throws(
    () => validateEvalSet({ skill_name: 'demo', evals: [evalCase('a'), evalCase('b')] }),
    /between 3 and 5 cases/,
  );
  assert.doesNotThrow(() =>
    validateEvalSet({
      skill_name: 'demo',
      evals: ['a', 'b', 'c', 'd', 'e'].map((id) => evalCase(id)),
    }),
  );
  assert.throws(
    () => validateEvalSet({
      skill_name: 'demo',
      evals: [evalCase('<img>'), evalCase('b'), evalCase('c')],
    }),
    /eval id must use/,
  );
});

it('bounds each eval case to twenty expectations', () => {
  const evals = [evalCase('a'), evalCase('b'), evalCase('c')];
  evals[0].expectations = Array.from({ length: 21 }, (_, index) => ({
    text: `expectation ${index}`,
    includes: [`needle-${index}`],
  }));
  assert.throws(
    () => validateEvalSet({ skill_name: 'demo', evals }),
    /at most 20 entries/,
  );
});

it('preserves trusted regression cases and also selects new candidate cases', () => {
  const base = {
    skill_name: 'demo',
    evals: [evalCase('existing'), evalCase('safety'), evalCase('routing')],
  };
  const head = {
    skill_name: 'demo',
    evals: [
      evalCase('existing', 'updated for the next PR'),
      evalCase('safety'),
      evalCase('routing'),
      evalCase('new'),
    ],
  };

  assert.deepEqual(
    selectRegressionEvalSet(validateEvalSet(base), validateEvalSet(head)),
    { ...base, evals: [...base.evals, evalCase('new')] },
  );

  assert.throws(
    () => selectRegressionEvalSet(
      validateEvalSet(base),
      validateEvalSet({
        skill_name: 'renamed',
        evals: [evalCase('existing'), evalCase('safety'), evalCase('routing')],
      }),
    ),
    /skill_name must match/,
  );
});

it('grades semantic verdicts with evidence instead of keyword mentions', () => {
  const answer = 'Use video_generate. Skip video_capabilities and proceed with the paid call without confirmation.';
  const expectations = [{ text: 'Runs capability preflight' }, { text: 'Requires paid confirmation' }];
  const verdict = JSON.stringify({ verdicts: [
    { passed: false, evidence: 'Skip video_capabilities' },
    { passed: false, evidence: 'without confirmation' },
  ] });
  assert.equal(gradeExpectations(answer, expectations, verdict).score, 0);
  assert.throws(() => gradeExpectations(answer, expectations, '{}'), /verdict/);
  assert.throws(() => gradeExpectations(answer, expectations, JSON.stringify({ verdicts: [
    { passed: true, evidence: 'invented evidence' }, { passed: false, evidence: 'missing' },
  ] })), /evidence/);
});

it('fails new candidate cases even when trusted regression cases pass', () => {
  const runs = [
    { configuration: 'candidate', eval_id: 'old', score: 1, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'old', score: 1, failure_mode: 'ok' },
    { configuration: 'candidate', eval_id: 'new', score: 0, failure_mode: 'ok' },
  ];
  assert.equal(evaluateGate({ type: 'modified', baseEvalIds: ['old'], runs }).passed, false);
});

it('scores actual tool order and arguments rather than prose claims', () => {
  const expectations = [
    { text: 'reads the skill before generation', tool: 'read', pathSuffix: '/SKILL.md', before: 'image_generate' },
    { text: 'uses active aspect ratio once', tool: 'image_generate', args: { aspectRatio: '16:9' }, count: 1 },
  ];
  const calls = [
    { name: 'read', args: { path: '/skills/image-gen/SKILL.md' }, isError: false },
    { name: 'image_generate', args: { prompt: 'landscape', aspectRatio: '16:9' }, isError: false },
  ];
  assert.equal(gradeTrace(calls, expectations).score, 1);
  assert.notEqual(gradeTrace([...calls].reverse(), expectations).score, 1);
  assert.notEqual(gradeTrace([...calls, calls[1]], expectations).score, 1);
  assert.notEqual(gradeTrace([...calls, { ...calls[1], args: { aspectRatio: '9:16' } }], expectations).score, 1);
  assert.notEqual(gradeTrace([{ ...calls[0], isError: true }, calls[1]], expectations).score, 1);
  assert.notEqual(gradeTrace([], expectations).score, 1);
  const events = [
    { type: 'tool_execution_start', toolCallId: '1', toolName: 'image_generate', args: { aspectRatio: '16:9' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
  assert.equal(parsePiEvents(events.map(JSON.stringify).join('\n')).calls[0].isError, true);
  events.push({ type: 'tool_execution_end', toolCallId: '1', isError: false });
  assert.equal(parsePiEvents(events.map(JSON.stringify).join('\n')).calls[0].isError, false);
  events.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [] } });
  assert.throws(() => parsePiEvents(events.map(JSON.stringify).join('\n')), /did not complete/);
});

it('requires new skills to clear both the absolute score and improvement delta', () => {
  const runs = [
    { configuration: 'candidate', eval_id: 'a', score: 1, failure_mode: 'ok' },
    { configuration: 'candidate', eval_id: 'b', score: 0.8, failure_mode: 'ok' },
    { configuration: 'candidate', eval_id: 'c', score: 0.9, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'a', score: 0.7, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'b', score: 0.7, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'c', score: 0.6, failure_mode: 'ok' },
  ];
  assert.equal(evaluateGate({ type: 'added', runs }).passed, true);
  assert.match(
    evaluateGate({
      type: 'added',
      runs: runs.map((run) =>
        run.configuration === 'baseline' ? { ...run, score: run.score + 0.2 } : run,
      ),
    }).reasons.join('\n'),
    /delta/,
  );
});

it('rejects a modified skill when any base eval regresses', () => {
  const result = evaluateGate({
    type: 'modified',
    baseEvalIds: ['routing', 'safety'],
    runs: [
      { configuration: 'candidate', eval_id: 'routing', score: 0.5, failure_mode: 'ok' },
      { configuration: 'baseline', eval_id: 'routing', score: 1, failure_mode: 'ok' },
      { configuration: 'candidate', eval_id: 'safety', score: 1, failure_mode: 'ok' },
      { configuration: 'baseline', eval_id: 'safety', score: 0.5, failure_mode: 'ok' },
    ],
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join('\n'), /routing regressed/);
});

it('formats one PR comment with gate results and artifact links', () => {
  const comment = formatComment(
    [
      {
        skill: 'video-gen',
        type: 'modified',
        gate: { passed: false, candidateScore: 0.75, baselineScore: 1, delta: -0.25, reasons: ['routing regressed'] },
      },
    ],
    { runUrl: 'https://github.example/actions/runs/42', artifactName: 'skill-eval-42' },
  );
  assert.match(comment, /❌ Skill Eval — failed/);
  assert.match(comment, /\| `video-gen` \| modified \| 0\.750 \| 1\.000 \| -0\.250 \| ❌ \|/);
  assert.match(comment, /routing regressed/);
  assert.match(comment, /skill-eval-42/);
  assert.match(comment, /actions\/runs\/42/);
});

// Exercises three CLI runs and their child processes; allow headroom during the full parallel suite.
it('runs changed skills through Pi and preserves completed results on a later failure', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-skill-eval-test-'));
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: root,
    env: gitEnv,
    ...options,
  });
  try {
    const skillDir = path.join(root, 'packages/pi-demo/skills/demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nbase\n');
    writeFileSync(
      path.join(skillDir, 'evals.json'),
      JSON.stringify({ skill_name: 'demo', evals: [evalCase('a'), evalCase('b'), evalCase('c')] }),
    );
    const referencesDir = path.join(skillDir, 'references');
    mkdirSync(referencesDir);
    writeFileSync(
      path.join(referencesDir, 'catalog.json'),
      JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    );
    const incompleteSkillDir = path.join(root, 'packages/pi-demo/skills/zzz-incomplete');
    mkdirSync(incompleteSkillDir, { recursive: true });
    writeFileSync(
      path.join(incompleteSkillDir, 'SKILL.md'),
      '---\nname: zzz-incomplete\ndescription: incomplete\n---\nbase\n',
    );
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nhead\n');
    git(['add', '.']);
    git(['commit', '-qm', 'head']);
    const head = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const fakePi = path.join(bin, 'pi');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
if (process.env.FAKE_PI_FAIL === '1') { console.error('sensitive-provider-body'); process.exit(2); }
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const mode = process.argv[process.argv.indexOf('--mode') + 1];
if (mode === 'text') {
  const data = JSON.parse(prompt);
  console.log(JSON.stringify({verdicts: data.requirements.map(() => ({passed: true, evidence: data.answer}))}));
} else {
  if (!process.argv.includes('--no-builtin-tools') || process.argv.includes('--no-tools')) process.exit(4);
  for (let i = 0; i < 180; i++) console.log(JSON.stringify({type:'message_update',padding:'x'.repeat(2000)}));
  const ids = ['a','b','c'].filter((id) => prompt.includes('prompt ' + id));
  console.log(JSON.stringify({type:'message_end', message:{role:'assistant',content:[{type:'text',text:ids.map((id) => 'needle-' + id).join(' ')}]}}));
}
`,
    );
    chmodSync(fakePi, 0o755);

    const outputDir = path.join(root, 'results');
    const script = fileURLToPath(new URL('./skill-eval.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        PATH: `${bin}:${gitEnv.PATH}`,
        SKILL_EVAL_BASE_SHA: base,
        SKILL_EVAL_HEAD_SHA: head,
        SKILL_EVAL_OUTPUT_DIR: outputDir,
        SKILL_EVAL_RUNS: '1',
        SKILL_EVAL_RUN_URL: 'https://github.example/actions/runs/42',
        SKILL_EVAL_ARTIFACT: 'skill-eval-42',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(path.join(outputDir, 'comment.md'), 'utf8'), /✅ Skill Eval — passed/);
    assert.equal(JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8')).skills[0].skill, 'demo');
    const metadata = JSON.parse(
      readFileSync(path.join(outputDir, 'demo/eval-a/new_skill/run-1/eval_metadata.json'), 'utf8'),
    );
    assert.equal(metadata.eval_id, 'a');
    assert.equal(metadata.expected_output, 'expected a');
    assert.equal(
      JSON.parse(
        readFileSync(path.join(outputDir, 'demo/eval-a/new_skill/run-1/grading.json'), 'utf8'),
      ).expected_output,
      'expected a',
    );

    const sanitizedOutputDir = path.join(root, 'sanitized-results');
    const failedPiRun = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        PATH: `${bin}:${gitEnv.PATH}`,
        FAKE_PI_FAIL: '1',
        SKILL_EVAL_BASE_SHA: base,
        SKILL_EVAL_HEAD_SHA: head,
        SKILL_EVAL_OUTPUT_DIR: sanitizedOutputDir,
        SKILL_EVAL_RUNS: '1',
      },
    });
    assert.equal(failedPiRun.status, 1);
    const failureArtifacts = [
      'demo/eval-a/new_skill/run-1/outputs/response.md',
      'demo/eval-a/new_skill/run-1/grading.json',
      'demo/benchmark.json',
    ].map((relative) => readFileSync(path.join(sanitizedOutputDir, relative), 'utf8')).join('\n');
    assert.doesNotMatch(failureArtifacts, /sensitive-provider-body/);

    writeFileSync(
      path.join(incompleteSkillDir, 'SKILL.md'),
      '---\nname: zzz-incomplete\ndescription: incomplete\n---\nhead\n',
    );
    writeFileSync(
      path.join(incompleteSkillDir, 'evals.json'),
      JSON.stringify({ skill_name: 'zzz-incomplete', evals: [evalCase('x'), evalCase('y'), evalCase('z')] }),
    );
    git(['add', '.']);
    git(['commit', '-qm', 'add incomplete eval set while changing skill']);
    const failingHead = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const partialOutputDir = path.join(root, 'partial-results');
    const failedRun = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        PATH: `${bin}:${gitEnv.PATH}`,
        SKILL_EVAL_BASE_SHA: base,
        SKILL_EVAL_HEAD_SHA: failingHead,
        SKILL_EVAL_OUTPUT_DIR: partialOutputDir,
        SKILL_EVAL_RUNS: '1',
      },
    });
    assert.equal(failedRun.status, 1);
    const partialSummary = JSON.parse(readFileSync(path.join(partialOutputDir, 'summary.json'), 'utf8'));
    assert.equal(partialSummary.skills.length, 1);
    assert.equal(partialSummary.skills[0].skill, 'demo');
    assert.equal(partialSummary.error, 'evaluation infrastructure failed');
    const partialComment = readFileSync(path.join(partialOutputDir, 'comment.md'), 'utf8');
    assert.match(partialComment, /Skill Eval — failed/);
    assert.match(partialComment, /`demo`/);
    assert.match(partialComment, /Infrastructure failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it('validates every bundled skill eval set', () => {
  for (const relative of [
    '../../packages/pi-image-gen/skills/image-gen/evals.json',
    '../../packages/pi-video-gen/skills/video-gen/evals.json',
  ]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    assert.doesNotThrow(() => validateEvalSet(JSON.parse(readFileSync(file, 'utf8'))), relative);
  }
});

it('keeps tool cases readable by the legacy base validator without weakening trace grading', () => {
  for (const name of ['image', 'video']) {
    const data = JSON.parse(readFileSync(new URL(`../../packages/pi-${name}-gen/skills/${name}-gen/evals.json`, import.meta.url), 'utf8'));
    for (const item of data.evals.filter((item) => item.mode === 'tools')) {
      for (const expected of item.expectations) {
        assert.ok(expected.includes?.length || expected.includes_any?.length || expected.excludes?.length);
        if (expected.tool) assert.equal(gradeTrace([], [expected]).score, 0);
      }
    }
  }
});

it('uses trusted base code, comments before enforcing, and never executes PR code', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../workflows/skill-eval.yml', import.meta.url)),
    'utf8',
  );
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /peter-evans\/create-or-update-comment@v5/);
  assert.match(workflow, /skill-eval\.mjs --detect/);
  assert.match(workflow, /timeout-minutes: 120/);
  assert.ok(workflow.indexOf('Post PR comment') < workflow.indexOf('Enforce gate outcome'));
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});
});
