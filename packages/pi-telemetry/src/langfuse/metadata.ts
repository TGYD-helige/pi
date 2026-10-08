import { createHash } from 'node:crypto';
import type {
  JsonObject,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeLlmUsage,
  RuntimeToolEvent,
} from '@amaster.ai/pi-shared';
import { compactSessionId, shortCorrelationId } from './utils.js';

export function lineageMetadata(event: {
  sessionId: string;
  conversationId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  taskRunId?: string;
  spawnBatchId?: string;
}): JsonObject {
  const sessionId = compactSessionId(event.sessionId);
  const conversationId = compactSessionId(event.conversationId);
  const taskRunId = event.taskRunId ?? shortCorrelationId(event.runId);
  // Trace-level session grouping follows the ROOT session: subagent tool and
  // generation events carry their child's local sessionId alongside
  // parentSessionId, and using it would split one trace across two sessions.
  const rootSessionId = compactSessionId(event.parentSessionId ?? event.sessionId);
  return {
    ...(sessionId ? { sessionId } : {}),
    // Mapped by Langfuse's OTEL ingestion to the trace's sessionId — without
    // it the OTEL write path loses the session grouping the SDK path had.
    ...(rootSessionId ? { 'langfuse.session.id': rootSessionId } : {}),
    ...(conversationId && conversationId !== sessionId ? { conversationId } : {}),
    ...(event.parentSessionId ? { parentSessionId: compactSessionId(event.parentSessionId) } : {}),
    ...(event.childSessionId ? { childSessionId: compactSessionId(event.childSessionId) } : {}),
    ...(taskRunId ? { taskRunId } : {}),
    ...(event.spawnBatchId ? { spawnBatchId: shortCorrelationId(event.spawnBatchId) } : {}),
  };
}

export function lifecycleMetadata(event: RuntimeLifecycleEvent): JsonObject {
  return {
    eventType: event.type,
    ...(event.promptNumber !== undefined ? { promptNumber: event.promptNumber } : {}),
    ...lineageMetadata(event),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.model ? { model: `${event.model.provider}/${event.model.model}` } : {}),
    ...(event.model?.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
    ...(event.toolPolicyProfile ? { toolPolicyProfile: event.toolPolicyProfile } : {}),
    ...(event.details ? { details: event.details } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

export function toolMetadata(event: RuntimeToolEvent): JsonObject {
  return {
    ...lineageMetadata(event),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.details ? { details: event.details } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

export function llmGenerationMetadata(event: RuntimeLlmGenerationEvent): JsonObject {
  return {
    ...lineageMetadata(event),
    llmGenerationId: event.llmGenerationId,
    status: event.status,
    model: `${event.model.provider}/${event.model.model}`,
    ...(event.model.thinkingLevel ? { thinkingLevel: event.model.thinkingLevel } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.responseId ? { responseId: event.responseId } : {}),
    ...(event.stopReason ? { stopReason: event.stopReason } : {}),
    ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
    ...(event.api ? { api: event.api } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(event.usage?.cacheWrite1h !== undefined ? { cacheWrite1h: event.usage.cacheWrite1h } : {}),
    ...(event.usage?.reasoning !== undefined ? { reasoning: event.usage.reasoning } : {}),
    ...(event.usage?.costSource ? { costSource: event.usage.costSource } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function reasoningSubset(usage: RuntimeLlmUsage): number | undefined {
  return validCount(usage.reasoning) && validCount(usage.output) && usage.reasoning <= usage.output
    ? usage.reasoning
    : undefined;
}

export function toLangfuseUsageDetails(usage: RuntimeLlmUsage): JsonObject {
  const reasoning = reasoningSubset(usage);
  return {
    ...(validCount(usage.input) ? { input: usage.input } : {}),
    ...(validCount(usage.output) ? { output: usage.output - (reasoning ?? 0) } : {}),
    ...(reasoning !== undefined ? { output_reasoning_tokens: reasoning } : {}),
    ...(validCount(usage.cacheRead) ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(validCount(usage.cacheWrite) ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
    ...(validCount(usage.totalTokens) ? { total: usage.totalTokens } : {}),
  };
}

export function langfuseUsageAttributes(usage: RuntimeLlmUsage): JsonObject {
  const cost = usage.costSource === 'unknown' ? undefined : usage.cost;
  const reasoning = reasoningSubset(usage);
  // Pi reports combined output cost; the split is proportional, not separately metered.
  const reasoningCost =
    reasoning !== undefined && usage.output && validCount(cost?.output)
      ? (cost.output * reasoning) / usage.output
      : undefined;
  return {
    'langfuse.observation.usage_details': JSON.stringify(toLangfuseUsageDetails(usage)),
    ...(cost
      ? {
          'langfuse.observation.cost_details': JSON.stringify({
            ...(validCount(cost.input) ? { input: cost.input } : {}),
            ...(validCount(cost.output) ? { output: cost.output - (reasoningCost ?? 0) } : {}),
            ...(reasoningCost !== undefined ? { output_reasoning_tokens: reasoningCost } : {}),
            ...(validCount(cost.cacheRead) ? { cache_read_input_tokens: cost.cacheRead } : {}),
            ...(validCount(cost.cacheWrite)
              ? { cache_creation_input_tokens: cost.cacheWrite }
              : {}),
            ...(validCount(cost.total) ? { total: cost.total } : {}),
          }),
          ...(reasoningCost !== undefined
            ? { 'langfuse.observation.metadata.reasoningCostSource': 'proportional-output-cost' }
            : {}),
        }
      : {}),
  };
}

export function langfuseTraceId(traceId: string): string {
  return createHash('sha256').update(`trace:${traceId}`).digest('hex').slice(0, 32);
}
