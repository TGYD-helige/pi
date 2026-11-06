import path from 'node:path';
import { describeToolError } from '@amaster.ai/pi-shared';
import { isProjectTrusted, loadPiSettings, resolveHome } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  createExtractionRunner,
  type ExtractionModelConfig,
  type ExtractionRunner,
} from './background-extraction.js';
import { type DreamingConfig, runDream } from './dream.js';
import { MEMORY_GUIDANCE } from './guidance.js';
import { MemoryStore } from './store.js';
import { scanForThreats } from './threat-patterns.js';
import { createMemoryTools } from './tools.js';

const SETTINGS_KEY = 'pi-memory';
const STATUS_KEY = 'pi-memory';
const SNAPSHOT_ENTRY = 'pi-memory:system-prompt-snapshot';
const MAX_SNAPSHOT_CHARS = 50_000;

function captureSnapshot(store: MemoryStore): string {
  const memory = store.formatForSystemPrompt('memory');
  const user = store.formatForSystemPrompt('user');
  if (!memory) return user.slice(0, MAX_SNAPSHOT_CHARS);
  if (!user) return memory.slice(0, MAX_SNAPSHOT_CHARS);
  const reservedForUser = Math.min(user.length, MAX_SNAPSHOT_CHARS / 2 - 1);
  const memoryPart = memory.slice(0, MAX_SNAPSHOT_CHARS - 2 - reservedForUser);
  return `${memoryPart}\n\n${user.slice(0, MAX_SNAPSHOT_CHARS - 2 - memoryPart.length)}`;
}

function savedSnapshot(ctx: ExtensionContext): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  const isSnapshot = (entry: { type: string; customType?: string; data?: unknown }) => {
    const data = entry.data;
    return (
      entry.type === 'custom' &&
      entry.customType === SNAPSHOT_ENTRY &&
      typeof data === 'object' &&
      data !== null &&
      'sessionId' in data &&
      data.sessionId === sessionId &&
      'snapshot' in data &&
      typeof data.snapshot === 'string'
    );
  };
  const saved =
    ctx.sessionManager.getBranch().findLast(isSnapshot) ??
    ctx.sessionManager.getEntries().find(isSnapshot);
  const data = saved?.type === 'custom' ? saved.data : undefined;
  if (!data || typeof data !== 'object' || !('snapshot' in data)) return undefined;
  const snapshot = data.snapshot;
  return typeof snapshot === 'string' &&
    snapshot.length <= MAX_SNAPSHOT_CHARS &&
    scanForThreats(snapshot, 'strict').length === 0
    ? snapshot
    : undefined;
}

export type PiMemoryExtensionConfig = {
  /** Directory containing MEMORY.md / USER.md. Default: `<agentDir>/memories`. */
  dataDir?: string;
  /** Char limit for MEMORY.md. Default 2200. */
  memoryCharLimit?: number;
  /** Char limit for USER.md. Default 1375. */
  userCharLimit?: number;
  /** Pre-built store (host-controlled mode). */
  store?: MemoryStore;
  /** Model for background memory extraction. Omit to disable extraction. */
  extractionModel?: ExtractionModelConfig;
  /** Turns between extraction runs. Default: 5. */
  extractionInterval?: number;
  /** Dreaming (opportunistic background consolidation) config. */
  dreaming?: DreamingConfig;
};

type ResolvedConfig = {
  dataDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
  store?: MemoryStore;
  extractionModel?: ExtractionModelConfig;
  extractionInterval: number;
  dreaming?: DreamingConfig;
};

function resolveConfig(raw?: PiMemoryExtensionConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    dataDir: raw?.dataDir?.trim() || path.join(resolveHome(), 'memories'),
    extractionInterval: raw?.extractionInterval ?? 5,
  };
  if (raw?.memoryCharLimit !== undefined) resolved.memoryCharLimit = raw.memoryCharLimit;
  if (raw?.userCharLimit !== undefined) resolved.userCharLimit = raw.userCharLimit;
  if (raw?.store) resolved.store = raw.store;
  if (raw?.extractionModel) resolved.extractionModel = raw.extractionModel;
  if (raw?.dreaming) resolved.dreaming = raw.dreaming;
  return resolved;
}

function loadSettings(cwd: string, projectTrusted = false): PiMemoryExtensionConfig | undefined {
  const config = loadPiSettings<Partial<PiMemoryExtensionConfig>>(SETTINGS_KEY, {
    cwd,
    projectTrusted,
  });
  return Object.keys(config).length > 0 ? (config as PiMemoryExtensionConfig) : undefined;
}

