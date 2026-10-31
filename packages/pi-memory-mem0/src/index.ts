/**
 * pi-memory-mem0 — Semantic memory extension powered by Mem0.
 *
 * Backend modes:
 * - **platform**: Uses Mem0 Cloud API (needs MEM0_API_KEY)
 * - **embedded**: Runs Mem0 OSS in-process
 * - **self-hosted**: Calls a remote Mem0 OSS REST server
 *
 * Memory modes (config "memoryMode"):
 * - **passive**: automatic capture + recall injection only
 * - **active**: LLM-callable mem0_memory tool only
 * - **hybrid** (default): both
 *
 * autoCapture, autoRecall, and toolEnabled independently override the selected
 * mode's defaults. recallFrequency controls whether automatic recall runs for
 * every user input or only the first user input in a session.
 *
 * Passive side: after each conversation turn, user + assistant messages are
 * sent to Mem0 for fact extraction and storage (credentials are redacted
 * first). Recalled memories are injected as a custom message (delivered to
 * the model on the user channel, never the system prompt) and wrapped as
 * untrusted data. Active side: the mem0_memory tool lets the agent search,
 * add, list, and delete memories on its own initiative, under the same
 * redaction and untrusted-data boundaries.
 *
 * Configuration via settings.json key "pi-memory-mem0".
 * Supports ${ENV_VAR:-fallback} in user and agent settings.
 * Trusted project settings are loaded without environment interpolation.
 */

import { createHash } from 'node:crypto';
import { isProjectTrusted, loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type CapturedTurn, CaptureQueue, type CaptureState } from './capture.js';
import { dedupProviderMemories } from './dedup.js';
import { Prefetch } from './prefetch.js';
import { formatRecalledMemory, redactMemoryText, scopeMemoryUserId } from './privacy.js';
import {
  createMem0Provider,
  getAddResult,
  type Mem0Provider,
  normalizeMem0Mode,
  normalizeMemoryMode,
} from './provider.js';
import { createMem0MemoryTool } from './tools.js';
import type { Mem0ExtensionConfig, Mem0RecallFrequency, MemoryUserIdScope } from './types.js';

const SETTINGS_KEY = 'pi-memory-mem0';
const STATUS_KEY = 'mem0';
const MEMORY_TOOL_NAME = 'mem0_memory';
const SESSION_RECALL_ENTRY = 'mem0-session-recall';
const CAPTURE_ENTRY = 'mem0-pending-capture';

function loadConfig(cwd: string, projectTrusted = false): Mem0ExtensionConfig {
  try {
    return loadPiSettings<Mem0ExtensionConfig>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
    });
  } catch {
    return {};
  }
}

function resolveUserId(configUserId?: string, scope: MemoryUserIdScope = 'project'): string {
  if (configUserId?.trim()) return configUserId.trim();
  if (scope === 'exact') throw new Error('Mem0 exact userId resolved to an empty value.');
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  return 'default-user';
}

