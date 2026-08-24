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
import type { Mem0Provider } from './provider.js';

/** Tool results land in model context — keep the block small. */
const MAX_ENTRY_CHARS = 1_000;
const MAX_BLOCK_BYTES = 16 * 1024;
const MAX_BLOCK_LINES = 200;

export interface Mem0MemoryToolOptions {
  /**
   * Resolved at execute time, not registration time: the tool is registered
   * once per session_start, and a later session may switch memoryMode or tear
   * the provider down. Reading through the accessor keeps the lingering tool
   * registration from acting on a stale session's provider.
   */
  getProvider: () => Mem0Provider | undefined;
  getUserId: () => string;
  getAgentId: () => string | undefined;
  /**
   * The runtime keeps tool registrations for the life of the extension — a
   * tool registered in a hybrid/active session is still callable after a
   * later session switches to passive. This gate makes the stale registration
   * report itself disabled instead of acting on the passive session.
   */
  isEnabled: () => boolean;
  topK?: number;
}

/**
 * AgentToolResult has no isError field in this runtime — agent-core marks any
 * non-throwing execute() as success. Keep the flag anyway (documented extension
 * contract; a future runtime may honor it) via an intersection so the literals
 * typecheck.
 */
type Mem0ToolResult = AgentToolResult<unknown> & { isError?: boolean };

function textResult(text: string): Mem0ToolResult {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function errorResult(text: string): Mem0ToolResult {
  return { isError: true, content: [{ type: 'text' as const, text }], details: undefined };
}

function formatEntry(entry: { id: string; memory: string }): string {
  const text = truncateLine(entry.memory.trim(), MAX_ENTRY_CHARS).text;
  return `- ${entry.id}: ${formatRecalledMemory(text)}`;
}

function formatBlock(
  title: string,
  entries: Array<{ id: string; memory: string }>,
): AgentToolResult<unknown> {
  const lines = entries.filter((e) => e.memory?.trim()).map(formatEntry);
  if (lines.length === 0) return textResult('No memories found.');
  return textResult(
    truncateHead(`${title}\n${lines.join('\n')}`, {
      maxBytes: MAX_BLOCK_BYTES,
      maxLines: MAX_BLOCK_LINES,
    }).content,
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
    ],
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
      const provider = opts.getProvider();
      if (!provider) return errorResult('Mem0 is not active.');
      const userId = opts.getUserId();
      const agentId = opts.getAgentId();
      const scope = { userId, ...(agentId ? { agentId } : {}) };

      try {
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
            const created = result?.results ?? [];
            if (created.length === 0) {
              return textResult('No memory was extracted from the provided content.');
            }
            return formatBlock(`Saved ${created.length} memories:`, created);
          }
          case 'get_all': {
            const results = await provider.getAll({ ...scope, ...signalOpts });
            return formatBlock(`## All memories (${results.length})`, results);
          }
          case 'delete': {
            const memoryId = String(params.memory_id ?? '').trim();
            if (!memoryId) return errorResult('memory_id is required for the delete action.');
            await provider.delete(memoryId, signalOpts);
            return textResult(`Deleted memory ${memoryId}.`);
          }
          default:
            return errorResult(
              `Unknown action "${action}". Available: search, add, get_all, delete.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pi-memory-mem0] mem0_memory ${action} failed: ${message}`);
        return errorResult(`mem0_memory ${action} failed: ${message}`);
      }
    },
  };
}
