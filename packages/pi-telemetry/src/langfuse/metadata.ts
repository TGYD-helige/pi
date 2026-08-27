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
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

export function toLangfuseUsageDetails(usage: RuntimeLlmUsage): JsonObject {
  return {
    ...(usage.input !== undefined ? { input: usage.input } : {}),
    ...(usage.output !== undefined ? { output: usage.output } : {}),
    ...(usage.cacheRead !== undefined ? { cache_read: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cache_write: usage.cacheWrite } : {}),
    ...(usage.totalTokens !== undefined ? { total: usage.totalTokens } : {}),
  };
}

// Langfuse maps these two JSON-string attributes onto a generation's
// usage/cost statistics; unrecognized flat keys (usage.input etc.) would only
// land in unfilterable metadata.
export function langfuseUsageAttributes(usage: RuntimeLlmUsage): JsonObject {
  return {
    'langfuse.observation.usage_details': JSON.stringify(toLangfuseUsageDetails(usage)),
    ...(usage.cost
      ? {
          'langfuse.observation.cost_details': JSON.stringify({
            ...(usage.cost.input !== undefined ? { input: usage.cost.input } : {}),
            ...(usage.cost.output !== undefined ? { output: usage.cost.output } : {}),
            ...(usage.cost.total !== undefined ? { total: usage.cost.total } : {}),
          }),
        }
      : {}),
  };
}

export function langfuseTraceId(traceId: string): string {
  return createHash('sha256').update(`trace:${traceId}`).digest('hex').slice(0, 32);
}
