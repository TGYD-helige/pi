/**
 * pi-memory-mem0 — Passive semantic memory extension powered by Mem0.
 *
 * Two modes:
 * - **platform**: Uses Mem0 Cloud API (needs MEM0_API_KEY)
 * - **open-source**: Runs locally with SQLite vector store (needs OPENAI_API_KEY or Ollama)
 *
 * Configuration via settings.json key "pi-memory-mem0".
 * Supports ${ENV_VAR:-fallback} in all string values.
 */

import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Prefetch } from './prefetch.js';
import { createMem0Provider, type Mem0Provider } from './provider.js';
import { createMem0Tools } from './tools.js';
import type { Mem0ExtensionConfig } from './types.js';

const SETTINGS_KEY = 'pi-memory-mem0';
const STATUS_KEY = 'mem0';

function loadConfig(cwd: string): Mem0ExtensionConfig {
  try {
    return loadPiSettings<Mem0ExtensionConfig>(SETTINGS_KEY, {
      cwd,
    });
  } catch {
    return {};
  }
}

function resolveUserId(configUserId?: string): string {
  if (configUserId?.trim()) return configUserId.trim();
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  return 'default-user';
}

function resolveAgentId(configAgentId?: string): string | undefined {
  if (configAgentId?.trim()) return configAgentId.trim();
  return undefined;
}

export default function mem0Extension(pi: ExtensionAPI): void {
  let provider: Mem0Provider | undefined;
  let prefetch: Prefetch | undefined;
  let userId = '';
  let agentId: string | undefined;
  let lastUserText = '';
  let syncing = false;

  pi.on('session_start', async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const mode = config.mode ?? 'platform';

    // Platform mode requires apiKey; OSS mode requires an LLM provider (env key)
    if (mode === 'platform' && !config.apiKey?.trim()) {
      ctx.ui.setStatus(STATUS_KEY, 'mem0: disabled (no API key)');
      return;
    }

    try {
      provider = await createMem0Provider({
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
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, 'mem0: init failed');
      ctx.ui.notify(
        `Mem0 init failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return;
    }

    userId = resolveUserId(config.userId);
    agentId = resolveAgentId(config.agentId);
    prefetch = new Prefetch(provider, userId, agentId, {
      topK: config.topK ?? 5,
    });

    ctx.ui.setStatus(STATUS_KEY, `mem0: ${mode}`);

    for (const tool of createMem0Tools(provider, userId, agentId)) {
      pi.registerTool(tool as never);
    }
  });

  pi.on('input', async (event) => {
    if (!prefetch) return;
    const text = (event as { text?: string }).text ?? '';
    if (text) {
      prefetch.queue(text);
      lastUserText = text;
    }
  });

  pi.on('turn_end', async (event) => {
    if (!provider || !lastUserText) return;

    const msg = event.message as { role?: string; content?: unknown };
    const text = extractText(msg);
    if (!text || msg.role !== 'assistant') return;

    if (!syncing) {
      syncing = true;
      const userText = lastUserText;
      lastUserText = '';
      provider
        .add(
          [
            { role: 'user', content: userText },
            { role: 'assistant', content: text },
          ],
          { userId, agentId },
        )
        .catch(() => {})
        .finally(() => {
          syncing = false;
        });
    }
  });

  pi.on('before_agent_start', async (event) => {
    if (!prefetch) return;

    const recalled = await prefetch.consume();
    if (!recalled) return;

    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${recalled}` : recalled,
    };
  });

  pi.on('session_shutdown', async () => {
    provider = undefined;
    prefetch = undefined;
    lastUserText = '';
    syncing = false;
  });

  pi.registerCommand('mem0', {
    description: 'Mem0 memory commands. Subcommands: status, search <query>, profile.',
    handler: async (args, ctx) => {
      if (!provider) {
        ctx.ui.notify('Mem0 is not active.', 'warning');
        return;
      }

      const config = loadConfig(ctx.cwd);
      const userId = resolveUserId(config.userId);
      const agentId = resolveAgentId(config.agentId);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();

      switch (subcommand) {
        case 'status': {
          ctx.ui.notify(`Mem0: active (mode: ${config.mode ?? 'platform'})`, 'info');
          break;
        }
        case 'search': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 search <query>', 'warning');
            break;
          }
          const results = await provider.search(rest, { userId, agentId, topK: 10 });
          if (results.length === 0) {
            ctx.ui.notify('No relevant memories found.', 'info');
          } else {
            const lines = results.map((r, i) => `${i + 1}. ${r.memory}`);
            ctx.ui.notify(`Mem0 search results:\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'profile': {
          const all = await provider.getAll({ userId, agentId });
          if (all.length === 0) {
            ctx.ui.notify('No memories stored yet.', 'info');
          } else {
            const lines = all.map((m, i) => `${i + 1}. ${m.memory}`);
            ctx.ui.notify(`Mem0 memories (${all.length}):\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        default:
          ctx.ui.notify('Unknown subcommand. Available: status, search, profile.', 'warning');
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
