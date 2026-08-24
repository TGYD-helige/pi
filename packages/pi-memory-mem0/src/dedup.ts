/**
 * Algorithmic deduplication for pi-memory-mem0 vector store.
 *
 * Normalizes content, identifies exact duplicates (case-insensitive, whitespace-collapsed),
 * deletes the older entries, and keeps only the most recently updated.
 *
 * All modes use the provider interface. In embedded mode the configured
 * vector store is the source of truth and its IDs remain stable across restarts.
 */
import { createMem0Provider, type Mem0Provider, type ProviderResolver } from './provider.js';
import type { Mem0ExtensionConfig, MemoryItem } from './types.js';

export interface DedupOptions {
  userId: string;
  agentId?: string;
  config: Mem0ExtensionConfig;
  resolveProvider?: ProviderResolver;
  signal?: AbortSignal;
  dryRun?: boolean;
  approve?: (preview: DedupResult) => boolean | Promise<boolean>;
}

export interface DedupResult {
  total: number;
  duplicatesFound: number;
  duplicatesRemoved: number;
  deleteFailures: number;
}

export async function dedupMemories(opts: DedupOptions): Promise<DedupResult> {
  const { config, resolveProvider } = opts;

  const provider = await createMem0Provider({
    config,
    ...(resolveProvider ? { resolveProvider } : {}),
  });
  return dedupProviderMemories(provider, opts);
}

export async function dedupProviderMemories(
  provider: Mem0Provider,
  opts: Pick<DedupOptions, 'userId' | 'agentId' | 'signal' | 'dryRun' | 'approve'>,
): Promise<DedupResult> {
  const { userId, agentId, signal, dryRun = false, approve } = opts;
  const scope = {
    userId,
    ...(agentId ? { agentId } : {}),
    ...(signal ? { signal } : {}),
  };
  if (!provider.getDedupGroups) {
    throw new Error('The configured Mem0 provider does not support safe deduplication.');
  }
  signal?.throwIfAborted();
  const groups = await provider.getDedupGroups(scope);
  signal?.throwIfAborted();
  const memoryIds = new Set<string>();
  for (const item of groups.flat()) {
    signal?.throwIfAborted();
    const { id } = item;
    if (!id || /\s/.test(id) || memoryIds.has(id)) {
      throw new Error('Mem0 dedup received an invalid or duplicate memory ID.');
    }
    memoryIds.add(id);
    if (!item.memory.trim()) {
      throw new Error('Mem0 dedup received empty memory content.');
    }
  }
  const total = groups.reduce((count, group) => count + group.length, 0);

  const duplicateIds = new Set(groups.flatMap((group) => findDuplicateIds(group, signal)));
  const preview = {
    total,
    duplicatesFound: duplicateIds.size,
    duplicatesRemoved: 0,
    deleteFailures: 0,
  };
  if (dryRun) return preview;
  if (approve) {
    const approved = await approve(preview);
    signal?.throwIfAborted();
    if (!approved) return preview;
  }

  let removed = 0;
  let failures = 0;
  for (const id of duplicateIds) {
    signal?.throwIfAborted();
    try {
      await (signal ? provider.delete(id, { signal }) : provider.delete(id));
      signal?.throwIfAborted();
      removed++;
    } catch {
      signal?.throwIfAborted();
      failures++;
    }
  }

  return {
    total,
    duplicatesFound: duplicateIds.size,
    duplicatesRemoved: removed,
    deleteFailures: failures,
  };
}

/**
 * Shared: find IDs of duplicate entries to remove (keeps the newest).
 */
function findDuplicateIds(allMemories: MemoryItem[], signal?: AbortSignal): string[] {
  const groups = new Map<string, MemoryItem[]>();

  for (const item of allMemories) {
    signal?.throwIfAborted();
    const normalized = item.memory.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    const group = groups.get(normalized);
    if (group) group.push(item);
    else groups.set(normalized, [item]);
  }

  const duplicateIds: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    if (!first) continue;
    let newest = first;
    let newestTime = memoryTime(first);
    const times = new Set([newestTime]);
    for (const item of rest) {
      signal?.throwIfAborted();
      const time = memoryTime(item);
      if (times.has(time)) {
        throw new Error('Mem0 dedup cannot determine the newest duplicate.');
      }
      times.add(time);
      if (time > newestTime) {
        newest = item;
        newestTime = time;
      }
    }
    duplicateIds.push(...group.filter((item) => item !== newest).map((item) => item.id));
  }

  return duplicateIds;
}

function memoryTime(item: MemoryItem): number {
  const timestamp = item.updated_at ?? item.created_at;
  const time = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(time)) {
    throw new Error('Mem0 dedup cannot determine the newest duplicate.');
  }
  return time;
}
