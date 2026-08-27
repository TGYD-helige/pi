import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  envOr,
  evaluateTrace,
  runVerification,
  traceIdForCodeword,
} from './telemetry-langfuse-verify.mjs';

const CODEWORD = 'ci-langfuse-probe-test';
const SERVICE_NAME = 'pi-telemetry-ci';

function fullTrace() {
  return withSemantics([
    { id: 'root', traceId: 't1', type: 'SPAN', name: 'chat-turn', parentObservationId: null, startTime: 'a', endTime: 'b', input: `echo ${CODEWORD} parent` },
    { id: 'b1', traceId: 't1', type: 'SPAN', name: `bash [echo ${CODEWORD} parent]`, parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 'b2', traceId: 't1', type: 'SPAN', name: 'bash [bash .github/scripts/telemetry-subagent.sh]', parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 'g1', traceId: 't1', type: 'GENERATION', name: 'llm-generation [main] [request]', parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 's1', traceId: 't1', type: 'SPAN', name: 'llm-stream', parentObservationId: 'g1', startTime: 'a', endTime: 'b' },
    { id: 'sub', traceId: 't1', type: 'SPAN', name: 'subagent [ci-probe]', parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 'b3', traceId: 't1', type: 'SPAN', name: `bash [echo ${CODEWORD} child]`, parentObservationId: 'sub', startTime: 'a', endTime: 'b' },
    { id: 'g2', traceId: 't1', type: 'GENERATION', name: 'llm-generation [subagent] [request]', parentObservationId: 'sub', startTime: 'a', endTime: 'b' },
    { id: 's2', traceId: 't1', type: 'SPAN', name: 'llm-stream', parentObservationId: 'g2', startTime: 'a', endTime: 'b' },
  ]);
}

function hierarchyTrace() {
  return withSemantics([
    { id: 'root', traceId: 't2', type: 'SPAN', name: 'chat-turn', parentObservationId: null, startTime: 'a', endTime: 'b', input: `hierarchy probe ${CODEWORD}` },
    { id: 'launch', traceId: 't2', type: 'SPAN', name: 'bash [bash .github/scripts/telemetry-subagent.sh hierarchy]', parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 'main-gen', traceId: 't2', type: 'GENERATION', name: 'llm-generation [main] [request]', parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 'main-stream', traceId: 't2', type: 'SPAN', name: 'llm-stream', parentObservationId: 'main-gen', startTime: 'a', endTime: 'b' },
    { id: 'outer', traceId: 't2', type: 'SPAN', name: 'subagent [ci-hierarchy]', parentObservationId: 'root', startTime: 'a', endTime: 'b' },
    { id: 'nested-launch', traceId: 't2', type: 'SPAN', name: 'bash [bash .github/scripts/telemetry-subagent.sh]', parentObservationId: 'outer', startTime: 'a', endTime: 'b' },
    { id: 'outer-gen', traceId: 't2', type: 'GENERATION', name: 'llm-generation [subagent] [request]', parentObservationId: 'outer', startTime: 'a', endTime: 'b' },
    { id: 'outer-stream', traceId: 't2', type: 'SPAN', name: 'llm-stream', parentObservationId: 'outer-gen', startTime: 'a', endTime: 'b' },
    { id: 'inner', traceId: 't2', type: 'SPAN', name: 'subagent [ci-probe]', parentObservationId: 'outer', startTime: 'a', endTime: 'b' },
    { id: 'inner-bash', traceId: 't2', type: 'SPAN', name: `bash [echo ${CODEWORD} child]`, parentObservationId: 'inner', startTime: 'a', endTime: 'b' },
    { id: 'inner-gen', traceId: 't2', type: 'GENERATION', name: 'llm-generation [subagent] [request]', parentObservationId: 'inner', startTime: 'a', endTime: 'b' },
    { id: 'inner-stream', traceId: 't2', type: 'SPAN', name: 'llm-stream', parentObservationId: 'inner-gen', startTime: 'a', endTime: 'b' },
  ]);
}

function withSemantics(observations) {
  return observations.map((observation) => ({
    ...observation,
    sessionId: 'session-1',
    tags: [SERVICE_NAME],
    metadata: { serviceName: SERVICE_NAME },
    ...(observation.type === 'GENERATION'
      ? {
          providedModelName: 'deepseek-v4-flash',
          modelParameters: { provider: 'deepseek-integration' },
          usageDetails: { input: 10, output: 2, total: 12 },
          costDetails: { total: 0.001 },
        }
      : {}),
  }));
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const result = handler(new URL(url), calls.length);
    if (result.ok === false) return result;
    return Response.json(result);
  };
  fn.calls = calls;
  return fn;
}

const baseArgs = {
  baseUrl: '',
  publicKey: 'pk',
  secretKey: 'sk',
  fromStartTime: '2026-01-01T00:00:00Z',
  codeword: CODEWORD,
  traceId: 't1',
  sleep: () => Promise.resolve(),
};