export default function memoryExtension(
  pi: ExtensionAPI,
  injectedConfig?: PiMemoryExtensionConfig,
): void {
  let store: MemoryStore | undefined;
  let extractionRunner: ExtractionRunner | undefined;
  let systemPromptSnapshot = '';
  let dreamController: AbortController | undefined;

  pi.on('session_start', async (_event, ctx) => {
    dreamController?.abort();
    const controller = new AbortController();
    dreamController = controller;
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    systemPromptSnapshot = '';
    const fileConfig = loadSettings(ctx.cwd, isProjectTrusted(ctx));
    const config = resolveConfig({ ...fileConfig, ...injectedConfig });

    try {
      if (config.store) {
        store = config.store;
      } else {
        const opts: ConstructorParameters<typeof MemoryStore>[0] = { dir: config.dataDir };
        if (config.memoryCharLimit !== undefined) opts.memoryCharLimit = config.memoryCharLimit;
        if (config.userCharLimit !== undefined) opts.userCharLimit = config.userCharLimit;
        store = new MemoryStore(opts);
      }
      await store.loadFromDisk();
      const snapshot = captureSnapshot(store);
      const saved = savedSnapshot(ctx);
      if (saved !== undefined) {
        systemPromptSnapshot = saved;
      } else {
        systemPromptSnapshot = snapshot;
        pi.appendEntry(SNAPSHOT_ENTRY, { sessionId: ctx.sessionManager.getSessionId(), snapshot });
      }

      ctx.ui.setStatus(STATUS_KEY, systemPromptSnapshot ? 'memory: loaded' : 'memory: empty');

      for (const tool of createMemoryTools(store)) {
        pi.registerTool(tool);
      }

      if (config.extractionModel && store) {
        extractionRunner = createExtractionRunner({
          store,
          modelConfig: config.extractionModel,
          interval: config.extractionInterval,
          modelRegistry: ctx.modelRegistry as never,
          onNotify: (msg, level) => ctx.ui.notify(msg, level),
        });
      }

      void runDream({
        includeGlobalSessions:
          !config.store && config.dataDir === path.join(resolveHome(), 'memories'),
        memoryDir: store.dir,
        modelRegistry: ctx.modelRegistry as never,
        sessionDir: ctx.sessionManager.getSessionDir(),
        ...(config.dreaming ? { dreaming: config.dreaming } : {}),
        signal,
      }).catch((error) => {
        if (signal.aborted) return;
        const failure = describeToolError('Background memory dream', error);
        console.error(`[pi-memory] ${failure.errorCategory}: ${failure.error}`);
        ctx.ui.notify(failure.error, 'warning');
      });
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, 'memory: unavailable');
      const failure = describeToolError('Initialize memory', err);
      console.error(`[pi-memory] ${failure.errorCategory}: ${failure.error}`);
      ctx.ui.notify(failure.error, 'error');
    }
  });

  pi.on('turn_end', async (event) => {
    if (!extractionRunner) return;
    extractionRunner.onTurnEnd(event as never);
  });

  pi.on('before_agent_start', (event) => {
    const block = [
      event.systemPrompt?.includes(MEMORY_GUIDANCE) ? '' : MEMORY_GUIDANCE,
      systemPromptSnapshot,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!block) return;
    return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${block}` : block };
  });

  pi.on('session_compact', async (_event, ctx) => {
    if (!store) return;
    await store.loadFromDisk();
    const snapshot = captureSnapshot(store);
    if (snapshot === systemPromptSnapshot) return;
    pi.appendEntry(SNAPSHOT_ENTRY, { sessionId: ctx.sessionManager.getSessionId(), snapshot });
    systemPromptSnapshot = snapshot;
    ctx.ui.setStatus(STATUS_KEY, snapshot ? 'memory: loaded' : 'memory: empty');
  });

  pi.on('session_tree', (_event, ctx) => {
    if (!store) return;
    systemPromptSnapshot = savedSnapshot(ctx) ?? captureSnapshot(store);
    ctx.ui.setStatus(STATUS_KEY, systemPromptSnapshot ? 'memory: loaded' : 'memory: empty');
  });

  pi.on('session_shutdown', async () => {
    dreamController?.abort();
    dreamController = undefined;
    extractionRunner?.shutdown();
    extractionRunner = undefined;
    store = undefined;
    systemPromptSnapshot = '';
  });

  pi.registerCommand('memory', {
    description: 'Manage persistent memory. Subcommands: status, read, add, replace, remove.',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['status', 'read', 'add', 'replace', 'remove'];
      const matches = subcommands.filter((s) => s.startsWith(prefix.trim().toLowerCase()));
      return matches.map((s) => ({ label: s, value: s }));
    },
    handler: async (args, ctx) => {
      if (!store) {
        ctx.ui.notify('pi-memory is not loaded.', 'warning');
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();

      switch (subcommand) {
        case 'status': {
          const memResult = await store.read('memory');
          const userResult = await store.read('user');
          ctx.ui.notify(
            `MEMORY.md: ${memResult.entryCount} entries (${memResult.usage})\nUSER.md: ${userResult.entryCount} entries (${userResult.usage})`,
            'info',
          );
          break;
        }

        case 'read': {
          const target = rest === 'user' ? 'user' : 'memory';
          const result = await store.read(target as 'memory' | 'user');
          if (result.entries.length === 0) {
            ctx.ui.notify(`${target}: (empty)`, 'info');
          } else {
            ctx.ui.notify(
              `${target} [${result.usage}]:\n${result.entries.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
              'info',
            );
          }
          break;
        }

        case 'add': {
          if (!rest) {
            ctx.ui.notify('Usage: /memory add [user|memory] <content>', 'warning');
            break;
          }
          const addParts = rest.split(/\s+/);
          let target: 'memory' | 'user' = 'memory';
          let content = rest;
          if (addParts[0] === 'user' || addParts[0] === 'memory') {
            target = addParts[0] as 'memory' | 'user';
            content = addParts.slice(1).join(' ');
          }
          if (!content) {
            ctx.ui.notify('Usage: /memory add [user|memory] <content>', 'warning');
            break;
          }
          const addResult = await store.add(target, content);
          ctx.ui.notify(
            addResult.success ? `Added to ${target}.` : `Failed: ${addResult.error}`,
            addResult.success ? 'info' : 'warning',
          );
          break;
        }

        case 'replace': {
          // Format: /memory replace [target] <oldText> -> <newContent>
          if (!rest?.includes('->')) {
            ctx.ui.notify(
              'Usage: /memory replace [user|memory] <oldText> -> <newContent>',
              'warning',
            );
            break;
          }
          const replaceParts = rest.split(/\s+/);
          let rTarget: 'memory' | 'user' = 'memory';
          let replaceBody = rest;
          if (replaceParts[0] === 'user' || replaceParts[0] === 'memory') {
            rTarget = replaceParts[0] as 'memory' | 'user';
            replaceBody = replaceParts.slice(1).join(' ');
          }
          const [oldText, newContent] = replaceBody.split('->').map((s) => s.trim());
          if (!oldText || !newContent) {
            ctx.ui.notify(
              'Usage: /memory replace [user|memory] <oldText> -> <newContent>',
              'warning',
            );
            break;
          }
          const replaceResult = await store.replace(rTarget, oldText, newContent);
          ctx.ui.notify(
            replaceResult.success ? `Replaced in ${rTarget}.` : `Failed: ${replaceResult.error}`,
            replaceResult.success ? 'info' : 'warning',
          );
          break;
        }

        case 'remove': {
          if (!rest) {
            ctx.ui.notify('Usage: /memory remove [user|memory] <substring>', 'warning');
            break;
          }
          const rmParts = rest.split(/\s+/);
          let rmTarget: 'memory' | 'user' = 'memory';
          let rmText = rest;
          if (rmParts[0] === 'user' || rmParts[0] === 'memory') {
            rmTarget = rmParts[0] as 'memory' | 'user';
            rmText = rmParts.slice(1).join(' ');
          }
          if (!rmText) {
            ctx.ui.notify('Usage: /memory remove [user|memory] <substring>', 'warning');
            break;
          }
          const rmResult = await store.remove(rmTarget, rmText);
          ctx.ui.notify(
            rmResult.success ? `Removed from ${rmTarget}.` : `Failed: ${rmResult.error}`,
            rmResult.success ? 'info' : 'warning',
          );
          break;
        }

        default:
          ctx.ui.notify(
            'Unknown subcommand. Available: status, read, add, replace, remove.',
            'warning',
          );
      }
    },
  });
}
