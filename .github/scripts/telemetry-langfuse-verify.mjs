#!/usr/bin/env node

// Verifies the pi-telemetry Stage C run landed in Langfuse as one trace with
// the expected shape. The matrix prompt made the model run two bash calls,
// the second of which spawned a nested pi subagent
// (.github/scripts/telemetry-subagent.sh). The trace must contain these
// observations, with parentage and completion checked — not just names:
//
//   span       chat-turn  (root: parentObservationId == null, endTime set)
//   ├─ span       bash [echo <codeword> parent]                    (endTime set)
//   ├─ span       bash [bash .github/scripts/telemetry-…]          (endTime set)
//   ├─ generation llm-generation [main] …                          (endTime set)
//   │  └─ span       llm-stream                                 (endTime set)
//   └─ span       subagent [ci-probe]                              (endTime set)
//      ├─ span       bash [echo <codeword> child]                  (endTime set)
//      └─ generation llm-generation [subagent] …                   (endTime set)
//         └─ span       llm-stream                                  (endTime set)
//
// The hierarchy scenario adds a second nested pi and verifies:
// chat-turn → subagent [ci-hierarchy] → subagent [ci-probe] → child work.
//
// Reads via the Observations API v2 (the v1 reads are deprecated on Cloud).
// Self-hosted v3 gates v2 behind LANGFUSE_ENABLE_EVENTS_TABLE_V2_APIS
// (default off), so a 404 on v2 falls back to the v1 observations endpoint for
// the rest of the run. Trace-level input/output no longer exists in v2, so
// the codeword is matched on the root observation's input instead.
//
// Polling realities:
// - pi-telemetry writes via OTLP with the x-langfuse-ingestion-version: 4
//   header, so data is real-time on the v2 read APIs. The exporter and verifier
//   share a deterministic trace ID, avoiding an expensive project-wide scan.
// - Ingestion still lands piecemeal, so incomplete traces are retried every 5s.
//   A 429 is answered with Retry-After instead of a hard failure.
//
// Required env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY.
// Optional env: LANGFUSE_BASE_URL (default https://cloud.langfuse.com),
//               TELEMETRY_TRACE_FROM (ISO lower bound; default: 1h ago),
//               TELEMETRY_CODEWORD (default ci-langfuse-probe),
//               TELEMETRY_SCENARIO (basic or hierarchy; default basic).

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';
const DEFAULT_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const SERVICE_NAME = 'pi-telemetry-ci';
const MODEL_NAME = 'deepseek-v4-flash';
const MODEL_PROVIDER = 'deepseek-integration';

// Non-empty trimmed value or fallback — `''` is falsy, so `||` suffices.
export function envOr(value, fallback) {
  return value?.trim() || fallback;
}

export function traceIdForCodeword(codeword) {
  return createHash('sha256').update(`trace:${codeword}`).digest('hex').slice(0, 32);
}

// io-carrying pages can hold large model inputs/outputs; cap what we buffer.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