it('empty LANGFUSE_BASE_URL falls back to the cloud default', async () => {
  const fetchImpl = fakeFetch(() => ({ data: fullTrace(), meta: {} }));
  const result = await runVerification({ ...baseArgs, fetchImpl });
  assert.equal(result.ok, true);
  assert.ok(fetchImpl.calls[0].url.startsWith('https://cloud.langfuse.com/api/public/v2/observations'));
  assert.equal(
    new URL(fetchImpl.calls[0].url).searchParams.get('fields'),
    'core,basic,time,io,metadata,model,usage,trace_context',
  );
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('traceId'), 't1');
});

it('retries while the trace is incomplete, then passes', async () => {
  let traceFetches = 0;
  const fetchImpl = fakeFetch(() => {
    traceFetches += 1;
    // First look: subagent side has not landed yet; second look: complete.
    const rows = traceFetches === 1 ? fullTrace().filter((o) => !['sub', 'b3', 'g2'].includes(o.id)) : fullTrace();
    return { data: rows, meta: {} };
  });
  const result = await runVerification({ ...baseArgs, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(traceFetches >= 2, true);
});

it('runVerification selects the hierarchy contract', async () => {
  const fetchImpl = fakeFetch(() => ({ data: hierarchyTrace(), meta: {} }));
  const result = await runVerification({
    ...baseArgs,
    scenario: 'hierarchy',
    traceId: 't2',
    deadlineMs: 1,
    fetchImpl,
  });
  assert.equal(result.ok, true);
});

it('follows meta.cursor across pages', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (!url.searchParams.get('cursor')) return { data: [], meta: { cursor: 'page-2' } };
    return { data: fullTrace(), meta: {} };
  });
  const result = await runVerification({ ...baseArgs, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.some((c) => c.url.includes('cursor=page-2')), true);
});

it('reports failure after the deadline when the trace never completes', async () => {
  const fetchImpl = fakeFetch(() => ({ data: [], meta: {} }));
  const result = await runVerification({ ...baseArgs, fetchImpl, deadlineMs: 1 });
  assert.equal(result.ok, false);
  assert.match(result.state, /not visible/);
});

it('sanitizes HTTP errors to the status code', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const result = await runVerification({ ...baseArgs, fetchImpl, deadlineMs: 1 });
  assert.equal(result.ok, false);
  assert.match(result.state, /HTTP 401/);
  assert.doesNotMatch(result.state, /secret|body/i);
});

it('honors the full Retry-After on 429 instead of failing', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, headers: new Map([['retry-after', '180']]) };
    }
    return Response.json({ data: fullTrace(), meta: {} });
  };
  const result = await runVerification({
    ...baseArgs,
    fetchImpl,
    deadlineMs: 200_000,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [180000]);
});

it('sanitizes malformed JSON bodies without leaking content', async () => {
  const fetchImpl = async () => new Response('LANGFUSE_INTERNAL_SECRET_PAYLOAD');
  const result = await runVerification({ ...baseArgs, fetchImpl, deadlineMs: 1 });
  assert.equal(result.ok, false);
  assert.match(result.state, /invalid JSON/);
  assert.doesNotMatch(result.state, /SECRET_PAYLOAD/);
});

it('falls back to the v1 observations API when v2 is gated off', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/v2/observations')) {
      return new Response('not found', { status: 404 });
    }
    if (String(url).includes('/api/public/traces/t1')) {
      return Response.json({ id: 't1', sessionId: 'session-1', tags: [SERVICE_NAME] });
    }
    // v1: page-based pagination, full rows, meta.totalPages.
    return Response.json({
      data: fullTrace().map(({ sessionId: _sessionId, tags: _tags, providedModelName, ...row }) => ({
        ...row,
        ...(providedModelName ? { model: providedModelName } : {}),
      })),
      meta: { totalPages: 1 },
    });
  };
  const result = await runVerification({ ...baseArgs, fetchImpl });
  assert.equal(result.ok, true);
  assert.ok(urls.some((u) => u.includes('/v2/observations')));
  assert.ok(urls.some((u) => u.includes('/api/public/observations')));
  assert.ok(urls.some((u) => u.includes('/api/public/traces/t1')));
  const v1Url = new URL(urls.find((u) => u.includes('/api/public/observations')));
  assert.equal(v1Url.searchParams.get('limit'), '100');
});

it('evaluateTrace rejects wrong parentage', () => {
  const flat = fullTrace().map((o) => (o.id === 'root' ? o : { ...o, parentObservationId: 'root' }));
  const problems = evaluateTrace(flat, CODEWORD);
  assert.ok(problems.some((p) => p.includes('bash [echo') && p.includes('expected sub')));
});

