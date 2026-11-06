import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { readBodyCapped, traceIdForCodeword } from '../.github/scripts/telemetry-langfuse-verify.mjs';
import { createTelemetryExporter } from '../packages/pi-telemetry/src/otel.js';
import {
  phoenixTestContext,
  publishPromptTrace,
} from '../packages/pi-telemetry/src/__tests__/phoenix-fixture.js';

const endpoint = process.env.PHOENIX_TEST_ENDPOINT;
const apiKey = process.env.PHOENIX_TEST_API_KEY;
const liveIt = endpoint ? it : it.skip;
const PROJECT_NAME = process.env.PHOENIX_PROJECT_NAME ?? 'default';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_SPANS = 100;

type StoredSpan = {
  name: string;
  span_kind: string;
  parent_id: string | null;
  context: { trace_id: string; span_id: string };
  status_code: string;
  status_message?: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timestamp?: string }>;
};

async function fetchSpans(projectName: string, traceId: string): Promise<StoredSpan[]> {
  const query = new URLSearchParams({
    limit: String(MAX_SPANS),
    order: 'asc',
    trace_id: traceIdForCodeword(traceId),
  });
  const response = await fetch(
    `${endpoint!.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectName)}/spans?${query}`,
    {
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Phoenix spans query failed with HTTP ${response.status}`);
  let body: { data: StoredSpan[]; next_cursor?: string };
  try {
    body = JSON.parse(await readBodyCapped(response, MAX_RESPONSE_BYTES));
  } catch {
    throw new Error('Phoenix spans query returned invalid JSON or an oversized body');
  }
  if (!Array.isArray(body.data)) throw new Error('Phoenix spans query returned invalid data');
  if (body.next_cursor || body.data.length > MAX_SPANS) {
    throw new Error(`Phoenix project exceeded the ${MAX_SPANS}-span verification bound`);
  }
  return body.data;
}

async function waitForSpans(
  projectName: string,
  expected: number,
  traceId: string,
): Promise<StoredSpan[]> {
  const deadline = Date.now() + 10_000;
  let spans: StoredSpan[] = [];
  while (Date.now() < deadline) {
    spans = await fetchSpans(projectName, traceId);
    if (spans.length === expected) return spans;
    await delay(250);
  }
  return spans;
}

describe('Phoenix live integration', () => {
  liveIt('ingests prompt to LLM to tool to LLM traces with and without payloads', async () => {
    try {
      for (const includePayloads of [true, false]) {
        const traceId = `pi-telemetry-test-${randomUUID()}`;
        const exporter = createTelemetryExporter({
          includePayloads,
          phoenix: {
            enabled: true,
            endpoint: endpoint!,
            ...(process.env.PHOENIX_PROJECT_NAME ? { projectName: PROJECT_NAME } : {}),
            ...(apiKey ? { apiKey } : {}),
            flushAt: 100,
          },
        });
        try {
          await publishPromptTrace(exporter, 'hello', 'command failed', traceId);
          await exporter.flush?.();
          expect(exporter.getStatus?.()?.state).not.toBe('error');
        } finally {
          await exporter.close?.();
        }

        const spans = await waitForSpans(PROJECT_NAME, includePayloads ? 5 : 4, traceId);
        expect(spans).toHaveLength(includePayloads ? 5 : 4);
        const root = spans.find((span) => span.name === 'chat-turn');
        expect(root).toBeDefined();
        expect(root?.span_kind).toBe('AGENT');
        expect(root?.parent_id).toBeNull();
        expect(new Set(spans.map((span) => span.context.trace_id)).size).toBe(1);
        expect(new Set(spans.map((span) => span.context.span_id)).size).toBe(spans.length);
        for (const span of spans) {
          expect(span.attributes['session.id']).toBe(phoenixTestContext.sessionId);
          if (span !== root) expect(span.parent_id).toBe(root?.context.span_id);
        }

        const generations = spans.filter((span) => span.span_kind === 'LLM');
        expect(generations).toHaveLength(2);
        const generation = generations.find(
          (span) => span.attributes.llmGenerationId === 'generation-1',
        );
        expect(generation?.attributes).toMatchObject({
          'llm.system': 'deepseek',
          'llm.provider': 'deepseek',
          'llm.model_name': 'deepseek-v4-flash',
          'llm.token_count.prompt': 150,
          'llm.token_count.completion': 40,
          'llm.token_count.total': 190,
          'llm.token_count.prompt_details.cache_read': 20,
          'llm.token_count.prompt_details.cache_write': 30,
          'llm.token_count.completion_details.reasoning': 10,
          'llm.cost.prompt': 1.5,
          'llm.cost.completion': 4,
          'llm.cost.total': 5.5,
        });
        expect(generation?.attributes['llm.cost.completion_details.output']).toBeUndefined();
        const firstToken = generation?.events.find((event) => event.name === 'first_token');
        expect(firstToken).toBeDefined();
        expect(Date.parse(firstToken!.timestamp!)).toBe(Date.parse('2026-05-02T00:00:00.300Z'));

        const tool = spans.find((span) => span.span_kind === 'TOOL');
        expect(tool?.attributes).toMatchObject({ 'tool.name': 'bash', 'tool.id': 'call-1' });
        expect(tool?.status_code).toBe('ERROR');
        expect(tool?.status_message).toBe('command failed');
        if (includePayloads) {
          expect(root?.attributes['input.value']).toBe('hello');
          expect(root?.attributes['output.value']).toBe('done');
          expect(generation?.attributes['input.mime_type']).toBe('application/json');
        } else {
          expect(spans.some((span) => span.name === 'chat-input')).toBe(false);
          for (const span of spans) {
            expect(span.attributes['input.value']).toBeUndefined();
            expect(span.attributes['output.value']).toBeUndefined();
            expect(span.attributes['input.mime_type']).toBeUndefined();
            expect(span.attributes['output.mime_type']).toBeUndefined();
          }
        }
      }
    } finally {
      delete process.env.PI_TELEMETRY_TRACEPARENT;
    }
  }, 30_000);
});
