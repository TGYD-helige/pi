/**
 * Background memory extraction via a sub-agent loop.
 *
 * Inspired by hermes-agent's `background_review`: every N turns, a background
 * Agent (from pi-agent-core) is spawned with access to the memory tools. It
 * reads the current memory state, analyzes recent conversation, and
 * autonomously adds/replaces/removes entries — handling capacity management
 * that a single-shot LLM call cannot.
 *
 * Key design choices:
 * - Full agent loop (not a single `complete()` call) so the sub-agent can
 *   react to tool results (e.g., capacity errors) and retry with replace.
 * - Reuses `createMemoryTools(store)` from tools.ts — same tool definitions
 *   the main agent uses, cast to AgentTool (structurally compatible).
 * - Fire-and-forget: extraction runs async, never blocks the main agent.
 * - Mutual exclusion: skips if the main agent already wrote memory this turn.
 * - Bounded: max 8 turns per extraction run (abort via subscriber).
 */

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { MEMORY_GUIDANCE } from './guidance.js';
import type { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionModelConfig {
  provider: string;
  model: string;
}

export interface ExtractionRunnerOptions {
  store: MemoryStore;
  modelConfig: ExtractionModelConfig;
  /** How many user turns between extraction runs. */
  interval: number;
  /** Model registry for resolving provider/model. Falls back to the default ModelRuntime if omitted. */
  modelRegistry?: {
    find(provider: string, model: string): unknown;
    getApiKeyAndHeaders(
      model: unknown,
    ): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
  };
  /** Callback for user-visible notifications. */
  onNotify?: (message: string, level: 'info' | 'warning') => void;
}

export interface ExtractionRunner {
  /** Called on every turn_end event from the extension. Manages cadence internally. */
  onTurnEnd(event: TurnEndEvent): void;
  /** Signal that the session is ending — abort any in-flight extraction. */
  shutdown(): void;
}

export interface TurnEndEvent {
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

interface AgentMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
}

interface ToolResultMessage {
  toolName: string;
  isError: boolean;
  content?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names that count as "main agent wrote memory this turn". */
const MEMORY_WRITE_TOOLS = new Set(['memory_add', 'memory_replace']);

/** Max chars of serialized conversation to pass to the sub-agent. */
const MAX_CONTEXT_CHARS = 4000;

/** Hard cap on sub-agent turns to prevent runaway loops. */
const MAX_AGENT_TURNS = 8;

const REVIEW_SYSTEM_PROMPT = `You are a background memory reviewer. Save supported durable facts the main agent missed.

${MEMORY_GUIDANCE}

## Review workflow

1. Call memory_read for both targets to see what the main agent has already saved and how much space remains.
2. Review the recent conversation for durable preferences, corrections, environment facts and conventions. Compare each candidate with existing memory; a one-off request alone is not a lasting preference.
3. Keep task progress in history and reusable procedures out of memory. Save missing facts with memory_add, update existing facts with memory_replace, and use memory_remove only when evidence establishes that an entry is wrong, redundant or superseded. Follow the shared capacity and preservation rules above.
4. Read back changed targets. Finish when each candidate is saved, already represented, excluded by the policy, or blocked by capacity; briefly report actions and any blocker. A failed write is not a saved fact: inspect the error before a corrected retry and report unresolved failures. If nothing was missed, leave memory unchanged.`;

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Creates a background extraction runner that periodically spawns a sub-agent
 * to review recent conversation and write to the memory store.
 *
 * The runner is stateful: it counts turns, buffers messages, and manages
 * the in-flight state of the background agent.
 */
export function createExtractionRunner(opts: ExtractionRunnerOptions): ExtractionRunner {
  const { store, modelConfig, interval, modelRegistry, onNotify } = opts;

  let turnsSinceExtraction = 0;
  let lastExtractionTurnIndex = -1;
  let inFlight = false;
  let shutdownFlag = false;
  let warnedOnce = false;

  /** Rolling buffer of conversation messages for the sub-agent's context. */
  const messageBuffer: Array<{ role: string; text: string; turnIndex: number }> = [];

  function onTurnEnd(event: TurnEndEvent): void {
    bufferMessage(event);
    turnsSinceExtraction++;

    if (!shouldExtract(event)) return;

    inFlight = true;
    turnsSinceExtraction = 0;
    const sinceTurn = lastExtractionTurnIndex;
    lastExtractionTurnIndex = event.turnIndex;

    // Only pass messages since last extraction to avoid re-processing.
    const messagesToAnalyze = messageBuffer.filter((m) => sinceTurn < 0 || m.turnIndex > sinceTurn);

    // Fire-and-forget: never block the main agent.
    runExtraction(messagesToAnalyze)
      .then((actionCount) => {
        if (actionCount > 0 && onNotify) {
          onNotify(
            `Background memory: ${actionCount} action${actionCount === 1 ? '' : 's'} taken.`,
            'info',
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  }

  /** Gate checks — cheapest first. */
  function shouldExtract(event: TurnEndEvent): boolean {
    if (turnsSinceExtraction < interval) return false;
    if (inFlight) return false;
    if (shutdownFlag) return false;
    // Skip if main agent already wrote memory this turn (avoid redundant work).
    if (mainAgentWroteMemory(event.toolResults)) {
      turnsSinceExtraction = 0;
      return false;
    }
    return true;
  }

  function bufferMessage(event: TurnEndEvent): void {
    const text = extractTextFromMessage(event.message);
    if (text) {
      messageBuffer.push({ role: event.message.role, text, turnIndex: event.turnIndex });
    }
  }

  /**
   * Spawn a sub-agent with memory tools, let it analyze conversation and write.
   * Returns the number of successful memory actions taken.
   */
  async function runExtraction(messages: Array<{ role: string; text: string }>): Promise<number> {
    if (messages.length === 0) return 0;

    const registry = modelRegistry ?? (await createFallbackRegistry());
    const model = registry.find(modelConfig.provider, modelConfig.model);
    if (!model) {
      if (!warnedOnce && onNotify) {
        onNotify(
          `Background extraction: model "${modelConfig.provider}/${modelConfig.model}" not found.`,
          'warning',
        );
        warnedOnce = true;
      }
      return 0;
    }

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return 0;

    // Reuse the same tool definitions as the main agent — structurally compatible.
    const tools = createMemoryTools(store) as unknown as AgentTool[];
    const serialized = serializeMessages(messages);
    const userPrompt = `Analyze this recent conversation and save any durable facts worth remembering:\n\n${serialized}`;

    let turnCount = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        model: model as never,
        tools,
      },
      streamFn: (m, ctx, streamOpts) => {
        const merged = { ...streamOpts };
        if (auth.apiKey) (merged as Record<string, unknown>).apiKey = auth.apiKey;
        if (auth.headers) (merged as Record<string, unknown>).headers = auth.headers;
        return streamSimple(m as never, ctx as never, merged);
      },
      convertToLlm: (msgs) => msgs as never[],
    });

    // Bound compute: abort after MAX_AGENT_TURNS to prevent runaway loops.
    agent.subscribe((event) => {
      if (event.type === 'turn_end') {
        turnCount++;
        if (turnCount >= MAX_AGENT_TURNS || shutdownFlag) {
          agent.abort();
        }
      }
    });

    await agent.prompt(userPrompt);

    return countMemoryActions(agent.state.messages);
  }

  function shutdown(): void {
    shutdownFlag = true;
  }

  return { onTurnEnd, shutdown };
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Check if main agent successfully wrote memory this turn. */
export function mainAgentWroteMemory(toolResults: ToolResultMessage[]): boolean {
  return toolResults.some((tr) => MEMORY_WRITE_TOOLS.has(tr.toolName) && !tr.isError);
}

/** Extract plain text from a message content (string or content-block array). */
export function extractTextFromMessage(msg: AgentMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }
  return '';
}

/**
 * Serialize messages into a compact text format for the sub-agent, capped at
 * MAX_CONTEXT_CHARS. Works backwards from newest to preserve the most recent context.
 */
export function serializeMessages(messages: Array<{ role: string; text: string }>): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const line = `[${m.role}] ${m.text}`;
    if (totalChars + line.length > MAX_CONTEXT_CHARS && lines.length > 0) break;
    lines.unshift(line);
    totalChars += line.length;
  }

  return lines.join('\n\n');
}

/**
 * Count successful memory write actions in the sub-agent's transcript.
 * Looks for toolResult messages with success:true for add/replace/remove tools.
 */
export function countMemoryActions(messages: unknown[]): number {
  let count = 0;
  for (const msg of messages) {
    const m = msg as { role?: string; toolName?: string; content?: unknown; isError?: boolean };
    if (m.role !== 'toolResult') continue;
    if (!m.toolName || m.toolName === 'memory_read') continue;
    if (m.isError) continue;
    const text = Array.isArray(m.content)
      ? (m.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
      : '';
    if (text.includes('"success": true') || text.includes('"success":true')) {
      count++;
    }
  }
  return count;
}

async function createFallbackRegistry() {
  const modelRuntime = await ModelRuntime.create();
  const registry = new ModelRegistry(modelRuntime);
  return {
    find: (provider: string, model: string) => registry.find(provider, model),
    getApiKeyAndHeaders: async (model: unknown) => {
      const auth = await registry.getApiKeyAndHeaders(model as never);
      return auth;
    },
  };
}
