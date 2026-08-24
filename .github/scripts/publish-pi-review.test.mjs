import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  commentableLines,
  combinePiReviewTranscript,
  parseReviewOutput,
  preparePiReview,
  publishPiReview,
  reviewLocationIndex,
  summaryBody,
} from './publish-pi-review.mjs';

const finding = {
  severity: 'P1',
  axis: 'Standards',
  path: 'src/example.ts',
  line: 11,
  side: 'RIGHT',
  title: 'Unchecked failure path',
  body: 'The added call can throw before cleanup runs.',
  fix: 'Move cleanup into a finally block.',
};

test('combines schema-validated axis outputs from the Pi JSON transcript', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-transcript-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  const specFinding = { ...finding, severity: 'P2', axis: 'Spec', title: 'Documented fallback is missing' };
  const infos = [];
  const warnings = [];
  const core = { info: (m) => infos.push(m), warning: (m) => warnings.push(m) };
  try {
    await writeFile(transcriptPath, [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'subagent' }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'subagent',
        result: {
          details: {
            mode: 'parallel',
            results: [
              { exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } },
              { exitCode: 0, structuredOutput: { axis: 'Spec', findings: [specFinding] } },
            ],
          },
        },
      }),
    ].join('\n'));
    await combinePiReviewTranscript({ transcriptPath, reviewPath, core });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding, specFinding] });
    assert.deepEqual(infos, [
      'Pi review transcript: 1 completed reviewer subagent run(s)',
      'Pi review Standards reviewer: 1 finding(s)',
      'Pi review Spec reviewer: 1 finding(s)',
      'Pi review combined 2 total finding(s)',
    ]);
    assert.deepEqual(warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts a Standards-only run when the skill finds no specification', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-no-spec-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  const infos = [];
  const warnings = [];
  const core = { info: (m) => infos.push(m), warning: (m) => warnings.push(m) };
  try {
    await writeFile(transcriptPath, JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'subagent',
      result: {
        details: {
          mode: 'parallel',
          results: [{ exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } }],
        },
      },
    }));
    await combinePiReviewTranscript({ transcriptPath, reviewPath, core });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding] });
    // A missing axis is tolerated but must be visible, not silent.
    assert.deepEqual(infos, [
      'Pi review transcript: 1 completed reviewer subagent run(s)',
      'Pi review Standards reviewer: 1 finding(s)',
      'Pi review combined 1 total finding(s)',
    ]);
    assert.deepEqual(warnings, [
      'Pi review Spec reviewer produced no usable result; that axis contributes no findings',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('combines workflow-mode runs and ignores management calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-workflow-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  const infos = [];
  const warnings = [];
  const core = { info: (m) => infos.push(m), warning: (m) => warnings.push(m) };
  try {
    await writeFile(transcriptPath, [
      // A subagent action:"list" management call carries an empty results array.
      JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'subagent',
        result: { details: { mode: 'management', results: [] } },
      }),
      // pi-subagents 0.41+ lets the coordinator fan out via a workflow script.
      JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'subagent',
        result: {
          details: {
            mode: 'workflow',
            results: [
              { exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } },
              { exitCode: 0, structuredOutput: { axis: 'Spec', findings: [] } },
            ],
          },
        },
      }),
    ].join('\n'));
    await combinePiReviewTranscript({ transcriptPath, reviewPath, core });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding] });
    assert.deepEqual(infos, [
      'Pi review transcript: 1 completed reviewer subagent run(s)',
      'Pi review Standards reviewer: 1 finding(s)',
      'Pi review Spec reviewer: 0 finding(s)',
      'Pi review combined 1 total finding(s)',
    ]);
    assert.deepEqual(warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('combines successful structured outputs across coordinator recovery calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-recovery-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  const specFinding = { ...finding, severity: 'P2', axis: 'Spec', title: 'Documented fallback is missing' };
  const infos = [];
  const warnings = [];
  const core = { info: (m) => infos.push(m), warning: (m) => warnings.push(m) };
  const event = (results) => JSON.stringify({
    type: 'tool_execution_end',
    toolName: 'subagent',
    result: { details: { mode: 'parallel', results } },
  });
  try {
    await writeFile(transcriptPath, [
      event([{ exitCode: 1, error: 'first attempt failed' }]),
      event([{ exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } }]),
      event([{ exitCode: 0, structuredOutput: { axis: 'Spec', findings: [specFinding] } }]),
    ].join('\n'));
    await combinePiReviewTranscript({ transcriptPath, reviewPath, core });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding, specFinding] });
    // The failed first attempt is surfaced as a warning, not swallowed.
    assert.deepEqual(warnings, ['Pi review discarded reviewer output: first attempt failed']);
    assert.deepEqual(infos, [
      'Pi review transcript: 3 completed reviewer subagent run(s)',
      'Pi review Standards reviewer: 1 finding(s)',
      'Pi review Spec reviewer: 1 finding(s)',
      'Pi review combined 2 total finding(s)',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parses findings JSON wrapped in model prose', () => {
  assert.deepEqual(parseReviewOutput(`\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``), [finding]);
  assert.deepEqual(parseReviewOutput(`Both reviews completed.\n${JSON.stringify({ findings: [] })}\nReview complete.`), []);
  assert.throws(() => parseReviewOutput('Both reviews completed without structured output.'), /valid JSON object/);
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ findings: [finding, { ...finding, title: 'Another defect' }] })),
    /multiple findings for the same axis and changed line/,
  );
});

test('collects only added and removed diff lines', () => {
  const locations = commentableLines([{ filename: 'src/example.ts', patch: '@@ -10,2 +10,3 @@\n same\n-old\n+new\n+more' }]);
  assert.deepEqual([...locations], [
    'src/example.ts\u0000LEFT\u000011',
    'src/example.ts\u0000RIGHT\u000011',
    'src/example.ts\u0000RIGHT\u000012',
  ]);
});

test('gives the reviewer exact changed-line coordinates', () => {
  const patch = [
    '@@ -36,6 +36,8 @@',
    ' ',
    ' Traces are scoped to user input boundaries.',
    ' ',
    '+Langfuse traces include correlation metadata.',
    '+',
    ' ## Configuration',
  ].join('\n');
  assert.equal(
    reviewLocationIndex([{ filename: 'packages/pi-telemetry/README.md', patch }]),
    'packages/pi-telemetry/README.md\tRIGHT\t39\npackages/pi-telemetry/README.md\tRIGHT\t40',
  );
});

test('prepares the review prompt outside the workflow', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-context-'));
  const contextPath = path.join(directory, 'context.md');
  await writeFile(path.join(directory, 'AGENTS.md'), '# Review rules');
  const listFiles = () => {};
  const listCommits = () => {};
  const github = {
    request: async () => ({ data: 'diff --git a/src/example.ts b/src/example.ts' }),
    paginate: async (method) => {
      if (method === listFiles) {
        return [{ filename: 'src/example.ts', patch: '@@ -10 +10,2 @@\n old\n+new' }];
      }
      if (method === listCommits) return [];
      throw new Error('Unexpected pagination method');
    },
    rest: {
      pulls: { listFiles, listCommits },
      issues: { get: async () => { throw new Error('Unexpected issue lookup'); } },
    },
  };
  try {
    await preparePiReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: {
          pull_request: {
            number: 123,
            title: 'Test review preparation',
            body: '',
            base: { sha: 'base123' },
            head: { sha: 'head123' },
          },
        },
      },
      core: { warning: () => {} },
      contextPath,
      workspace: directory,
    });
    const prompt = await readFile(contextPath, 'utf8');
    assert.match(prompt, /# Allowed changed-line locations/);
    assert.match(prompt, /src\/example\.ts\tRIGHT\t11/);
    assert.match(prompt, /Copy path, side, and line exactly from this list/);
    assert.match(prompt, /outputSchema/);
    assert.match(prompt, /structured_output/);
    assert.match(prompt, /"const":"Standards"/);
    assert.match(prompt, /"const":"Spec"/);
    assert.match(prompt, /Reviewer children have no tools and inherit no context/);
    assert.match(prompt, /Copy the supplied review data directly into each child task/);
    assert.match(prompt, /Never tell a child to run git, execute the diff command, read files, or fetch context/);
    assert.match(prompt, /Make exactly one synchronous subagent workflow call/);
    assert.match(prompt, /Do not call emit, subagent_wait, status, or list, and do not retry/);
    assert.doesNotMatch(prompt, /file-only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const workflow = await readFile(new URL('../workflows/pi-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /preparePiReview\(\{ github, context, core/);
  assert.match(workflow, /PI_REVIEW_TRANSCRIPT/);
  assert.match(workflow, /combinePiReviewTranscript\(\{[^}]*\bcore\b/);
  assert.match(workflow, /--mode json/);
  assert.match(workflow, /> "\$PI_REVIEW_TRANSCRIPT"/);
  assert.match(workflow, /acceptanceRole: read-only/);
  assert.match(workflow, /completionGuard: false/);
  assert.doesNotMatch(workflow, /const diffResponse =/);
});

test('posts one new review per run with the full summary and current findings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-'));
  const reviewPath = path.join(directory, 'review.json');
  await writeFile(reviewPath, JSON.stringify({ findings: [finding] }));
  const calls = [];
  const listFiles = () => {};
  const github = {
    paginate: async (method) => {
      if (method === listFiles) return [{ filename: 'src/example.ts', patch: '@@ -10 +10,2 @@\n old\n+new' }];
      throw new Error('Unexpected pagination method');
    },
    rest: {
      pulls: {
        listFiles,
        createReview: async (args) => {
          calls.push(['createReview', args]);
        },
      },
    },
  };
  const failures = [];
  const warnings = [];
  const infos = [];
  const core = {
    setFailed: (message) => failures.push(message),
    warning: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  };
  const publish = (sha) => publishPiReview({
    github,
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { pull_request: { number: 123, head: { sha } } },
    },
    core,
    reviewPath,
  });
  try {
    await publish('abc123');
    await writeFile(reviewPath, JSON.stringify({
      findings: [
        { ...finding, severity: 'P2', title: 'Cleanup can be skipped' },
        { ...finding, severity: 'P0', line: 12, title: 'Invalid model location' },
      ],
    }));
    await publish('def456');
    await writeFile(reviewPath, JSON.stringify({ findings: [] }));
    await publish('def456');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // Every run creates exactly one brand-new review. History is never touched:
  // the mock has no review-comment list/update/delete or issue-comment APIs,
  // so any such call would throw.
  const reviews = calls.filter(([name]) => name === 'createReview');
  assert.equal(reviews.length, 3);
  const [first, second, third] = reviews.map(([, args]) => args);

  assert.equal(first.commit_id, 'abc123');
  assert.equal(first.event, 'COMMENT');
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].path, 'src/example.ts');
  assert.equal(first.comments[0].line, 11);
  assert.equal(first.comments[0].side, 'RIGHT');
  assert.match(first.comments[0].body, /\*\*\[P1\] Unchecked failure path\*\* · Standards/);
  assert.match(first.body, /^<!-- pi-code-review -->\n## Standards/);
  assert.match(first.body, /Unchecked failure path/);
  assert.match(first.body, /\*\*Summary:\*\* Standards: 1 finding, highest P1; Spec: no findings\./);

  assert.equal(second.commit_id, 'def456');
  assert.equal(second.comments.length, 1);
  assert.match(second.comments[0].body, /\*\*\[P2\] Cleanup can be skipped\*\*/);
  // Findings outside changed lines stay summary-only: no inline comment, but
  // still present in the review body.
  assert.match(second.body, /Invalid model location/);
  assert.match(second.body, /\*\*Summary:\*\* Standards: 2 findings, highest P0; Spec: no findings\./);

  // A findings-free run still posts its review, with no inline comments.
  assert.equal(third.comments.length, 0);
  assert.equal(
    third.body,
    '<!-- pi-code-review -->\n## Standards\n\nNo actionable findings.\n\n## Spec\n\nNo actionable findings.\n\n**Summary:** Standards: no findings; Spec: no findings.',
  );

  assert.deepEqual(failures, [
    'Pi review found 1 blocking P0/P1 finding(s)',
    'Pi review found 1 blocking P0/P1 finding(s)',
  ]);
  assert.deepEqual(warnings, ['Summary-only Pi review finding outside changed lines: src/example.ts:12 (RIGHT)']);
  assert.deepEqual(infos, [
    'Pi review published 1 finding(s): 1 inline, 0 summary-only; blocking P0/P1: 1',
    'Pi review published 2 finding(s): 1 inline, 1 summary-only; blocking P0/P1: 1',
    'Pi review published 0 finding(s): 0 inline, 0 summary-only; blocking P0/P1: 0',
  ]);
  const summary = summaryBody(
    [
      finding,
      {
        ...finding,
        severity: 'P2',
        axis: 'Spec',
        path: 'src/other.ts',
        line: 20,
        title: 'Documented fallback is missing',
        body: 'The PR promises a fallback, but this branch still throws.',
        fix: 'Return the documented fallback value.',
      },
    ],
    {
      owner: 'owner',
      repo: 'repo',
      headSha: 'abc123',
      baseSha: 'base123',
      serverUrl: 'https://github.example',
    },
  );
  assert.match(summary, /^<!-- pi-code-review -->\n## Standards/m);
  assert.match(summary, /\*\*P1 — \[src\/example\.ts \(line 11\)\]\(https:\/\/github\.example\/owner\/repo\/blob\/abc123\/src\/example\.ts#L11\): Unchecked failure path\.\*\*/);
  assert.match(summary, /The added call can throw before cleanup runs\. \*\*Suggested fix:\*\* Move cleanup into a finally block\./);
  assert.match(summary, /## Spec/);
  assert.match(summary, /\*\*P2 — \[src\/other\.ts \(line 20\)\]/);
  assert.match(summary, /\*\*Summary:\*\* Standards: 1 finding, highest P1; Spec: 1 finding, highest P2\./);
  assert.doesNotMatch(summary, /\| Priority \|/);
  assert.doesNotMatch(summary, /Model:/);

  const emptySummary = summaryBody([]);
  assert.equal(
    emptySummary,
    '<!-- pi-code-review -->\n## Standards\n\nNo actionable findings.\n\n## Spec\n\nNo actionable findings.\n\n**Summary:** Standards: no findings; Spec: no findings.',
  );
});
