# @amaster.ai/pi-memory-mem0

![pi-memory-mem0 preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-memory-mem0/preview.png)

Semantic memory extension powered by [Mem0](https://mem0.ai), with Platform, embedded, and self-hosted backends and three memory modes (hybrid, active, passive).

## How It Works

**Passive side**: after each conversation turn, the user + assistant messages are automatically sent to Mem0 for fact extraction and storage. When you send a prompt, a semantic search is prefetched in the background and relevant memories are recalled before the agent starts — **zero effort required**.

**Active side**: the agent gets a `mem0_memory` tool (`search` / `add` / `get_all` / `delete`) so it can look up and manage memories on its own initiative — same idea as the official `@mem0/pi-agent-plugin`, but backed by this package's provider abstraction, so it works with Platform, embedded, **and** self-hosted Mem0.

Safety boundaries:

- **Recall channel**: recalled memories are injected as a custom message delivered on the user channel — never into the system prompt. Each entry is wrapped as `[UNTRUSTED MEMORY DATA]` (JSON-quoted), and entries matching prompt-injection patterns are replaced with `[BLOCKED UNTRUSTED MEMORY: ...]`.
- **Project namespacing**: memories are scoped to `userId:project:<cwd-hash>` by default, so one project's memories are not visible in another. Set `userIdScope: "exact"` when one identity must be shared across projects.
- **Credential redaction**: private keys, bearer tokens, and `api_key=…`-style values are redacted before anything is stored.
- **Platform mode disclosure**: in `platform` mode the captured turns leave your machine and are processed by Mem0 Cloud. Use `embedded` or `self-hosted` mode to keep memory traffic off third-party infrastructure.

## Modes

### Backend Modes

| Mode | Vector Store | Persistence | Dependencies | Use Case |
|------|-------------|-------------|--------------|----------|
| `platform` | Mem0 Cloud | Cloud-managed | `MEM0_API_KEY` | Quick start, multi-device sync |
| `embedded` | Mem0 OSS vector store | Vector-store managed | LLM + Embedding API | Data privacy, no Mem0 Cloud |
| `self-hosted` | Mem0 OSS REST server | Server-managed | Server URL, optional API key | Shared infrastructure |

### Memory Modes

| `memoryMode` | Auto capture + recall | `mem0_memory` tool | Use Case |
|--------------|----------------------|--------------------|----------|
| `hybrid` (default) | ✅ | ✅ | Best recall: automatic context plus agent-driven lookup |
| `active` | ❌ | ✅ | No background traffic; the agent decides every read/write |
| `passive` | ✅ | ❌ | Zero tool surface; fully automatic memory |

```json
{
  "pi-memory-mem0": {
    "mode": "embedded",
    "memoryMode": "hybrid"
  }
}
```

## Architecture (Embedded Mode)

```
User ←→ Agent ←→ Mem0 OSS Memory
                        ↕
            Mem0 OSS Vector Store (source of truth)
```

- **Vector search**: `mem0ai` OSS `MemoryVectorStore`. Despite the provider name `memory`, it is backed by SQLite; `dbPath` selects an in-process SQLite database or a SQLite file.
- **LLM extraction**: Configured provider extracts facts from conversations
- **Persistence**: The default `dbPath` is `<home>/memories/mem0-vectors.db`, so Mem0 writes vectors and payloads directly to a durable SQLite file. No second snapshot is maintained.
- **Provider mapping**: Custom providers are automatically mapped to mem0-compatible providers (e.g. `openai`) via the pi model registry's `api` field.
- **Observation date**: `add()` accepts an optional `observedAt` (Date or string). In OSS mode it grounds mem0's extraction prompt so relative time references ("yesterday", "last week") resolve against the conversation's date rather than the system clock — important when ingesting historical conversations. Omit it and mem0 falls back to the current date (correct for live turns).

## Quick Start

Store configuration in user/agent settings or in a trusted project's `.pi/settings.json`. Project settings are ignored when trust is declined and do not expand `${ENV_VAR}`; the environment-backed examples below therefore belong in user or agent settings.

### Platform Mode

```json
{
  "pi-memory-mem0": {
    "mode": "platform",
    "apiKey": "${MEM0_API_KEY}",
    "userId": "${USER}"
  }
}
```

### Embedded Mode (Recommended)

Reuses API keys and base URLs from pi's configured model providers — **no extra environment variables needed**.

```json
{
  "pi-memory-mem0": {
    "mode": "embedded",
    "userId": "${USER}"
  }
}
```

Defaults to OpenAI `text-embedding-3-small` (embedding) + `gpt-4.1-nano` (extraction). API keys and base URLs are automatically resolved from pi's model registry.

Existing settings with `mode: "open-source"` continue to load as `embedded`, but `open-source` is not part of the supported configuration interface. New settings should use `embedded`.

### Self-Hosted Mode

Calls the OSS REST server directly. The server uses `/memories` and `/search`, not the Mem0 Platform `/v1` paths.

```json
{
  "pi-memory-mem0": {
    "mode": "self-hosted",
    "baseUrl": "${MEM0_BASE_URL}",
    "apiKey": "${MEM0_API_KEY}",
    "userId": "${PAPERCLIP_COMPANY_ID}",
    "userIdScope": "exact"
  }
}
```

### Custom Provider

When your model registry defines a custom provider with `api: "openai-completions"`, you can use it directly:

```json
{
  "pi-memory-mem0": {
    "mode": "embedded",
    "oss": {
      "llm": {
        "provider": "my-provider",
        "config": { "model": "deepseek-v4-pro" }
      },
      "embedder": {
        "provider": "my-provider",
        "config": { "model": "text-embedding-v4" }
      }
    }
  }
}
```

The extension automatically:
1. Resolves API key from the model registry
2. Injects `baseUrl` from the registry
3. Maps `api: "openai-completions"` → mem0 provider `"openai"`

### Fully Local (Ollama)

```json
{
  "pi-memory-mem0": {
    "mode": "embedded",
    "userId": "${USER}",
    "oss": {
      "llm": {
        "provider": "ollama",
        "config": { "model": "llama3", "url": "http://localhost:11434" }
      },
      "embedder": {
        "provider": "ollama",
        "config": { "model": "nomic-embed-text", "url": "http://localhost:11434" }
      }
    },
    "useRegistryKeys": false
  }
}
```

### External Vector Store (e.g. Qdrant)

For production workloads that need a dedicated vector database:

```json
{
  "pi-memory-mem0": {
    "mode": "embedded",
    "oss": {
      "vectorStore": {
        "provider": "qdrant",
        "config": { "url": "http://localhost:6333" }
      }
    }
  }
}
```

Supported vector store providers: `memory` (default), `qdrant`, `redis`, `pgvector`, `supabase`.

The configured vector store always owns persistence. To request an intentionally ephemeral SQLite database, set the `memory` provider's `config.dbPath` to `":memory:"`; no snapshot fallback is created.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"platform"` \| `"embedded"` \| `"self-hosted"` | `"platform"` | Operating mode |
| `memoryMode` | `"hybrid"` \| `"active"` \| `"passive"` | `"hybrid"` | Memory behavior: tool + automation, tool only, or automation only |
| `apiKey` | string | — | Platform or self-hosted API key. Supports `${MEM0_API_KEY}` |
| `baseUrl` | string | `https://api.mem0.ai` | Platform override; required for self-hosted mode |
| `requestTimeoutMs` | number | `30000` | Self-hosted request timeout |
| `userId` | string | `$USER` or `"default-user"` | Memory scoping identifier |
| `userIdScope` | `"project"` \| `"exact"` | `"project"` | Append the cwd hash or use `userId` verbatim |
| `topK` | number | `5` | Max recalled memories per turn |
| `useRegistryKeys` | boolean | `true` | Whether OSS mode resolves keys from pi registry |
| `oss.llm` | object | OpenAI gpt-4.1-nano | OSS extraction model |
| `oss.embedder` | object | OpenAI text-embedding-3-small | OSS embedding model |
| `oss.vectorStore` | object | `memory` at `<home>/memories/mem0-vectors.db` | Custom vector store config |
| `oss.historyStore` | object | SQLite at `<home>/memories/mem0-history.db` | Custom mem0 history store config |
| `oss.historyDbPath` | string | `<home>/memories/mem0-history.db` | Shortcut for SQLite history DB path |
| `oss.disableHistory` | boolean | `false` | Disable mem0 operation history |

## Data Storage

| Mode | Vector Data | History |
|------|-------------|---------|
| Platform | Mem0 Cloud | Cloud-managed |
| Embedded (default paths) | `<home>/memories/mem0-vectors.db` | `<home>/memories/mem0-history.db` |
| Embedded (`memory`, `dbPath: ":memory:"`) | Process-local SQLite; lost on restart | `<home>/memories/mem0-history.db` |
| Embedded (Qdrant) | Qdrant server | `<home>/memories/mem0-history.db` |
| Self-hosted | Remote server | Remote server |

The `home` directory is resolved via `resolveHome()` from `@amaster.ai/pi-shared/settings` (defaults to `~/.pi/agent`).

## Provider Mapping

When a provider name doesn't match mem0's built-in list, the extension uses the model registry's `api` field to map it:

| Registry `api` field | Mapped to mem0 provider |
|---------------------|------------------------|
| `openai-completions`, `openai-responses` | `openai` |
| `anthropic-messages` | `anthropic` |
| `azure-*` | `azure_openai` |
| `google-*`, `gemini-*` | `gemini` |

This happens transparently — just configure the provider name as it appears in your `models.json`.

## Installation Notes

The default Embedded configuration depends on `better-sqlite3` (native addon, transitive dependency of `mem0ai`) for both the vector store and history. This remains true for `dbPath: ":memory:"`: it changes where SQLite stores pages, not which vector-store implementation is used.

**For pi-agent users**: pi-agent's `package.json` includes `better-sqlite3` in `pnpm.onlyBuiltDependencies` — it compiles automatically during `pnpm install`. No extra steps needed.

**For standalone users**: If your project's pnpm config blocks build scripts, add to your root `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

If `better-sqlite3` fails to load (for example, because of a Node ABI mismatch), the default `memory` vector store cannot start. An external vector store can still be used with history disabled or configured to a working provider.

## Tools

When `memoryMode` is `hybrid` or `active`, the agent gets one action-dispatched tool:

```
mem0_memory(action="search", query="...")        # Semantic search over memories
mem0_memory(action="add", content="...")         # Store a durable fact
mem0_memory(action="get_all")                    # List every stored memory
mem0_memory(action="delete", memory_id="...")    # Remove a memory by id
```

Stored content is credential-redacted first; results are returned with the same `[UNTRUSTED MEMORY DATA]` wrapping as passive recall, including the memory ids needed for `delete`.

## Commands

```
/mem0 status          # Show current status
/mem0 search <query>  # Semantic search
/mem0 profile         # List all memories
/mem0 add <text>      # Store a memory manually
/mem0 delete <id>     # Remove a memory by id
```

## Relationship with pi-memory

`pi-memory-mem0` and `pi-memory` run **independently in parallel** as separate extensions:

- `pi-memory`: Curated memory — the agent explicitly manages memories via the `memory_add` / `memory_replace` / `memory_remove` / `memory_read` tools, local `.md` files, hard char limits
- `pi-memory-mem0`: Semantic memory — automatic extraction/storage and semantic recall (passive), plus the `mem0_memory` tool for agent-driven semantic lookup (active); no capacity limits

They do not interfere with each other, and their tool names do not collide. `pi-memory-mem0` injects recalled text as a custom user-channel message (never the system prompt); `pi-memory` injects its own context separately.

## Dedup API

The package exports a standalone deduplication function used by pi-memory's dreaming job:

```ts
import { dedupMemories } from "@amaster.ai/pi-memory-mem0/dedup";

const result = await dedupMemories({
  userId: "my-user",
  config: { mode: "platform", apiKey: "..." },
});
// result: { total: 42, duplicatesRemoved: 3 }
```

Normalizes entries (case-insensitive, whitespace-collapsed), identifies exact duplicates, and deletes the older ones through the configured provider. In OSS mode those deletes go directly to the vector store.
