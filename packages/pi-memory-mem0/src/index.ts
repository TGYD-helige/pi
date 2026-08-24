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

import { isProjectTrusted, loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { dedupProviderMemories } from './dedup.js';
import { Prefetch } from './prefetch.js';
import { formatRecalledMemory, redactMemoryText, scopeMemoryUserId } from './privacy.js';
import {
  createMem0Provider,
  type Mem0Provider,
  normalizeMem0Mode,
  normalizeMemoryMode,
} from './provider.js';
import { createMem0MemoryTool } from './tools.js';
import type { Mem0ExtensionConfig, MemoryUserIdScope } from './types.js';

const SETTINGS_KEY = 'pi-memory-mem0';
const STATUS_KEY = 'mem0';

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
  let prefetch: Prefetch | undefined;
  let userId = '';
  let agentId: string | undefined;
  let activeMode = '';
  let activeMemoryMode = '';
  let activeToolEnabled = false;
  let lastUserText = '';
  let pendingWrite: Promise<void> = Promise.resolve();
  let sessionEpoch = 0;

  pi.on('session_start', async (_event, ctx) => {
    // A newer session_start (or shutdown) can run while this handler is still
    // awaiting provider init (embedded init takes seconds). The epoch check
    // after the await keeps the superseded handler from clobbering the live
    // session's provider, prefetch, and tool-enablement state.
    const epoch = ++sessionEpoch;
    provider = undefined;
    prefetch = undefined;
    agentId = undefined;
    activeToolEnabled = false;
    const config = loadConfig(ctx.cwd, isProjectTrusted(ctx));
    try {
      const mode = normalizeMem0Mode(config.mode);
      const memoryMode = normalizeMemoryMode(config.memoryMode);
      if (mode === 'platform' && !config.apiKey?.trim()) {
        ctx.ui.setStatus(STATUS_KEY, 'mem0: disabled (no API key)');
        return;
      }
      const resolvedUserId = resolveUserId(config.userId, config.userIdScope);
      const resolvedAgentId = config.agentId?.trim() || undefined;
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
      if (memoryMode !== 'active') {
        prefetch = new Prefetch(provider, userId, {
          ...(agentId ? { agentId } : {}),
          topK: config.topK ?? 5,
        });
      }
      if (memoryMode !== 'passive') {
        activeToolEnabled = true;
        pi.registerTool(
          createMem0MemoryTool({
            getProvider: () => provider,
            getUserId: () => userId,
            getAgentId: () => agentId,
            isEnabled: () => activeToolEnabled,
            topK: config.topK ?? 5,
          }),
        );
      }
    } catch (err) {
      if (epoch !== sessionEpoch) return;
      provider = undefined;
      prefetch = undefined;
      activeToolEnabled = false;
      ctx.ui.setStatus(STATUS_KEY, 'mem0: init failed');
      ctx.ui.notify(
        `Mem0 init failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, `mem0: ${activeMode}/${activeMemoryMode}`);
  });

  pi.on('input', async (event) => {
    if (!prefetch) return;
    const text = event.text ?? '';
    if (text) {
      prefetch.queue(redactMemoryText(text));
      lastUserText = text;
    }
  });

  pi.on('turn_end', async (event) => {
    if (!provider || !prefetch || !lastUserText) return;

    const msg = event.message as { role?: string; content?: unknown };
    const text = extractText(msg);
    if (!text || msg.role !== 'assistant') return;

    const userText = lastUserText;
    lastUserText = '';
    const activeProvider = provider;
    const activeUserId = userId;
    const activeAgentId = agentId;
    pendingWrite = pendingWrite
      .catch(() => {})
      .then(async () => {
        const result = await activeProvider.add(
          [
            { role: 'user', content: redactMemoryText(userText) },
            { role: 'assistant', content: redactMemoryText(text) },
          ],
          {
            userId: activeUserId,
            ...(activeAgentId ? { agentId: activeAgentId } : {}),
          },
        );
        // Extraction legitimately finds nothing in many turns, but a totally
        // silent no-op makes a broken pipeline indistinguishable from a quiet
        // one — gate a diagnostic behind DEBUG.
        if (process.env.DEBUG?.includes('pi-memory-mem0') && !result?.results?.length) {
          console.error('[pi-memory-mem0] turn capture stored no memories (extraction empty?)');
        }
      })
      .catch((err) => {
        console.error(
          `[pi-memory-mem0] failed to store turn: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });

  pi.on('before_agent_start', async () => {
    if (!prefetch) return;

    const recalled = await prefetch.consume();
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
    await pendingWrite;
    provider = undefined;
    prefetch = undefined;
    agentId = undefined;
    activeToolEnabled = false;
    lastUserText = '';
    pendingWrite = Promise.resolve();
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
          ctx.ui.notify(`Mem0: active (mode: ${activeMode}/${activeMemoryMode})`, 'info');
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
          const created = result?.results ?? [];
          if (created.length === 0) {
            ctx.ui.notify('No memory was extracted from the provided text.', 'info');
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
