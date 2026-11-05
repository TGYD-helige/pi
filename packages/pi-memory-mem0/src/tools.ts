import { boundStructuredContent, describeToolError } from '@amaster.ai/pi-shared';
/**
 * Active memory tool — the LLM-callable interface over the Mem0 provider.
 *
 * Borrowed from the official @mem0/pi-agent-plugin design (a single
 * action-dispatched tool), but built on this package's Mem0Provider so it
 * works with platform, embedded, and self-hosted backends, and keeps the
 * package's security boundaries: credentials are redacted before storage,
 * and memory text returned to the model is wrapped as untrusted data.
 */

import { StringEnum } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { formatRecalledMemory, redactMemoryText } from './privacy.js';
import { getAddResult, type Mem0Provider, waitWithCancellation } from './provider.js';
import type { MemoryItem } from './types.js';

/** Tool results land in model context — keep the block small. */
const MAX_ENTRY_CHARS = 1_000;
const MAX_BLOCK_BYTES = 16 * 1024;
const MAX_BLOCK_LINES = 200;

export interface Mem0MemoryToolOptions {
  /**
   * Resolved at execute time, not registration time: the tool is registered
   * once per session_start, and a later session may switch memoryMode or tear
   * the provider down. Reading through the accessor keeps the lingering tool
   * registration from acting on a stale session's provider. The tool is
   * declared before the backend finishes initializing, so this may return a
   * promise that settles once the session's provider is ready (or undefined
   * if init failed or the session was replaced).
   */
  getProvider: () => Mem0Provider | undefined | Promise<Mem0Provider | undefined>;
  getUserId: () => string;
  getAgentId: () => string | undefined;
  /**
   * The runtime keeps tool registrations for the life of the extension. The
   * active tool list hides this tool in disabled sessions, while this gate also
   * protects against already queued or direct calls to the stale registration.
   */
  isEnabled: () => boolean;
  /** Identify session changes while a call awaits backend initialization. */
  getSessionEpoch?: () => number;
  topK?: number;
}

const mem0OutputSchema = Type.Union([
  Type.Object({
    memories: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String(),
            truncated: Type.Optional(Type.Literal(false)),
            memory: Type.String(),
            score: Type.Optional(Type.Number()),
            created_at: Type.Optional(Type.String()),
            updated_at: Type.Optional(Type.String()),
          }),
          Type.Object({ id: Type.String(), truncated: Type.Literal(true) }),
        ]),
      ),
    ),
    total: Type.Optional(Type.Integer()),
    message: Type.Optional(Type.String()),
    deletedId: Type.Optional(Type.String()),
    writeStatus: Type.Optional(StringEnum(['saved', 'pending', 'unknown', 'empty'] as const)),
    truncated: Type.Boolean(),
  }),
  Type.Object({
    error: Type.String(),
    errorCategory: Type.Optional(Type.String()),
    httpStatus: Type.Optional(Type.Integer()),
    truncated: Type.Boolean(),
  }),
]);

function textResult(text: string, value: object = { message: text }): AgentToolResult<unknown> {
  const data = boundStructuredContent(value);
  return {
    content: [
      {
        type: 'text',
        text: truncateHead(text, { maxBytes: MAX_BLOCK_BYTES, maxLines: MAX_BLOCK_LINES }).content,
      },
    ],
    details: data,
    structuredContent: data,
    ...('error' in data ? { isError: true } : {}),
  };
}

function errorResult(text: string): AgentToolResult<unknown> {
  return { ...textResult(text, { error: text }), isError: true };
}

function formatEntry(entry: MemoryItem): string {
  const text = truncateLine(entry.memory.trim(), MAX_ENTRY_CHARS).text;
  const date = (entry.updated_at ?? entry.created_at)?.slice(0, 10);
  return `- ${entry.id}${date ? ` (${date})` : ''}: ${formatRecalledMemory(text)}`;
}

function formatBlock(
  title: string,
  entries: MemoryItem[],
  extra: object = {},
): AgentToolResult<unknown> {
  const memories = entries
    .filter((e) => e.memory?.trim())
    .map((e) => ({
      id: e.id,
      memory: redactMemoryText(e.memory),
      ...(e.score !== undefined ? { score: e.score } : {}),
      ...(e.created_at ? { created_at: e.created_at } : {}),
      ...(e.updated_at ? { updated_at: e.updated_at } : {}),
    }));
  const data = boundStructuredContent({ memories, total: memories.length, ...extra });
  if (typeof data.error === 'string') return textResult(data.error, data);
  const visibleCount = Array.isArray(data.memories) ? data.memories.length : 0;
  const lines = memories.slice(0, visibleCount).map(formatEntry);
  return textResult(
    lines.length
      ? `${title}\n${lines.join('\n')}${data.truncated ? '\n[Memory results truncated]' : ''}`
      : 'No memories found.',
    data,
  );
}