it('evaluateTrace validates the nested subagent hierarchy scenario', () => {
  assert.deepEqual(evaluateTrace(hierarchyTrace(), CODEWORD, 'hierarchy'), []);

  const broken = hierarchyTrace().map((observation) =>
    observation.id === 'inner' ? { ...observation, parentObservationId: 'root' } : observation,
  );
  const problems = evaluateTrace(broken, CODEWORD, 'hierarchy');
  assert.ok(problems.some((problem) => problem.includes('subagent [ci-probe]') && problem.includes('expected outer')));
});

it('evaluateTrace validates EVERY matching generation, not just the first', () => {
  const correct = fullTrace().find((o) => o.id === 'g1');
  const wrong = {
    ...correct,
    id: 'g1-dup',
    parentObservationId: 'sub', // wrong: main generations belong to the root
    endTime: null,
  };
  const problems = evaluateTrace([...fullTrace(), wrong], CODEWORD);
  assert.ok(problems.some((p) => p.includes('llm-generation [main]') && p.includes('expected root')));
  assert.ok(problems.some((p) => p.includes('llm-generation [main]') && p.includes('no endTime')));
});

it('honors a tiny deadline even when the fetch hangs', async () => {
  const started = Date.now();
  const result = await runVerification({
    ...baseArgs,
    deadlineMs: 10,
    // Mirrors real fetch: rejects when the request signal aborts.
    fetchImpl: (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
    sleep: () => Promise.resolve(),
  });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

it('evaluateTrace rejects unfinished generations and spans', () => {
  const open = fullTrace().map((o) => (['g1', 'g2', 'sub'].includes(o.id) ? { ...o, endTime: null } : o));
  const problems = evaluateTrace(open, CODEWORD);
  assert.ok(problems.some((p) => p.includes('llm-generation [main]') && p.includes('no endTime')));
  assert.ok(problems.some((p) => p.includes('llm-generation [subagent]') && p.includes('no endTime')));
  assert.ok(problems.some((p) => p.includes('never completed')));
});

it('evaluateTrace requires one completed stream child per generation', () => {
  const withoutStream = fullTrace().filter((observation) => observation.id !== 's2');
  const problems = evaluateTrace(withoutStream, CODEWORD);
  assert.ok(
    problems.some(
      (problem) => problem.includes('llm-generation [subagent]') && problem.includes('llm-stream'),
    ),
  );

  const unfinished = fullTrace().map((observation) =>
    observation.id === 's1' ? { ...observation, endTime: null } : observation,
  );
  assert.ok(
    evaluateTrace(unfinished, CODEWORD).some(
      (problem) => problem.includes('llm-stream') && problem.includes('no endTime'),
    ),
  );
});

it('evaluateTrace rejects duplicate deterministic spans', () => {
  const trace = fullTrace();
  const parentBash = trace.find((observation) => observation.id === 'b1');
  const subagent = trace.find((observation) => observation.id === 'sub');
  const problems = evaluateTrace(
    [
      ...trace,
      { ...parentBash, id: 'duplicate-parent-bash' },
      { ...subagent, id: 'duplicate-subagent' },
    ],
    CODEWORD,
  );
  assert.ok(problems.some((problem) => problem.includes('exactly 1') && problem.includes('parent')));
  assert.ok(problems.some((problem) => problem.includes('exactly 1') && problem.includes('subagent')));
});

it('evaluateTrace rejects missing trace and generation semantics', () => {
  const incomplete = fullTrace().map((observation) => ({
    ...observation,
    sessionId: '',
    tags: [],
    metadata: {},
    ...(observation.type === 'GENERATION'
      ? {
          providedModelName: '',
          modelParameters: {},
          usageDetails: {},
          costDetails: {},
        }
      : {}),
  }));
  const problems = evaluateTrace(incomplete, CODEWORD);
  assert.ok(problems.some((problem) => problem.includes('sessionId')));
  assert.ok(problems.some((problem) => problem.includes('service tag')));
  assert.ok(problems.some((problem) => problem.includes('serviceName metadata')));
  assert.ok(problems.some((problem) => problem.includes('model')));
  assert.ok(problems.some((problem) => problem.includes('usage')));
  assert.ok(problems.some((problem) => problem.includes('cost')));
});

it('evaluateTrace accepts the full trace', () => {
  assert.deepEqual(evaluateTrace(fullTrace(), CODEWORD), []);
});

it('envOr treats empty and blank values as unset', () => {
  assert.equal(envOr('', 'fallback'), 'fallback');
  assert.equal(envOr('   ', 'fallback'), 'fallback');
  assert.equal(envOr(undefined, 'fallback'), 'fallback');
  assert.equal(envOr('https://lf.example.com', 'fallback'), 'https://lf.example.com');
});

it('derives the Langfuse trace id used by the exporter', () => {
  assert.equal(traceIdForCodeword(CODEWORD), '9236fa9c83f70d08ef21168da1a4b3ef');
});
