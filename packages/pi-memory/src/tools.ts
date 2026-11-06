import { boundStructuredContent, describeToolError } from '@amaster.ai/pi-shared';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { MEMORY_GUIDANCE } from './guidance.js';
import type { MemoryResult, MemoryStore, MemoryTarget } from './store.js';

const targetSchema = Type.Union([Type.Literal('memory'), Type.Literal('user')], {
  description: "Which memory store: 'memory' (your notes) or 'user' (user profile).",
});

const memoryOutputSchema = Type.Union([
  Type.Object({
    entries: Type.Array(Type.String()),
    usage: Type.String(),
    success: Type.Optional(Type.Boolean()),
    target: Type.Optional(targetSchema),
    entryCount: Type.Optional(Type.Integer()),
    message: Type.Optional(Type.String()),
    truncated: Type.Boolean(),
  }),
  Type.Object({
    success: Type.Optional(Type.Literal(false)),
    error: Type.String(),
    errorCategory: Type.Optional(Type.String()),
    httpStatus: Type.Optional(Type.Integer()),
    matches: Type.Optional(Type.Array(Type.String())),
    currentEntries: Type.Optional(Type.Array(Type.String())),
    usage: Type.Optional(Type.String()),
    driftBackup: Type.Optional(Type.String()),
    remediation: Type.Optional(Type.String()),
    truncated: Type.Boolean(),
  }),
]);

function jsonResult(
  value: MemoryResult | { entries: string[]; usage: string },
): AgentToolResult<unknown> {
  const data = boundStructuredContent(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    details: data,
    structuredContent: data,
    ...('error' in data ? { isError: true } : {}),
  };
}

function asTarget(raw: unknown): MemoryTarget {
  return raw === 'user' ? 'user' : 'memory';
}

export function createMemoryTools(store: MemoryStore): ToolDefinition[] {
  const addTool: ToolDefinition = {
    name: 'memory_add',
    label: 'Memory',
    description:
      'Append a new durable fact that will help future sessions: a lasting user preference, supported correction, or stable project/environment fact. ' +
      'Read the target first. If the fact is already represented, leave it unchanged; use memory_replace for a correction or extension. ' +
      'Write a declarative fact with necessary scope, not an instruction, task log or reusable procedure. ' +
      'An exact duplicate is a successful no-op. If capacity is exceeded, inspect currentEntries and usage, then shorten or consolidate without losing supported facts. ' +
      'Keep valid entries and report a blocker if they still cannot fit; never retry the same failing add unchanged. ' +
      'After a successful write, call memory_read for this target to verify the saved state before reporting completion.',
    promptSnippet: 'Append durable facts to MEMORY.md or USER.md.',
    promptGuidelines: [MEMORY_GUIDANCE],
    outputSchema: memoryOutputSchema,
    parameters: Type.Object({
      target: targetSchema,
      content: Type.String({ description: 'The entry content to append.' }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const content = String(params.content ?? '');
      const result = await store.add(target, content);
      return jsonResult(result);
    },
  };

  const replaceTool: ToolDefinition = {
    name: 'memory_replace',
    label: 'Memory',
    description:
      'Replace an existing memory entry. Find the entry by short unique substring (oldText), ' +
      'replace the entire entry with newContent. Read the target first and preserve any still-valid qualifiers in that entry. ' +
      'Use this for corrections or lossless consolidation instead of removing + adding. ' +
      'If oldText matches zero or multiple entries, read current entries and choose a unique substring; do not guess. ' +
      'Replacement also obeys the reported capacity. On failure, keep the original and inspect the error before a corrected retry. ' +
      'After a successful replacement, call memory_read for this target to verify the new entry and preserved facts before reporting completion or removing entries it subsumes.',
    promptSnippet: 'Update an existing MEMORY.md or USER.md entry.',
    outputSchema: memoryOutputSchema,
    parameters: Type.Object({
      target: targetSchema,
      oldText: Type.String({
        description:
          'A short substring uniquely identifying the entry to replace. Must match exactly one entry.',
      }),
      newContent: Type.String({ description: 'The replacement entry content.' }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const oldText = String(params.oldText ?? '');
      const newContent = String(params.newContent ?? '');
      const result = await store.replace(target, oldText, newContent);
      return jsonResult(result);
    },
  };

  const removeTool: ToolDefinition = {
    name: 'memory_remove',
    label: 'Memory',
    description:
      'Remove a memory entry. Find the entry by short unique substring (oldText). ' +
      'Read the target first and remove only facts established to be wrong, redundant or superseded. ' +
      'A fact being unrelated to the current task is not evidence that it is obsolete. ' +
      'For duplicates created by consolidation, verify the surviving entry preserves their facts before removing them. ' +
      'If the substring matches zero or multiple entries, read current entries and choose a unique match; preserve valid entries when capacity alone is the problem. ' +
      'After a successful removal, call memory_read for this target to verify the remaining entries before reporting completion.',
    promptSnippet: 'Delete an entry from MEMORY.md or USER.md.',
    outputSchema: memoryOutputSchema,
    parameters: Type.Object({
      target: targetSchema,
      oldText: Type.String({
        description:
          'A short substring uniquely identifying the entry to remove. Must match exactly one entry.',
      }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const oldText = String(params.oldText ?? '');
      const result = await store.remove(target, oldText);
      return jsonResult(result);
    },
  };

  const readTool: ToolDefinition = {
    name: 'memory_read',
    label: 'Memory',
    description:
      'Return live entries and usage for a memory store. Use this to inspect what is currently saved ' +
      'before deciding to add, replace, or remove, after a failed write, or to verify the final state. ' +
      'Its entries and usage describe the live target, including writes made since the prompt snapshot. ' +
      'Read both targets when reviewing or consolidating memory; use the reported capacity rather than assuming a fixed limit.',
    promptSnippet: 'Read the current contents of MEMORY.md or USER.md.',
    outputSchema: memoryOutputSchema,
    parameters: Type.Object({
      target: targetSchema,
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const result = await store.read(target);
      return jsonResult(result);
    },
  };

  return [addTool, replaceTool, removeTool, readTool].map((tool) => ({
    ...tool,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      try {
        return await tool.execute(...args);
      } catch (error) {
        if (args[2]?.aborted) throw error;
        const failure = describeToolError(
          tool.name,
          error,
          'Inspect the existing memory file before retrying a write.',
        );
        console.error(`[pi-memory] ${tool.name} failed (category=${failure.errorCategory})`);
        const data = boundStructuredContent({ success: false, ...failure });
        return {
          content: [{ type: 'text' as const, text: failure.error }],
          details: data,
          structuredContent: data,
          isError: true,
        };
      }
    },
  }));
}
