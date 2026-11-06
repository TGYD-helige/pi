import assert from 'node:assert/strict';
import { it } from 'vitest';
import { traceIdForCodeword } from './telemetry-langfuse-verify.mjs';
import { runVerification, toObservations } from './telemetry-phoenix-verify.mjs';

const CODEWORD = 'ci-langfuse-probe-test';
const TRACE_ID = traceIdForCodeword(CODEWORD);

function span(id, kind, name, parentId = null, attributes = {}) {
  return {
    id,
    name,
    span_kind: kind,
    parent_id: parentId,
    context: { trace_id: TRACE_ID, span_id: id },
    start_time: '2026-05-02T00:00:00.000Z',
    end_time: '2026-05-02T00:00:01.000Z',
    status_code: 'OK',
    status_message: '',
    attributes: { 'session.id': 'session-1', ...attributes },
    events: [],
  };
}

function generation(id, name, parentId, includePayloads = true) {
  return span(id, 'LLM', name, parentId, {
    'llm.model_name': 'deepseek-v4-flash',
    'llm.provider': 'deepseek-integration',
    'llm.token_count.prompt': 10,
    'llm.token_count.completion': 2,
    'llm.token_count.total': 12,
    'llm.cost.total': 0.001,
    costSource: 'model-pricing',
    ...(includePayloads
      ? {
          'input.value': JSON.stringify([
            { role: 'system', content: 'actual system', tools: [{ name: 'bash' }] },
            { role: 'user', content: CODEWORD },
          ]),
          'output.value': JSON.stringify({ role: 'assistant', content: 'done' }),
        }
      : {}),
  });
}

function trace(scenario = 'basic') {
  if (scenario === 'redacted') {
    return [
      span('root', 'AGENT', 'chat-turn', null),
      span('tool', 'TOOL', 'bash', 'root'),
      generation('main', 'llm-generation [main] [request]', 'root', false),
      span('stream', 'CHAIN', 'llm-stream', 'main'),
    ];
  }
  if (scenario === 'hierarchy') {
    return [
      span('root', 'AGENT', 'chat-turn', null, { 'input.value': CODEWORD }),
      span('launch', 'TOOL', 'bash [bash .github/scripts/telemetry-subagent.sh hierarchy]', 'root'),
      generation('main', 'llm-generation [main] [request]', 'root'),
      span('main-stream', 'CHAIN', 'llm-stream', 'main'),
      span('outer', 'AGENT', 'subagent [ci-hierarchy]', 'root'),
      span('outer-launch', 'TOOL', 'bash [bash .github/scripts/telemetry-subagent.sh]', 'outer'),
      generation('outer-gen', 'llm-generation [subagent] [outer]', 'outer'),
      span('outer-stream', 'CHAIN', 'llm-stream', 'outer-gen'),
      span('inner', 'AGENT', 'subagent [ci-probe]', 'outer'),
      span('inner-tool', 'TOOL', `bash [echo ${CODEWORD} child]`, 'inner'),
      generation('inner-gen', 'llm-generation [subagent] [inner]', 'inner'),
      span('inner-stream', 'CHAIN', 'llm-stream', 'inner-gen'),
    ];
  }
  return [
    span('root', 'AGENT', 'chat-turn', null, { 'input.value': CODEWORD }),
    span('parent-tool', 'TOOL', `bash [echo ${CODEWORD} parent]`, 'root'),
    span('launch', 'TOOL', 'bash [bash .github/scripts/telemetry-subagent.sh]', 'root'),
    generation('main', 'llm-generation [main] [request]', 'root'),
    span('main-stream', 'CHAIN', 'llm-stream', 'main'),
    span('subagent', 'AGENT', 'subagent [ci-probe]', 'root'),
    span('child-tool', 'TOOL', `bash [echo ${CODEWORD} child]`, 'subagent'),
    generation('child-gen', 'llm-generation [subagent] [request]', 'subagent'),
    span('child-stream', 'CHAIN', 'llm-stream', 'child-gen'),
  ];
}

function args(scenario = 'basic') {
  return {
    endpoint: 'http://phoenix.test/v1/traces/',
    apiKey: 'phoenix-secret',
    codeword: CODEWORD,
    scenario,
    deadlineMs: 250,
    sleep: () => Promise.resolve(),
  };
}

it('maps Phoenix OpenInference spans and verifies the basic hierarchy with Bearer auth', async () => {
  const spans = trace();
  spans.find((span) => span.id === 'main').events = [
    { name: 'first_token', timestamp: '2026-05-02T00:00:00.300Z' },
  ];
  const observations = toObservations(spans, TRACE_ID);
  const generation = observations.find((observation) => observation.id === 'main');
  assert.equal(generation.type, 'GENERATION');
  assert.equal(generation.providedModelName, 'deepseek-v4-flash');
  assert.equal(generation.modelParameters.provider, 'deepseek-integration');
  assert.equal(generation.completionStartTime, '2026-05-02T00:00:00.300Z');
  assert.deepEqual(generation.usageDetails, { input: 10, output: 2, total: 12 });
  assert.equal(generation.input[0].role, 'system');
  assert.equal(observations.filter((observation) => observation.type === 'TOOL').length, 3);

  const calls = [];
  const result = await runVerification({
    ...args(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ data: trace(), next_cursor: null });
    },
  });
  assert.equal(result.ok, true, result.state);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/projects/github-pi/spans');
  assert.equal(url.searchParams.get('trace_id'), TRACE_ID);
  assert.equal(calls[0].init.headers.authorization, 'Bearer phoenix-secret');
});

it('verifies nested subagent hierarchy', async () => {
  const result = await runVerification({
    ...args('hierarchy'),
    fetchImpl: async () => Response.json({ data: trace('hierarchy'), next_cursor: null }),
  });
  assert.equal(result.ok, true, result.state);
});

it('verifies redacted traces without requiring Langfuse-specific metadata', async () => {
  const result = await runVerification({
    ...args('redacted'),
    fetchImpl: async () => Response.json({ data: trace('redacted'), next_cursor: null }),
  });
  assert.equal(result.ok, true, result.state);
});

it('polls until the trace is complete', async () => {
  let calls = 0;
  const result = await runVerification({
    ...args(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ data: calls === 1 ? [] : trace(), next_cursor: null });
    },
  });
  assert.equal(result.ok, true, result.state);
  assert.equal(calls, 2);
});

it('does not expose response bodies in polling errors', async () => {
  const result = await runVerification({
    ...args(),
    deadlineMs: 1,
    fetchImpl: async () => new Response('PHOENIX_INTERNAL_SECRET', { status: 500 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.state, /HTTP 500/);
  assert.doesNotMatch(result.state, /PHOENIX_INTERNAL_SECRET/);
});
