# pi-web-access

![pi-web-access preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-web-access/preview.png)

Pi extension for web search and URL content extraction.

## Tools

### `web_search`

Search the web for information. Only registered when a search provider is configured with an API key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | The search query |
| `maxResults` | number | no | Max results to return (default 5) |
| `topic` | `"general"` \| `"news"` | no | Topic category |
| `timeRange` | `"day"` \| `"week"` \| `"month"` \| `"year"` | no | Recency filter |
| `includeDomains` | string[] | no | Only include results from these domains |
| `excludeDomains` | string[] | no | Exclude results from these domains |

### `web_fetch`

Fetch a URL and process its content with a prompt. Only registered when `fetch.provider` or `fetch.summary` is configured.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | The URL to fetch |
| `prompt` | string | yes | What information to extract or summarize |

### `x_search`

Search X (Twitter) for posts and social media content. Only registered when xai provider has an API key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | The search query on X |
| `allowedHandles` | string[] | no | Only include posts from these handles (max 20) |
| `excludedHandles` | string[] | no | Exclude posts from these handles (max 20) |
| `fromDate` | string | no | Start date (YYYY-MM-DD) |
| `toDate` | string | no | End date (YYYY-MM-DD) |

## Providers

| Provider | Search | Fetch | X Search | Default Base URL | Env Var | Default Model |
|----------|:------:|:-----:|:--------:|------------------|---------|---------------|
| `tavily` | ✓ | ✓ | ✗ | `https://api.tavily.com` | `TAVILY_API_KEY` | - |
| `brave` | ✓ | ✗ | ✗ | `https://api.search.brave.com` | `BRAVE_API_KEY` | - |
| `firecrawl` | ✓ | ✓ | ✗ | `https://api.firecrawl.dev` | `FIRECRAWL_API_KEY` | - |
| `kimi` | ✓ | ✗ | ✗ | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `kimi-k2.6` |
| `mimo` | ✓ | ✗ | ✗ | `https://api.xiaomimimo.com/v1` | `MIMO_API_KEY` | `mimo-v2.5-pro` |
| `zai` | ✓ | ✓ | ✗ | `https://api.z.ai` | `ZAI_API_KEY` | - |
| `gemini` | ✓ | ✗ | ✗ | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `perplexity` | ✓ | ✓ | ✗ | `https://api.perplexity.ai` | `PERPLEXITY_API_KEY` | `openai/gpt-5.5` |
| `openrouter` | ✓ | ✓ | ✗ | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `openai/gpt-4.1-mini` |
| `xai` | ✓ | ✗ | ✓ | `https://api.x.ai/v1` | `XAI_API_KEY` | `grok-4.3` |
| `openai` | ✓ | ✗ | ✗ | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-5.5` |
| `anthropic` | ✓ | ✓ | ✗ | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |

**Fetch fallback** (when `fetch.provider` is not set): Jina Reader (`r.jina.ai`, free, JS-rendered) → local HTTP GET + turndown.

## Configuration

Settings key: `pi-web-access`

Project `.pi/settings.json` values are loaded only after project trust is
accepted and are not environment-interpolated. User and agent settings retain
environment interpolation.

```json
{
  "pi-web-access": {
    "search": {
      "provider": "kimi"
    },
    "fetch": {
      "provider": "zai",
      "summary": {
        "provider": "amaster",
        "model": "deepseek-v4-flash"
      }
    },
    "providers": {
      "kimi": {
        "apiKey": "AMASTER_API_KEY",
        "baseUrl": "https://credits.amaster.ai/v1"
      },
      "zai": {
        "apiKey": "${ZAI_API_KEY}"
      },
      "xai": {
        "apiKey": "${XAI_API_KEY}"
      }
    }
  }
}
```

### `search`

| Field | Description |
|-------|-------------|
| `provider` | Which provider to use for web search. Not set = auto-select first provider with key. No key at all = tool not registered. |

### `fetch`

| Field | Description |
|-------|-------------|
| `provider` | Which provider to use for URL fetching. Not set = Jina Reader → local fallback. |
| `summary` | Model config for summarizing fetched content. |
| `summary.provider` | Model provider name (resolved via pi model registry). |
| `summary.model` | Model id. |

If neither `fetch.provider` nor `fetch.summary` is configured, `web_fetch` is not registered.

### `providers`

Per-provider configuration. Each provider supports:

| Field | Description |
|-------|-------------|
| `apiKey` | API key. User and agent settings support `$ENV_VAR` and `${ENV_VAR}`; only the braced form supports `:-fallback`. Project settings keep placeholders literal. |
| `baseUrl` | Override the default API endpoint. |
| `model` | Override the default model. |
| `headers` | Extra headers merged into every request. |
| `runtimeAuthProvider` | Resolve the API key, base URL, and auth headers from this provider in the current Pi session. Runtime auth replaces static auth and fails closed when unavailable. |

Environment variables serve as fallbacks when `apiKey` is not set in config.
When `runtimeAuthProvider` is set, the extension resolves auth from
`ctx.modelRegistry` for that session instead; it does not write the resolved
credential back to settings or fall back to a configured static key.

## Architecture

Each provider implements the `WebProvider` interface via `BaseProvider`:

```typescript
// providers/base.ts
export interface WebProvider {
  readonly id: BuiltInProviderId;
  search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse>;
  fetch(url: string, provider: ResolvedProvider): Promise<FetchResponse>;
}

export abstract class BaseProvider implements WebProvider {
  abstract readonly id: BuiltInProviderId;
  // Default implementations throw "not supported"
  async search(...) { throw new Error(`${this.id} does not support web_search.`); }
  async fetch(...) { throw new Error(`${this.id} does not support web_fetch.`); }
}
```

Providers only override methods they support. Provider-specific capabilities (like `XaiProvider.xsearch`) are exposed as additional methods on the class.

## Tool Registration Rules

- `web_search` — registered when a search provider has an API key.
- `web_fetch` — registered when `fetch.provider` or `fetch.summary` is configured.
- `x_search` — registered when xai provider has an API key.
- If none are configured, the extension loads silently with no tools registered.

## Install

```bash
pi install npm:@amaster.ai/pi-web-access
```

## Development

```bash
pnpm build      # tsc -b
pnpm typecheck  # tsc -b --pretty false
pnpm test       # vitest run src
```
