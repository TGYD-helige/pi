/**
 * Two-phase semantic prefetch — kicks off a background search on input,
 * consumes the result on before_agent_start with a timeout.
 */

import { truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';
import { formatRecalledMemory } from './privacy.js';
import type { Mem0Provider } from './provider.js';
import type { MemoryItem } from './types.js';

/** Recalled entries land in per-turn model context — keep the block small. */
const MAX_ENTRY_CHARS = 1_000;
const MAX_BLOCK_BYTES = 8 * 1024;
const MAX_BLOCK_LINES = 50;

export class Prefetch {
  private readonly provider: Mem0Provider;
  private readonly userId: string;
  private readonly agentId: string | undefined;
  private readonly topK: number;
  private pending: Promise<MemoryItem[]> | null = null;

  constructor(provider: Mem0Provider, userId: string, opts: { agentId?: string; topK: number }) {
    this.provider = provider;
    this.userId = userId;
    this.agentId = opts.agentId;
    this.topK = opts.topK;
  }

  /** Phase 1: kick off a background search (called on input with user text). */
  queue(query: string): void {
    if (!query.trim()) return;
    const search = this.provider.search(query, {
      userId: this.userId,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      topK: this.topK,
    });
    // A replaced or never-consumed search must not surface as an unhandled rejection.
    search.catch(() => {});
    this.pending = search;
  }

  /** Phase 2: consume the result with a timeout (called on before_agent_start). */
  async consume(timeoutMs = 3000): Promise<string> {
    if (!this.pending) return '';

    const promise = this.pending;
    this.pending = null;

    try {
      const memories = await Promise.race([
        promise,
        new Promise<MemoryItem[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);

      if (memories.length === 0) return '';

      const lines = memories
        .filter((m) => m.memory?.trim())
        .map(
          (m) => `- ${formatRecalledMemory(truncateLine(m.memory.trim(), MAX_ENTRY_CHARS).text)}`,
        );

      if (lines.length === 0) return '';
      return truncateHead(`## Recalled Memories (Mem0)\n${lines.join('\n')}`, {
        maxBytes: MAX_BLOCK_BYTES,
        maxLines: MAX_BLOCK_LINES,
      }).content;
    } catch {
      return '';
    }
  }
}
