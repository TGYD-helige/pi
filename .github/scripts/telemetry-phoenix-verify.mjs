#!/usr/bin/env node

// Verifies the same Stage C prompt as telemetry-langfuse-verify.mjs, through
// Phoenix's spans API. PHOENIX_PROJECT_NAME selects an existing project;
// the codeword selects its trace without creating per-run projects.
// Required env: PHOENIX_API_KEY, PHOENIX_COLLECTOR_ENDPOINT.
// Optional env: PHOENIX_PROJECT_NAME (default github-pi), TELEMETRY_CODEWORD,
//               TELEMETRY_SCENARIO (basic/hierarchy/redacted).

import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  envOr,
  evaluateTrace,
  readBodyCapped,
  traceIdForCodeword,
} from './telemetry-langfuse-verify.mjs';

const DEFAULT_PROJECT_NAME = 'github-pi';
const DEFAULT_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function phoenixApiBase(endpoint) {
  const normalized = endpoint.trim().replace(/\/+$/, '');
  const suffix = '/v1/traces';
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
}

function parsePayload(value) {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toObservations(spans, traceId) {
  return spans
    .filter((span) => span.context?.trace_id === traceId)
    .map((span) => {
      const attributes = span.attributes ?? {};
      const kind = span.span_kind;
      const firstToken = span.events?.find((event) => event.name === 'first_token');
      return {
        id: span.context.span_id,
        traceId: span.context.trace_id,
        type: kind === 'LLM' ? 'GENERATION' : kind === 'TOOL' ? 'TOOL' : 'SPAN',
        name: span.name,
        parentObservationId: span.parent_id ?? null,
        startTime: span.start_time,
        endTime: span.end_time,
        sessionId: attributes['session.id'],
        tags: [],
        metadata: { costSource: attributes.costSource },
        ...(kind === 'LLM'
          ? {
              providedModelName: attributes['llm.model_name'],
              modelParameters: { provider: attributes['llm.provider'] },
              usageDetails: {
                input: attributes['llm.token_count.prompt'],
                output: attributes['llm.token_count.completion'],
                total: attributes['llm.token_count.total'],
              },
              costDetails: { total: attributes['llm.cost.total'] },
              completionStartTime: firstToken?.timestamp,
            }
          : {}),
        ...(attributes['input.value'] !== undefined
          ? { input: parsePayload(attributes['input.value']) }
          : {}),
        ...(attributes['output.value'] !== undefined
          ? { output: parsePayload(attributes['output.value']) }
          : {}),
      };
    });
}

export async function runVerification({
  endpoint,
  apiKey,
  projectName = DEFAULT_PROJECT_NAME,
  codeword,
  scenario = 'basic',
  deadlineMs = DEFAULT_DEADLINE_MS,
  fetchImpl = fetch,
  sleep = delay,
  log = () => {},
}) {
  const origin = phoenixApiBase(endpoint);
  const targetTraceId = traceIdForCodeword(codeword);
  const deadline = Date.now() + deadlineMs;

  async function fetchWithDeadline(url) {
    const remaining = deadline - Date.now();
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining))),
    });
    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
      throw Object.assign(new Error('Phoenix rate limited the spans query (HTTP 429)'), {
        retryAfterMs:
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : POLL_INTERVAL_MS,
      });
    }
    return response;
  }

  async function readJson(response) {
    if (!response.ok) throw new Error(`Phoenix spans query failed with HTTP ${response.status}`);
    try {
      return JSON.parse(await readBodyCapped(response, MAX_RESPONSE_BYTES));
    } catch {
      throw new Error('Phoenix spans query returned invalid JSON or an oversized body');
    }
  }

  async function fetchSpans() {
    const query = new URLSearchParams({ limit: '100', order: 'asc', trace_id: targetTraceId });
    const response = await fetchWithDeadline(
      `${origin}/v1/projects/${encodeURIComponent(projectName)}/spans?${query}`,
    );
    const body = await readJson(response);
    if (body.next_cursor) throw new Error('Phoenix project exceeded the 100-span verification bound');
    return body.data ?? [];
  }

  let lastState;
  while (true) {
    if (Date.now() > deadline) return { ok: false, state: lastState ?? 'no poll completed' };
    let waitMs = POLL_INTERVAL_MS;
    try {
      const spans = await fetchSpans();
      const observations = toObservations(spans, targetTraceId);
      log(`--- Phoenix trace ${targetTraceId}: ${observations.length} span(s) ---`);
      for (const observation of observations) {
        log(
          `  ${observation.type}:${observation.name} parent=${observation.parentObservationId ?? 'null'} end=${observation.endTime ?? 'null'}`,
        );
      }
      const problems = evaluateTrace(observations, codeword, scenario, {
        requireServiceMetadata: false,
      });
      if (problems.length === 0) {
        return { ok: true, state: `Phoenix trace ${targetTraceId} matches the expected pi-telemetry shape` };
      }
      lastState =
        observations.length === 0
          ? `Phoenix trace ${targetTraceId} is not visible yet`
          : `Phoenix trace ${targetTraceId} incomplete: ${problems.join('; ')}`;
      log(`  not complete yet: ${problems.join('; ')}`);
    } catch (error) {
      log(`Phoenix poll failed: ${error.message}`);
      lastState = `poll error: ${error.message}`;
      if (error.retryAfterMs) waitMs = error.retryAfterMs;
    }
    if (Date.now() > deadline) return { ok: false, state: lastState ?? 'no poll completed' };
    await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())));
  }
}

async function main() {
  const endpoint = envOr(process.env.PHOENIX_COLLECTOR_ENDPOINT, '');
  const apiKey = envOr(process.env.PHOENIX_API_KEY, '');
  if (!endpoint || !apiKey) {
    console.error('::error::PHOENIX_API_KEY and PHOENIX_COLLECTOR_ENDPOINT are required.');
    process.exit(1);
  }
  const projectName = envOr(process.env.PHOENIX_PROJECT_NAME, DEFAULT_PROJECT_NAME);
  const codeword = envOr(process.env.TELEMETRY_CODEWORD, 'ci-langfuse-probe');
  const scenario = envOr(process.env.TELEMETRY_SCENARIO, 'basic');
  const result = await runVerification({
    endpoint,
    apiKey,
    projectName,
    codeword,
    scenario,
    log: (message) => console.error(message),
  });
  if (result.ok) {
    console.log(`✓ ${result.state}.`);
    return;
  }
  console.error(
    `::error::pi-telemetry Phoenix trace did not reach the expected shape before the deadline ` +
      `(codeword "${codeword}", project "${projectName}"). Last state: ${result.state}`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