async function readBodyCapped(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error('response body too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

// Returns a list of problems; empty list means the trace fully matches.
export function evaluateTrace(observations, codeword, scenario = 'basic') {
  const spans = observations.filter((o) => o.type === 'SPAN');
  const generations = observations.filter((o) => o.type === 'GENERATION');
  const problems = [];
  const need = (condition, message) => {
    if (!condition) problems.push(message);
  };
  const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

  const sessionIds = new Set(observations.map((observation) => observation.sessionId).filter(Boolean));
  need(
    sessionIds.size === 1 && observations.every((observation) => observation.sessionId),
    'observations do not share one non-empty sessionId',
  );
  // langfuse.trace.tags is trace-level: we set it on every span, but whether
  // the v2 API projects it onto every observation row is a live-API behavior.
  // Require at least one observation to carry it (proves the tag landed)
  // instead of every row (depends on projection semantics).
  need(
    observations.some(
      (observation) => Array.isArray(observation.tags) && observation.tags.includes(SERVICE_NAME),
    ),
    `no observation carries the "${SERVICE_NAME}" service tag`,
  );
  need(
    observations.every(
      (observation) => observation.metadata?.serviceName === SERVICE_NAME,
    ),
    `observations are missing serviceName metadata "${SERVICE_NAME}"`,
  );
  for (const generation of generations) {
    const label = `generation "${generation.name ?? generation.id}"`;
    const modelParameters = generation.modelParameters ?? {};
    const usageDetails = generation.usageDetails ?? {};
    const costDetails = generation.costDetails ?? {};
    need(generation.providedModelName === MODEL_NAME, `${label} has the wrong model`);
    need(modelParameters.provider === MODEL_PROVIDER, `${label} has the wrong model provider`);
    need(
      isCount(usageDetails.input) && isCount(usageDetails.output) && isCount(usageDetails.total),
      `${label} is missing input/output/total usage`,
    );
    need(isCount(costDetails.total), `${label} is missing total cost`);

    const streams = spans.filter(
      (observation) =>
        observation.name === 'llm-stream' && observation.parentObservationId === generation.id,
    );
    need(streams.length === 1, `${label} expected exactly 1 child "llm-stream", found ${streams.length}`);
    for (const stream of streams) {
      need(stream.endTime != null, `${label} child "llm-stream" has no endTime`);
    }
  }

  const roots = spans.filter((o) => o.name === 'chat-turn' && o.parentObservationId == null);
  need(roots.length === 1, `expected exactly 1 root "chat-turn" span, found ${roots.length}`);
  const root = roots[0];
  if (!root) return problems;
  need(root.endTime != null, 'root "chat-turn" span has no endTime');
  // JSON.stringify like discovery does — a structured input would otherwise
  // stringify to '[object Object]' and spuriously fail the whole poll.
  need(
    JSON.stringify(root.input ?? '').includes(codeword),
    'root span input is missing the codeword',
  );

  const validateChildren = (checks) => {
    for (const { label, matches, parent, exact } of checks) {
      if (exact) {
        need(matches.length === 1, `expected exactly 1 ${label}, found ${matches.length}`);
      } else {
        need(matches.length > 0, `missing ${label}`);
      }
      for (const [index, found] of matches.entries()) {
        if (parent) {
          need(
            found.parentObservationId === parent.id,
            `${label} #${index} is parented to ${found.parentObservationId ?? 'null'}, expected ${parent.id}`,
          );
        }
        need(found.endTime != null, `${label} #${index} has no endTime`);
      }
    }
  };

  if (scenario === 'hierarchy') {
    const outerMatches = spans.filter((o) => o.name === 'subagent [ci-hierarchy]');
    need(outerMatches.length === 1, `expected exactly 1 span "subagent [ci-hierarchy]", found ${outerMatches.length}`);
    const outer = outerMatches[0];
    if (outer) {
      need(outer.parentObservationId === root.id, '"subagent [ci-hierarchy]" is not parented to the root span');
      need(outer.endTime != null, '"subagent [ci-hierarchy]" has no endTime');
    }

    const innerMatches = spans.filter((o) => o.name === 'subagent [ci-probe]');
    need(innerMatches.length === 1, `expected exactly 1 span "subagent [ci-probe]", found ${innerMatches.length}`);
    const inner = innerMatches[0];
    if (inner && outer) {
      need(inner.parentObservationId === outer.id, `"subagent [ci-probe]" is parented to ${inner.parentObservationId ?? 'null'}, expected ${outer.id}`);
      need(inner.endTime != null, '"subagent [ci-probe]" has no endTime');
    }

    validateChildren([
      {
        label: 'span "bash [... telemetry-subagent.sh hierarchy]"',
        matches: spans.filter((o) => o.name?.startsWith('bash [') && o.name.includes('telemetry-subagent.sh') && o.name.includes('hierarchy')),
        parent: root,
        exact: true,
      },
      {
        label: 'generation "llm-generation [main]"',
        matches: generations.filter((o) => o.name?.startsWith('llm-generation [main]')),
        parent: root,
      },
      {
        label: 'span "bash [... telemetry-subagent.sh]"',
        matches: spans.filter((o) => o.name?.startsWith('bash [') && o.name.includes('telemetry-subagent.sh') && !o.name.includes('hierarchy')),
        parent: outer,
        exact: true,
      },
      {
        label: 'generation under "subagent [ci-hierarchy]"',
        matches: generations.filter((o) => o.parentObservationId === outer?.id),
        parent: outer,
      },
      {
        label: `span "bash [echo ${codeword} child]"`,
        matches: spans.filter((o) => o.name?.startsWith('bash [') && o.name.includes(codeword) && o.name.includes('child')),
        parent: inner,
        exact: true,
      },
      {
        label: 'generation under "subagent [ci-probe]"',
        matches: generations.filter((o) => o.parentObservationId === inner?.id),
        parent: inner,
      },
    ]);
    return problems;
  }

  const subagents = spans.filter((o) => o.name === 'subagent [ci-probe]');
  need(
    subagents.length === 1,
    `expected exactly 1 span "subagent [ci-probe]", found ${subagents.length}`,
  );
  const subagent = subagents[0];
  if (subagent) {
    need(
      subagent.parentObservationId === root.id,
      '"subagent [ci-probe]" is not parented to the root span',
    );
    need(subagent.endTime != null, '"subagent [ci-probe]" has no endTime (never completed)');
  }

  const checks = [
    {
      label: `span "bash [echo ${codeword} parent]"`,
      // The model may quote the string or wrap the command — match on the
      // codeword and "parent" appearing in a bash span, not an exact prefix.
      matches: spans.filter(
        (o) => o.name?.startsWith('bash [') && o.name.includes(codeword) && o.name.includes('parent'),
      ),
      parent: root,
      exact: true,
    },
    {
      label: `span "bash [... telemetry-subagent.sh]"`,
      matches: spans.filter(
        (o) => o.name?.startsWith('bash [') && o.name.includes('telemetry-subagent.sh'),
      ),
      parent: root,
      exact: true,
    },
    {
      label: 'generation "llm-generation [main]"',
      matches: generations.filter((o) => o.name?.startsWith('llm-generation [main]')),
      parent: root,
    },
    {
      label: `span "bash [echo ${codeword} child]"`,
      matches: spans.filter(
        (o) => o.name?.startsWith('bash [') && o.name.includes(codeword) && o.name.includes('child'),
      ),
      parent: subagent,
      exact: true,
    },
    {
      label: 'generation "llm-generation [subagent]"',
      matches: generations.filter((o) => o.name?.startsWith('llm-generation [subagent]')),
      parent: subagent,
    },
  ];
  // Validate EVERY match: one well-formed generation must not whitewash a
  // second one with a wrong parent or a missing endTime.
  validateChildren(checks);
  return problems;
}

// Polls the Observations API v2 until the codeworded trace matches the
// expected shape or the deadline passes. Returns { ok, state } — the caller
// owns logging and process exit so tests can drive this with a fake fetch.
export async function runVerification({
  baseUrl,
  publicKey,
  secretKey,
  fromStartTime,
  traceId,
  codeword,
  scenario = 'basic',
  deadlineMs = DEFAULT_DEADLINE_MS,
  fetchImpl = fetch,
  sleep = delay,
  log = () => {},
}) {
  const origin = envOr(baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, '');
  const targetTraceId = envOr(traceId, traceIdForCodeword(codeword));
  const deadline = Date.now() + deadlineMs;
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;

  // Self-hosted v3 gates /api/public/v2/* behind LANGFUSE_ENABLE_EVENTS_TABLE_V2_APIS
  // (default off) — a 404 there means "use the legacy v1 observations API".
  let apiVersion = 'v2';

  async function fetchObservations(params) {
    const rows = [];
    let cursor;
    let page = 1;
    for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
      let body;
      if (apiVersion === 'v2') {
        const query = new URLSearchParams({
          fields: 'core,basic,time,io,metadata,model,usage,trace_context',
          fromStartTime,
          toStartTime: new Date().toISOString(),
          limit: '1000',
          ...params,
        });
        if (cursor) query.set('cursor', cursor);
        const response = await fetchWithDeadline(`${origin}/api/public/v2/observations?${query}`);
        if (response.status === 404) {
          // v2 gated off (self-hosted v3 default) — fall back for the whole run.
          apiVersion = 'v1';
          log('Langfuse v2 observations API not available — falling back to v1');
          pageCount -= 1; // retry this page on v1
          continue;
        }
        body = await readJson(response);
        rows.push(...(body.data ?? []));
        cursor = body.meta?.cursor;
        if (!cursor) return normalizeLegacyRows(rows, params.traceId);
      } else {
        // v1 has no `fields`/cursor: page-based pagination, full rows.
        const query = new URLSearchParams({
          fromStartTime,
          toStartTime: new Date().toISOString(),
          limit: '100',
          page: String(page),
          ...params,
        });
        const response = await fetchWithDeadline(`${origin}/api/public/observations?${query}`);
        body = await readJson(response);
        rows.push(...(body.data ?? []));
        const totalPages = body.meta?.totalPages ?? 1;
        if (page >= totalPages) return normalizeLegacyRows(rows, params.traceId);
        page += 1;
      }
    }
    throw new Error(`Langfuse observations query exceeded ${MAX_PAGES} pages`);
  }

  async function normalizeLegacyRows(rows, traceId) {
    if (apiVersion !== 'v1' || !traceId || rows.length === 0) return rows;
    const response = await fetchWithDeadline(
      `${origin}/api/public/traces/${encodeURIComponent(traceId)}`,
    );
    const trace = await readJson(response);
    return rows.map((observation) => ({
      ...observation,
      sessionId: trace.sessionId,
      tags: trace.tags,
      ...(observation.model && !observation.providedModelName
        ? { providedModelName: observation.model }
        : {}),
    }));
  }

  async function fetchWithDeadline(url) {
    // A hung fetch must not outlive the polling deadline — no floor, so a
    // nearly-exhausted deadline aborts almost immediately.
    const remaining = deadline - Date.now();
    const response = await fetchImpl(url, {
      headers: { authorization: auth, accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining))),
    });
    if (response.status === 429) {
      // Rate limits are shared per organization — honor Retry-After
      // instead of burning the deadline on failures.
      const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
      throw Object.assign(new Error('Langfuse rate limited the observations query (HTTP 429)'), {
        retryAfterMs:
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : POLL_INTERVAL_MS,
      });
    }
    return response;
  }

  async function readJson(response) {
    if (!response.ok) {
      // Status only — a response body can carry request details or internals.
      throw new Error(`Langfuse observations query failed with HTTP ${response.status}`);
    }
    // Parse manually: response.json() error messages embed a snippet of the
    // response body, which must never reach the CI log. The read is capped —
    // an `io`-carrying page can otherwise buffer unbounded model payloads.
    try {
      return JSON.parse(await readBodyCapped(response, MAX_RESPONSE_BYTES));
    } catch {
      throw new Error('Langfuse observations query returned invalid JSON or an oversized body');
    }
  }

  let lastState;
  while (true) {
    if (Date.now() > deadline) {
      return { ok: false, state: lastState ?? 'no poll completed' };
    }
    let waitMs = POLL_INTERVAL_MS;
    try {
      const observations = await fetchObservations({ traceId: targetTraceId });
      log(`--- trace ${targetTraceId}: ${observations.length} observation(s) ---`);
      for (const o of observations) {
        log(`  ${o.type}:${o.name} parent=${o.parentObservationId ?? 'null'} end=${o.endTime ?? 'null'}`);
      }
      const problems = evaluateTrace(observations, codeword, scenario);
      if (problems.length === 0) {
        return { ok: true, state: `trace ${targetTraceId} matches the expected pi-telemetry shape` };
      }
      lastState =
        observations.length === 0
          ? `trace ${targetTraceId} is not visible yet`
          : `trace ${targetTraceId} incomplete: ${problems.join('; ')}`;
      log(`  not complete yet: ${problems.join('; ')}`);
    } catch (error) {
      log(`Langfuse poll failed: ${error.message}`);
      lastState = `poll error: ${error.message}`;
      if (error.retryAfterMs) waitMs = error.retryAfterMs;
    }

    if (Date.now() > deadline) {
      return { ok: false, state: lastState ?? 'no poll completed' };
    }
    await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())));
  }
}

async function main() {
  const publicKey = envOr(process.env.LANGFUSE_PUBLIC_KEY, '');
  const secretKey = envOr(process.env.LANGFUSE_SECRET_KEY, '');
  if (!publicKey || !secretKey) {
    console.error('::error::LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.');
    process.exit(1);
  }

  const codeword = envOr(process.env.TELEMETRY_CODEWORD, 'ci-langfuse-probe');
  const scenario = envOr(process.env.TELEMETRY_SCENARIO, 'basic');
  const fromStartTime = envOr(
    process.env.TELEMETRY_TRACE_FROM,
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  );
  const result = await runVerification({
    baseUrl: process.env.LANGFUSE_BASE_URL,
    publicKey,
    secretKey,
    fromStartTime,
    codeword,
    traceId: traceIdForCodeword(codeword),
    scenario,
    // Diagnostics go to stderr; stdout stays reserved for the final verdict.
    log: (message) => console.error(message),
  });

  if (result.ok) {
    console.log(`✓ ${result.state}.`);
    return;
  }
  console.error(
    `::error::pi-telemetry trace did not reach the expected shape before the deadline ` +
      `(codeword "${codeword}", fromStartTime ${fromStartTime}). Last state: ${result.state}`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
