/**
 * LLM-callable tools for Mem0: search, profile (get all), and save (verbatim store).
 */

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Mem0Provider } from './provider.js';

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<AgentToolResult<unknown>>;
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

export function createMem0Tools(provider: Mem0Provider, userId: string, agentId?: string): ToolDefinition[] {
  const searchTool: ToolDefinition = {
    name: 'mem0_search',
    label: 'Mem0',
    description:
      'Search long-term memories by meaning. Returns relevant facts ranked by similarity.',
    promptSnippet: 'Semantic search over long-term user memories.',
    parameters: Type.Object({
      query: Type.String({ description: 'What to search for.' }),
      top_k: Type.Optional(Type.Number({ description: 'Max results (default: 10, max: 50).' })),
    }),
    async execute(_toolCallId, params) {
      const query = String(params.query ?? '');
      const topK = Math.min(Number(params.top_k) || 10, 50);

      if (!query) return textResult(JSON.stringify({ error: 'Query cannot be empty.' }));

      try {
        const results = await provider.search(query, { userId, agentId, topK });
        if (results.length === 0) {
          return textResult(JSON.stringify({ result: 'No relevant memories found.' }));
        }
        return textResult(
          JSON.stringify({
            results: results.map((r) => ({ memory: r.memory, score: r.score })),
            count: results.length,
          }),
        );
      } catch (err) {
        return textResult(
          JSON.stringify({
            error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
    },
  };

  const profileTool: ToolDefinition = {
    name: 'mem0_profile',
    label: 'Mem0',
    description: 'Retrieve all stored long-term memories about the user.',
    promptSnippet: 'Full dump of all stored user memories.',
    parameters: Type.Object({}),
    async execute() {
      try {
        const memories = await provider.getAll({ userId, agentId });
        if (memories.length === 0) {
          return textResult(JSON.stringify({ result: 'No memories stored yet.' }));
        }
        const lines = memories.map((m) => m.memory).filter(Boolean);
        return textResult(JSON.stringify({ result: lines.join('\n'), count: lines.length }));
      } catch (err) {
        return textResult(
          JSON.stringify({
            error: `Profile failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
    },
  };

  const saveTool: ToolDefinition = {
    name: 'mem0_save',
    label: 'Mem0',
    description:
      'Store a durable fact about the user verbatim (no LLM extraction). Use for explicit preferences or corrections.',
    promptSnippet: 'Save a fact to long-term memory verbatim.',
    parameters: Type.Object({
      fact: Type.String({ description: 'The fact to store.' }),
    }),
    async execute(_toolCallId, params) {
      const fact = String(params.fact ?? '').trim();
      if (!fact) return textResult(JSON.stringify({ error: 'Fact cannot be empty.' }));

      try {
        const result = await provider.add([{ role: 'user', content: fact }], {
          userId,
          agentId,
          infer: false,
        });
        return textResult(
          JSON.stringify(result ? { result: 'Fact stored.' } : { error: 'Failed to store.' }),
        );
      } catch (err) {
        return textResult(
          JSON.stringify({
            error: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
    },
  };

  return [searchTool, profileTool, saveTool];
}
