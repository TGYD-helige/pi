import { mkdir, open, opendir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveConfigDir } from '@amaster.ai/pi-shared/settings';
import {
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import {
  type ConsolidationModelRegistry,
  type DreamTurn,
  runConsolidation,
} from './consolidation.js';
import { readDreamingState, writeDreamingState } from './dreaming-state.js';

export interface DreamingConfig {
  enabled?: boolean;
  minHoursSinceLastRun?: number;
  minTurnsSinceLastRun?: number;
  /** @deprecated Use minTurnsSinceLastRun. */
  minSessionsSinceLastRun?: number;
  model?: { provider: string; model: string };
}

export interface RunDreamOptions {
  dreaming?: DreamingConfig;
  memoryDir: string;
  modelRegistry: ConsolidationModelRegistry;
  /** Current Pi session directory. */
  sessionDir?: string;
  /** Include sessions from every default Pi project directory. Default: false. */
  includeGlobalSessions?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_TURNS = 5;
const DEFAULT_MODEL = { provider: 'openai', model: 'gpt-4.1-mini' };

/** Run one gated memory-consolidation pass from the pi-memory extension. */
export async function runDream(options: RunDreamOptions): Promise<boolean> {
  const config = options.dreaming ?? {};
  if (config.enabled === false || options.signal?.aborted) return false;

  const modelConfig = config.model ?? DEFAULT_MODEL;
  const model = options.modelRegistry.find(modelConfig.provider, modelConfig.model);
  if (!model) return false;

  await mkdir(options.memoryDir, { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(options.memoryDir, { retries: 0, stale: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return false;
    throw error;
  }

  const discovery: { active?: Promise<unknown> } = {};
  try {
    const state = await readDreamingState(options.memoryDir);
    const now = Date.now();
    const minHours = config.minHoursSinceLastRun ?? DEFAULT_MIN_HOURS;
    const minTurns =
      config.minTurnsSinceLastRun ?? config.minSessionsSinceLastRun ?? DEFAULT_MIN_TURNS;

    // Gate check: enough time since last run?
    if (state.lastConsolidatedAt) {
      const elapsed = now - new Date(state.lastConsolidatedAt).getTime();
      if (elapsed < minHours * 60 * 60 * 1000) return false;
    }

    // Gate check: enough Pi session turns since last run?
    const inputs = await readDreamInputs(options, state.lastConsolidatedAt, model, discovery);
    if (!inputs || inputs.turns.length < minTurns || options.signal?.aborted) return false;
    const { turns, credentials } = inputs;

    // Consolidation
    let succeeded = false;
    try {
      succeeded = await runConsolidation({
        memoryDir: options.memoryDir,
        turns,
        modelConfig,
        modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => credentials },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      console.error(
        `[pi-memory] consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!succeeded || options.signal?.aborted) return false;

    // Only update state if consolidation ran successfully
    await writeDreamingState(
      {
        ...state,
        lastConsolidatedAt: new Date(now).toISOString(),
        lastSessionCount: turns.length,
      },
      options.memoryDir,
    );
    return true;
  } finally {
    const unlock = async () => {
      try {
        await release();
      } catch {
        console.error('[pi-memory] unable to release dreaming lock');
      }
    };
    // Keep uncancellable metadata I/O single-flight after the caller stops waiting.
    if (discovery.active) void discovery.active.then(unlock, unlock);
    else await unlock();
  }
}

// Consolidation already uses a recent transcript window; bound discovery and decoding too.
const MAX_SESSION_FILES = 32;
const MAX_SESSION_BYTES = 256 * 1024;

async function readDreamInputs(
  options: RunDreamOptions,
  lastConsolidatedAt: string | null,
  model: unknown,
  discovery: { active?: Promise<unknown> },
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(5_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (signal.aborted) return undefined;
  const operation = (async () => {
    const credentials = await options.modelRegistry.getApiKeyAndHeaders(model);
    if (!credentials.ok || signal.aborted) return undefined;
    const turns = await scanPiSessionTurns(
      options.sessionDir,
      lastConsolidatedAt,
      options.includeGlobalSessions ?? false,
      signal,
    );
    return signal.aborted ? undefined : { turns, credentials };
  })();
  discovery.active = operation;
  void operation.then(
    () => {
      delete discovery.active;
    },
    () => {
      delete discovery.active;
    },
  );
  let onAbort = () => {};
  const cancelled = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function* directoryEntries(path: string) {
  const dir = await opendir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      console.error('[pi-memory] unable to read session directory');
    return undefined;
  });
  if (dir) yield* dir;
}

async function scanPiSessionTurns(
  sessionDir: string | undefined,
  lastConsolidatedAt: string | null,
  includeGlobalSessions: boolean,
  signal?: AbortSignal,
): Promise<DreamTurn[]> {
  const since = lastConsolidatedAt ? new Date(lastConsolidatedAt).getTime() : undefined;
  const dirs = new Set(sessionDir ? [resolve(sessionDir)] : []);
  if (includeGlobalSessions) {
    const root = join(resolveConfigDir(), 'sessions');
    for await (const entry of directoryEntries(root)) {
      if (signal?.aborted) return [];
      if (entry.isDirectory()) dirs.add(join(root, entry.name));
    }
  }
  const files: Array<{ path: string; modified: number }> = [];
  for (const dir of dirs) {
    for await (const entry of directoryEntries(dir)) {
      const name = entry.name;
      if (signal?.aborted) return [];
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const metadata = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
          console.error('[pi-memory] unable to inspect session file');
        return undefined;
      });
      if (signal?.aborted) return [];
      if (!metadata?.isFile() || (since !== undefined && metadata.mtimeMs <= since)) continue;
      files.push({ path, modified: metadata.mtimeMs });
      files.sort((a, b) => b.modified - a.modified);
      if (files.length > MAX_SESSION_FILES) files.pop();
    }
  }
  const turns: DreamTurn[] = [];
  for (const file of files) {
    if (signal?.aborted) return [];
    const handle = await open(file.path, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') console.error('[pi-memory] unable to open session file');
      return undefined;
    });
    if (!handle) continue;
    try {
      if (signal?.aborted) return [];
      const metadata = await handle.stat();
      if (signal?.aborted) return [];
      const start = Math.max(0, metadata.size - MAX_SESSION_BYTES);
      const buffer = Buffer.alloc(Math.min(metadata.size, MAX_SESSION_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (signal?.aborted) return [];
      let content = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) {
        const header = Buffer.alloc(64 * 1024);
        const first = await handle.read(header, 0, header.length, 0);
        const headerText = header.subarray(0, first.bytesRead).toString('utf8');
        const headerEnd = headerText.indexOf('\n');
        if (headerEnd < 0) continue;
        content = `${headerText.slice(0, headerEnd)}\n${content.slice(content.indexOf('\n') + 1)}`;
      }
      if (signal?.aborted) return [];
      const entries = parseSessionEntries(content);
      migrateSessionEntries(entries);
      const header = entries[0];
      if (header?.type !== 'session') continue;
      const byId = new Map<string, SessionEntry>();
      let leaf: SessionEntry | undefined;
      for (const entry of entries) {
        if (entry.type === 'session') continue;
        byId.set(entry.id, entry);
        leaf = entry;
      }
      const branch: SessionEntry[] = [];
      const visited = new Set<string>();
      while (leaf && !visited.has(leaf.id)) {
        visited.add(leaf.id);
        branch.push(leaf);
        leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
      }
      turns.push(...sessionEntriesToTurns(branch.reverse(), header.id, since));
    } finally {
      await handle.close();
    }
  }
  return turns.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function sessionEntriesToTurns(
  entries: SessionEntry[],
  sessionId: string,
  since: number | undefined,
): DreamTurn[] {
  const turns: DreamTurn[] = [];
  let pending:
    | {
        id: string;
        userMessage: string;
        assistantParts: string[];
        provider: string;
        model: string;
        completedAt: number;
      }
    | undefined;

  const flush = () => {
    if (!pending || pending.assistantParts.length === 0 || pending.completedAt <= (since ?? 0)) {
      pending = undefined;
      return;
    }
    turns.push({
      id: pending.id,
      sessionId,
      conversationId: sessionId,
      userMessage: pending.userMessage,
      assistantMessage: pending.assistantParts.join('\n'),
      model: { provider: pending.provider, model: pending.model },
      createdAt: new Date(pending.completedAt).toISOString(),
    });
    pending = undefined;
  };

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') {
      flush();
      pending = {
        id: entry.id,
        userMessage: messageText(entry),
        assistantParts: [],
        provider: 'unknown',
        model: 'unknown',
        completedAt: messageTimestamp(entry),
      };
    } else if (entry.message.role === 'assistant' && pending) {
      const text = messageText(entry);
      if (text) pending.assistantParts.push(text);
      pending.provider = entry.message.provider;
      pending.model = entry.message.model;
      pending.completedAt = messageTimestamp(entry);
    }
  }
  flush();
  return turns;
}

function messageText(entry: SessionMessageEntry): string {
  if (!('content' in entry.message)) return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block && typeof block === 'object' && block.type === 'text' && 'text' in block),
    )
    .map((block) => block.text)
    .join('\n');
}

function messageTimestamp(entry: SessionMessageEntry): number {
  return typeof entry.message.timestamp === 'number'
    ? entry.message.timestamp
    : new Date(entry.timestamp).getTime();
}
