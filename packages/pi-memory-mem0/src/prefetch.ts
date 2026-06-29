/**
 * Two-phase semantic prefetch — kicks off a background search on turn_end,
 * consumes the result on before_agent_start with a timeout.
 */

import type { Mem0Provider } from './provider.js';
import type { MemoryItem } from './types.js';

export class Prefetch {
  private readonly provider: Mem0Provider;
  private readonly userId: string;
  private readonly agentId: string | undefined;
  private readonly topK: number;
  private pending: Promise<MemoryItem[]> | null = null;

  constructor(provider: Mem0Provider, userId: string, agentId: string | undefined, opts: { topK: number }) {
    this.provider = provider;
    this.userId = userId;
    this.agentId = agentId;
    this.topK = opts.topK;
  }

  /** Phase 1: kick off a background search (called on turn_end with user message). */
  queue(query: string): void {
    if (!query.trim()) return;
    const opts: { userId: string; agentId?: string; topK: number } = { userId: this.userId, topK: this.topK };
    if (this.agentId) opts.agentId = this.agentId;
    this.pending = this.provider.search(query, opts);
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

      const lines = memories.filter((m) => m.memory?.trim()).map((m) => `- ${m.memory.trim()}`);

      return lines.length > 0 ? `## Recalled Memories (Mem0)\n${lines.join('\n')}` : '';
    } catch {
      return '';
    }
  }
}