export function createMem0MemoryTool(opts: Mem0MemoryToolOptions): ToolDefinition {
  const topK = opts.topK ?? 5;

  return {
    name: 'mem0_memory',
    label: 'Mem0 Memory',
    description:
      'Read and manage long-term semantic memories about the user and their projects. ' +
      'Memories are facts extracted from past conversations, stored in Mem0.\n\n' +
      'Actions:\n' +
      '- search: semantic search over memories (requires query)\n' +
      '- add: store a durable fact (requires content)\n' +
      '- get_all: list every stored memory\n' +
      '- delete: remove a memory by id (requires memory_id, taken from search/get_all results)',
    promptSnippet: 'Search and manage long-term semantic memories (Mem0).',
    promptGuidelines: [
      'Search mem0_memory BEFORE answering when the request could depend on the user’s past work, preferences, or prior decisions.',
      'Save durable facts proactively — user preferences, corrections, environment facts. Do not save task progress or temporary session state.',
      'An accepted add may still be processing in the background. Do not retry an accepted write just because search does not find it yet.',
    ],
    outputSchema: mem0OutputSchema,
    parameters: Type.Object({
      action: StringEnum(['search', 'add', 'get_all', 'delete'] as const, {
        description: 'The memory operation to perform.',
      }),
      query: Type.Optional(Type.String({ description: 'Search query. Required for search.' })),
      content: Type.Optional(
        Type.String({ description: 'Memory content to store. Required for add.' }),
      ),
      memory_id: Type.Optional(
        Type.String({ description: 'Memory id to remove. Required for delete.' }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const action = String(params.action ?? '');
      const signalOpts = signal ? { signal } : {};

      if (!opts.isEnabled()) {
        return errorResult('mem0_memory is disabled in this session.');
      }

      const epoch = opts.getSessionEpoch?.();
      try {
        const provider = await waitWithCancellation(Promise.resolve(opts.getProvider()), signal);
        if (!provider || !opts.isEnabled() || epoch !== opts.getSessionEpoch?.()) {
          return errorResult('Mem0 is not active.');
        }
        const userId = opts.getUserId();
        const agentId = opts.getAgentId();
        const scope = { userId, ...(agentId ? { agentId } : {}) };

        switch (action) {
          case 'search': {
            const query = redactMemoryText(String(params.query ?? '').trim());
            if (!query) return errorResult('query is required for the search action.');
            const results = await provider.search(query, { ...scope, topK, ...signalOpts });
            return formatBlock(`## Memories matching "${query}"`, results);
          }
          case 'add': {
            const content = redactMemoryText(String(params.content ?? '').trim());
            if (!content) return errorResult('content is required for the add action.');
            const result = await provider.add([{ role: 'user', content }], {
              ...scope,
              ...signalOpts,
            });
            const { message, memories: created, isError, writeStatus } = getAddResult(result);
            if (message)
              return isError ? errorResult(message) : textResult(message, { message, writeStatus });
            return formatBlock(`Saved ${created.length} memories:`, created, { writeStatus });
          }
          case 'get_all': {
            const results = await provider.getAll({ ...scope, ...signalOpts });
            return formatBlock(`## All memories (${results.length})`, results);
          }
          case 'delete': {
            const memoryId = String(params.memory_id ?? '').trim();
            if (!memoryId) return errorResult('memory_id is required for the delete action.');
            await provider.delete(memoryId, signalOpts);
            return textResult(`Deleted memory ${memoryId}.`, { deletedId: memoryId });
          }
          default:
            return errorResult(
              `Unknown action "${action}". Available: search, add, get_all, delete.`,
            );
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const failure = describeToolError(
          'mem0_memory operation',
          err,
          'Inspect stored memories before retrying a write.',
        );
        console.error(
          `[pi-memory-mem0] mem0_memory failed (category=${failure.errorCategory}${failure.httpStatus ? `, HTTP ${failure.httpStatus}` : ''})`,
        );
        return textResult(failure.error, failure);
      }
    },
  };
}
