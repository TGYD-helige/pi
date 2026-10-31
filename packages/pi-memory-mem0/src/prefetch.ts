/**
 * Two-phase semantic prefetch — kicks off a background search on input,
 * consumes the result on before_agent_start with a timeout.
 */

import { truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';
import { formatRecalledMemory } from './privacy.js';
import { type Mem0Provider, waitWithCancellation } from './provider.js';
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
  private pending:
    | { promise: Promise<MemoryItem[]>; controller: AbortController; signal: AbortSignal }
    | undefined;
  private readonly searchState: { active: Promise<MemoryItem[]> | undefined };

  constructor(
    provider: Mem0Provider,
    userId: string,
    opts: {
      agentId?: string;
      topK: number;
      searchState?: { active: Promise<MemoryItem[]> | undefined };
    },
  ) {
    this.searchState = opts.searchState ?? { active: undefined };
    this.provider = provider;
    this.userId = userId;
    this.agentId = opts.agentId;
    this.topK = opts.topK;
  }

  /** Phase 1: kick off a background search (called on input with user text). */
  queue(query: string, signal?: AbortSignal): boolean {
    if (!query.trim()) return false;
    this.cancel();
    // shortcut: embedded searches cannot be aborted; pass signals when its SDK supports them.
    if (this.searchState.active && !this.provider.supportsSearchCancellation) return false;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    if (combined.aborted) return false;
    const promise = this.provider.search(query, {
      userId: this.userId,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      topK: this.topK,
      ...(this.provider.supportsSearchCancellation ? { signal: combined } : {}),
    });
    if (!this.provider.supportsSearchCancellation) this.searchState.active = promise;
    this.pending = { promise, controller, signal: combined };
    const settled = () => {
      if (this.searchState.active === promise) this.searchState.active = undefined;
    };
    void promise.then(settled, settled);
    return true;
  }

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  cancel(): void {
    this.pending?.controller.abort();
    this.pending = undefined;
  }

  /** Phase 2: consume the result with a timeout (called on before_agent_start). */
  async consume(timeoutMs = 3000): Promise<string | undefined> {
    if (!this.pending) return;

    const pending = this.pending;
    const timer = setTimeout(() => pending.controller.abort(), timeoutMs);

    try {
      const memories = await waitWithCancellation(pending.promise, pending.signal);
      if (pending.signal.aborted) return;

      if (memories.length === 0) return '';

      const lines = memories
        .filter((m) => m.memory?.trim())
        .map((m) => {
          const date = (m.updated_at ?? m.created_at)?.slice(0, 10);
          return `- ${date ? `(${date}) ` : ''}${formatRecalledMemory(truncateLine(m.memory.trim(), MAX_ENTRY_CHARS).text)}`;
        });

      if (lines.length === 0) return '';
      return truncateHead(`## Recalled Memories (Mem0)\n${lines.join('\n')}`, {
        maxBytes: MAX_BLOCK_BYTES,
        maxLines: MAX_BLOCK_LINES,
      }).content;
    } catch {
      return;
    } finally {
      clearTimeout(timer);
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