export default function mem0Extension(pi: ExtensionAPI): void {
  let provider: Mem0Provider | undefined;
  let providerReady: Promise<Mem0Provider | undefined> = Promise.resolve(undefined);
  // End pending tool waits when their session is replaced or shut down.
  let settleProviderReady: (ready: Mem0Provider | undefined) => void = () => {};
  let prefetch: Prefetch | undefined;
  const recallSearchState = { active: undefined };
  let userId = '';
  let agentId: string | undefined;
  let activeMode = '';
  let activeMemoryMode = '';
  let activeAutoCapture = false;
  let activeToolEnabled = false;
  let activeRecallFrequency: Mem0RecallFrequency = 'user-input';
  let recallQueuedThisSession = false;
  let lastUserText = '';
  let capture: CaptureQueue | undefined;
  const captureState: CaptureState = {};
  let sessionEpoch = 0;

  pi.on('session_start', async (_event, ctx) => {
    // A newer session_start (or shutdown) can run while this handler is still
    // awaiting provider init (embedded init takes seconds). The epoch check
    // after the await keeps the superseded handler from clobbering the live
    // session's provider, prefetch, and tool-enablement state.
    const epoch = ++sessionEpoch;
    capture?.close();
    capture = undefined;
    settleProviderReady(undefined);
    let settleReady: (ready: Mem0Provider | undefined) => void = () => {};
    providerReady = new Promise((resolve) => {
      settleReady = resolve;
    });
    settleProviderReady = settleReady;
    provider = undefined;
    prefetch?.cancel();
    prefetch = undefined;
    agentId = undefined;
    activeAutoCapture = false;
    activeToolEnabled = false;
    activeRecallFrequency = 'user-input';
    recallQueuedThisSession = false;
    lastUserText = '';
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== MEMORY_TOOL_NAME));
    const config = loadConfig(ctx.cwd, isProjectTrusted(ctx));
    try {
      const mode = normalizeMem0Mode(config.mode);
      const memoryMode = normalizeMemoryMode(config.memoryMode);
      const recallFrequency = config.recallFrequency ?? 'user-input';
      if (recallFrequency !== 'user-input' && recallFrequency !== 'session') {
        throw new Error(`Unsupported recall frequency: ${String(recallFrequency)}`);
      }
      const topK = config.topK ?? 5;
      if (!Number.isInteger(topK) || topK <= 0) {
        throw new Error(
          'topK must be an integer greater than 0. Use autoRecall: false to disable automatic recall.',
        );
      }
      if (
        config.requestTimeoutMs !== undefined &&
        (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
      ) {
        throw new Error('requestTimeoutMs must be a positive integer.');
      }
      for (const key of ['autoCapture', 'autoRecall', 'toolEnabled'] as const) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean') {
          throw new Error(`${key} must be a boolean.`);
        }
      }
      if (mode === 'platform' && !config.apiKey?.trim()) {
        ctx.ui.setStatus(STATUS_KEY, 'mem0: disabled (no API key)');
        return;
      }
      const resolvedUserId = resolveUserId(config.userId, config.userIdScope);
      const resolvedAgentId = config.agentId?.trim() || undefined;
      // Declare the tool before the slow backend init: its promptGuidelines are
      // part of the system prompt, so activating it only after init would
      // rewrite the prompt for any request already sent in this session.
      activeToolEnabled = config.toolEnabled ?? memoryMode !== 'passive';
      if (activeToolEnabled) {
        pi.registerTool(
          createMem0MemoryTool({
            getProvider: () => providerReady,
            getUserId: () => userId,
            getAgentId: () => agentId,
            isEnabled: () => activeToolEnabled,
            getSessionEpoch: () => sessionEpoch,
            topK,
          }),
        );
        pi.setActiveTools([
          ...pi.getActiveTools().filter((name) => name !== MEMORY_TOOL_NAME),
          MEMORY_TOOL_NAME,
        ]);
      }
      const newProvider = await createMem0Provider({
        config,
        resolveProvider: async (providerName: string) => {
          const registry = ctx.modelRegistry as {
            find?: (
              provider: string,
              modelId: string,
            ) => { baseUrl?: string; api?: string } | undefined;
            getAll?: () => Array<{ provider: string; baseUrl?: string; api?: string }>;
            getApiKeyForProvider?: (p: string) => Promise<string | undefined>;
          };
          if (!registry.getApiKeyForProvider) return undefined;

          let model: { baseUrl?: string; api?: string } | undefined;
          if (registry.getAll) {
            model = registry.getAll().find((m) => m.provider === providerName);
          }

          const apiKey = await registry.getApiKeyForProvider(providerName);
          if (!apiKey && !model) return undefined;
          const result: Record<string, string> = {};
          if (apiKey) result.apiKey = apiKey;
          if (model?.baseUrl) result.baseUrl = model.baseUrl;
          if (model?.api) result.api = model.api as string;
          return result;
        },
      });
      if (epoch !== sessionEpoch) return;
      provider = newProvider;
      userId = scopeMemoryUserId(resolvedUserId, ctx.cwd, config.userIdScope);
      agentId = resolvedAgentId;
      activeMode = mode;
      activeMemoryMode = memoryMode;
      const sessionId = ctx.sessionManager.getSessionId();
      activeAutoCapture = config.autoCapture ?? memoryMode !== 'active';
      const autoRecall = config.autoRecall ?? memoryMode !== 'active';
      const entries = activeAutoCapture || autoRecall ? ctx.sessionManager.getEntries() : [];
      const scopeKey = activeAutoCapture
        ? createHash('sha256')
            .update(JSON.stringify([config, userId, agentId]))
            .digest('hex')
        : undefined;
      let restored: CapturedTurn[] = [];
      let captureEntryId: string | null | undefined;
      recallQueuedThisSession = false;
      for (const entry of entries) {
        if (entry.type !== 'custom') continue;
        if (entry.customType === SESSION_RECALL_ENTRY && entry.data === sessionId)
          recallQueuedThisSession = true;
        if (!scopeKey || entry.customType !== CAPTURE_ENTRY) continue;
        const data = entry.data as
          | { scopeKey?: string; sessionId?: string; pending?: CapturedTurn[] }
          | undefined;
        if (
          data?.scopeKey === scopeKey &&
          data.sessionId === sessionId &&
          Array.isArray(data.pending)
        ) {
          restored = data.pending;
          captureEntryId = entry.id;
        }
      }
      if (scopeKey) {
        let snapshotPending = restored;
        capture = new CaptureQueue(
          provider,
          { userId, ...(agentId ? { agentId } : {}) },
          captureState,
          (pending) => {
            pi.appendEntry(CAPTURE_ENTRY, { scopeKey, sessionId, pending });
            snapshotPending = pending;
            captureEntryId = ctx.sessionManager.getLeafId?.();
          },
          restored,
          (message) => ctx.ui.notify(message, 'warning'),
          config.requestTimeoutMs ?? 120_000,
          (turns) => {
            const indices = turns.map((turn) => snapshotPending.indexOf(turn));
            // Reference the already-durable snapshot instead of copying potentially large payloads.
            pi.appendEntry(
              'mem0-deferred-capture',
              captureEntryId && indices.every((index) => index >= 0)
                ? { scopeKey, sessionId, sourceEntryId: captureEntryId, indices }
                : { scopeKey, sessionId, turns },
            );
          },
        );
        capture.start();
      }
      activeRecallFrequency = recallFrequency;
      if (autoRecall) {
        prefetch = new Prefetch(provider, userId, {
          searchState: recallSearchState,
          ...(agentId ? { agentId } : {}),
          topK,
        });
      }
    } catch (err) {
      if (epoch !== sessionEpoch) return;
      provider = undefined;
      prefetch = undefined;
      activeToolEnabled = false;
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== MEMORY_TOOL_NAME));
      ctx.ui.setStatus(STATUS_KEY, 'mem0: init failed');
      ctx.ui.notify(
        `Mem0 init failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return;
    } finally {
      settleReady(epoch === sessionEpoch ? provider : undefined);
    }

    ctx.ui.setStatus(STATUS_KEY, `mem0: ${activeMode}/${activeMemoryMode}`);
  });

  pi.on('input', async (event, ctx) => {
    const text = event.text ?? '';
    if (!text.trim()) return;

    if (activeAutoCapture) {
      lastUserText = text;
    }

    if (!prefetch) return;

    if (activeRecallFrequency === 'session' && recallQueuedThisSession) {
      return;
    }

    if (!prefetch.queue(redactMemoryText(text), ctx.signal)) return;

    if (activeRecallFrequency === 'session') {
      recallQueuedThisSession = true;
      if (activeMode !== 'embedded')
        pi.appendEntry(SESSION_RECALL_ENTRY, ctx.sessionManager.getSessionId());
    }
  });

  pi.on('turn_end', async (event, ctx) => {
    if (!provider || !activeAutoCapture || !lastUserText) return;

    const msg = event.message as { role?: string; content?: unknown };
    const text = extractText(msg);
    if (!text || msg.role !== 'assistant') return;

    const userText = lastUserText;
    lastUserText = '';
    try {
      if (
        !capture?.enqueue(
          {
            messages: [
              { role: 'user', content: redactMemoryText(userText) },
              { role: 'assistant', content: redactMemoryText(text) },
            ],
            observedAt: new Date().toISOString(),
          },
          ctx.signal,
        )
      ) {
        ctx.ui.notify(
          'Mem0 automatic capture skipped: pending outbox is full or this turn exceeds 64000 characters. The original turn remains in session history.',
          'warning',
        );
      }
    } catch {
      console.error('[pi-memory-mem0] unable to persist automatic capture');
      ctx.ui.notify(
        'Mem0 capture could not be saved. The original turn remains in session history.',
        'warning',
      );
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!prefetch?.hasPending || event.messageType === 'custom') return;

    const current = prefetch;
    const recalled = await current.consume();
    if (prefetch !== current) return;
    if (activeRecallFrequency === 'session' && activeMode === 'embedded') {
      recallQueuedThisSession = recalled !== undefined;
      if (recallQueuedThisSession)
        pi.appendEntry(SESSION_RECALL_ENTRY, ctx.sessionManager.getSessionId());
    }
    if (!recalled) return;

    return {
      message: {
        customType: 'mem0-recall',
        content: recalled,
        display: true,
      },
    };
  });

  pi.on('session_shutdown', async () => {
    sessionEpoch++;
    settleProviderReady(undefined);
    activeToolEnabled = false;
    prefetch?.cancel();
    capture?.close();
    capture = undefined;
    provider = undefined;
    prefetch = undefined;
    agentId = undefined;
    activeAutoCapture = false;
    activeRecallFrequency = 'user-input';
    recallQueuedThisSession = false;
    lastUserText = '';
  });

  pi.registerCommand('mem0', {
    description:
      'Mem0 memory commands. Subcommands: status, search <query>, profile, add <text>, dedup [--apply], delete <id>.',
    handler: async (args, ctx) => {
      if (!provider) {
        ctx.ui.notify('Mem0 is not active.', 'warning');
        return;
      }
      const scope = { userId, ...(agentId ? { agentId } : {}) };

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();

      switch (subcommand) {
        case 'status': {
          ctx.ui.notify(
            `Mem0: active (backend: ${activeMode}, preset: ${activeMemoryMode}, capture: ${activeAutoCapture ? 'on' : 'off'}, recall: ${prefetch ? 'on' : 'off'}, tool: ${activeToolEnabled ? 'on' : 'off'}, recall frequency: ${prefetch ? activeRecallFrequency : 'disabled'})`,
            'info',
          );
          break;
        }
        case 'search': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 search <query>', 'warning');
            break;
          }
          const results = await provider.search(rest, {
            ...scope,
            topK: 10,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (results.length === 0) {
            ctx.ui.notify('No relevant memories found.', 'info');
          } else {
            const lines = results.map((r, i) => `${i + 1}. ${formatRecalledMemory(r.memory)}`);
            ctx.ui.notify(`Mem0 search results:\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'profile': {
          const all = await provider.getAll({
            ...scope,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (all.length === 0) {
            ctx.ui.notify('No memories stored yet.', 'info');
          } else {
            const lines = all.map((m, i) => `${i + 1}. ${formatRecalledMemory(m.memory)}`);
            ctx.ui.notify(`Mem0 memories (${all.length}):\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'add': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 add <text>', 'warning');
            break;
          }
          const result = await provider.add([{ role: 'user', content: redactMemoryText(rest) }], {
            ...scope,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const { message, memories: created, isError } = getAddResult(result);
          if (message) {
            ctx.ui.notify(message, isError ? 'error' : 'info');
          } else {
            const lines = created.map((m, i) => `${i + 1}. ${formatRecalledMemory(m.memory)}`);
            ctx.ui.notify(`Mem0 saved ${created.length}:\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'dedup': {
          if (rest && rest !== '--apply') {
            ctx.ui.notify('Usage: /mem0 dedup [--apply]', 'warning');
            break;
          }
          if (rest !== '--apply') {
            const preview = await dedupProviderMemories(provider, {
              ...scope,
              dryRun: true,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            if (preview.duplicatesFound === 0) {
              ctx.ui.notify(
                `Mem0 dedup preview: scanned ${preview.total} memories; no exact duplicates found.`,
                'info',
              );
              break;
            }
            const noun = preview.duplicatesFound === 1 ? 'duplicate' : 'duplicates';
            const pronoun = preview.duplicatesFound === 1 ? 'it' : 'them';
            ctx.ui.notify(
              `Mem0 dedup preview: scanned ${preview.total} memories and found ${preview.duplicatesFound} exact ${noun}. Run /mem0 dedup --apply to remove ${pronoun}.`,
              'info',
            );
            break;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify('Mem0 dedup --apply requires an interactive confirmation.', 'warning');
            break;
          }
          let preview: Awaited<ReturnType<typeof dedupProviderMemories>> | undefined;
          let approved = false;
          const result = await dedupProviderMemories(provider, {
            ...scope,
            dryRun: false,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            approve: async (candidate) => {
              preview = candidate;
              if (candidate.duplicatesFound === 0) return false;
              const noun = candidate.duplicatesFound === 1 ? 'duplicate' : 'duplicates';
              approved = await ctx.ui.confirm(
                'Remove exact duplicate memories?',
                `${candidate.duplicatesFound} ${noun} will be permanently deleted.`,
              );
              return approved;
            },
          });
          if (preview?.duplicatesFound === 0) {
            ctx.ui.notify('Mem0 dedup complete: no exact duplicates found.', 'info');
            break;
          }
          if (!approved) {
            ctx.ui.notify('Mem0 dedup cancelled.', 'info');
            break;
          }
          const removedNoun = result.duplicatesRemoved === 1 ? 'duplicate' : 'duplicates';
          ctx.ui.notify(
            `Mem0 dedup complete: removed ${result.duplicatesRemoved} ${removedNoun}; ${result.deleteFailures} deletions failed.`,
            result.deleteFailures ? 'warning' : 'info',
          );
          break;
        }
        case 'delete': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 delete <memory-id>', 'warning');
            break;
          }
          await provider.delete(rest, ctx.signal ? { signal: ctx.signal } : {});
          ctx.ui.notify(`Deleted memory ${rest}.`, 'info');
          break;
        }
        default:
          ctx.ui.notify(
            'Unknown subcommand. Available: status, search, profile, add, dedup, delete.',
            'warning',
          );
      }
    },
  });
}

function extractText(msg: { content?: unknown }): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }
  return '';
}
