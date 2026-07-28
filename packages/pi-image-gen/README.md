# @amaster.ai/pi-image-gen

![pi-image-gen preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-image-gen/preview.png)

Pi extension that adds an `image_generate` tool. Supported providers:

| Provider                       | Model id (alias)                              | Env var               |
| ------------------------------ | --------------------------------------------- | --------------------- |
| OpenAI                         | `gpt-image-2`                                 | `OPENAI_API_KEY`      |
| Google Gemini ("Nano Banana")  | `gemini-3-pro-image` (alias `nano-banana-pro`), `gemini-3.1-flash-image` (alias `nano-banana-2`), `gemini-3.1-flash-lite-image` (alias `nano-banana-2-lite`), `gemini-2.5-flash-image` (alias `nano-banana`) | `GEMINI_API_KEY` |
| Alibaba DashScope (Qwen-Image) | `qwen-image-2.0-pro`, `qwen-image-2.0`          | `DASHSCOPE_API_KEY`   |
| Volcengine Ark (ByteDance Seedream) | `doubao-seedream-5-0-pro-260128` (alias `seedream-5-pro`), `doubao-seedream-5-0-260128` (alias `seedream-5`, `seedream`), `doubao-seedream-5-0-lite-260128` (alias `seedream-5-lite`), `doubao-seedream-4-5-251128` (alias `seedream-4-5`), `doubao-seedream-4-0-250828` (alias `seedream-4`) | `ARK_API_KEY`         |
| OpenRouter                     | any (use `openrouter/<vendor>/<id>`)          | `OPENROUTER_API_KEY`  |
| Custom providers               | whatever you declare in settings              | (your choice, via `$VAR`) |

Upstream API docs (handy when debugging gateway behavior or adding new models):

- OpenAI gpt-image-2 — [developers.openai.com/api/docs/models/gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2)
- Google Gemini image generation — [ai.google.dev/gemini-api/docs/image-generation](https://ai.google.dev/gemini-api/docs/image-generation)
- Alibaba DashScope Qwen-Image (text-to-image) — [help.aliyun.com/zh/model-studio/text-to-image](https://help.aliyun.com/zh/model-studio/text-to-image)
- Alibaba DashScope Qwen-Image-Edit — [help.aliyun.com/zh/model-studio/qwen-image-edit-guide](https://help.aliyun.com/zh/model-studio/qwen-image-edit-guide)
- Volcengine Ark Seedream — [volcengine.com/docs/82379/1824121](https://www.volcengine.com/docs/82379/1824121)
- OpenRouter image API — [openrouter.ai/docs/api/api-reference/images/create-images](https://openrouter.ai/docs/api/api-reference/images/create-images)

The env-var names match [pi.dev's provider table](https://pi.dev/docs/latest/providers) — if the agent already has a key set for a provider, this extension will reuse it. You don't need to introduce a new variable.

The active model is **fixed in settings.json**. The `image_generate` tool intentionally does **not** take a `model` parameter — point your project at one model, get consistent output. To switch models, edit settings and run `/image-gen reload`.

## Install

```sh
pnpm add @amaster.ai/pi-image-gen
```

The package's `pi.extensions` field auto-registers it with the host pi-coding-agent runtime; no extra wiring needed.

## Configure

Settings are read by `pi-shared`'s `loadPiSettings`, which merges three files (low-to-high priority):

1. `~/.pi/agent/settings.json` (global)
2. `$PI_AGENT_HOME/settings.json` (agent dir, if `PI_AGENT_HOME` is set)
3. `<cwd>/.pi/settings.json` (trusted project)

Project settings are ignored when project trust is declined. `${ENV_VAR}`
interpolation is supported in global and agent settings only, so keep
environment-backed credentials out of project settings.

All settings live under the `pi-image-gen` key. The minimum viable config sets `defaultModel`:

```json
{
  "pi-image-gen": {
    "defaultModel": "nano-banana"
  }
}
```

…and exports the matching env var:

```sh
export GEMINI_API_KEY=sk-...
```

That's it. From the agent: `image_generate({ prompt: "a cyberpunk cat" })`.

### All settings fields

```json
{
  "pi-image-gen": {
    "defaultModel": "nano-banana",
    "outputDir": ".pi/images",

    "providers": {
      "openai":     { "baseUrl": "https://my-proxy.example.com/v1", "apiKey": "${MY_OPENAI_KEY}" },
      "gemini":     { "headers": { "x-goog-trace": "pi-prod" } },
      "dashscope":  { "baseUrl": "https://dashscope-intl.aliyuncs.com/api/v1" },
      "ark":        { "apiKey": "$ARK_API_KEY" },
      "openrouter": { "apiKey": "$OPENROUTER_API_KEY" }
    },

    "customProviders": {
      "my-stable-diffusion": {
        "api": "openai",
        "baseUrl": "https://api.my-sd.example.com/v1",
        "apiKey": "${MY_SD_KEY}",
        "headers": { "x-tenant": "team-a" },
        "models": [
          { "id": "sd-3-large", "alias": "sd3" },
          "sd-3-medium"
        ]
      }
    }
  }
}
```

| Field             | Purpose                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `defaultModel`    | Model id or alias the tool will use. **Required.**                                       |
| `outputDir`       | Where to write generated images. Relative paths resolve against the session cwd. Default `.pi/images`. |
| `providers`       | Per-built-in-provider override. Set `apiKey`, `baseUrl`, `headers`, or `runtimeAuthProvider`. |
| `customProviders` | User-defined providers — see below.                                                      |

In global and agent settings, `apiKey`, `baseUrl`, and `headers` values support
`$VAR` and `${VAR}` environment interpolation. Fallbacks require the braced
form (for example, `${FOO:-default}`); `$FOO:-default` is not supported.
Project settings keep all of these placeholders literal.

Set `runtimeAuthProvider` on a built-in or custom provider to resolve its API
key, base URL, and auth headers from `ctx.modelRegistry` in the current Pi
session. Runtime auth is kept in memory, replaces static authentication fields,
and fails closed when unavailable; resolved credentials are never written back
to settings.

## Built-in setup walkthrough

### 1. OpenAI (`gpt-image-2`)

```sh
export OPENAI_API_KEY=sk-...
```

```json
{ "pi-image-gen": { "defaultModel": "gpt-image-2" } }
```

### 2. Google Gemini "Nano Banana"

```sh
export GEMINI_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "nano-banana" } }
```

### 3. Alibaba DashScope (Qwen-Image)

```sh
export DASHSCOPE_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "qwen-image-2.0" } }
```

For the international DashScope endpoint, override the base URL:

```json
{
  "pi-image-gen": {
    "defaultModel": "qwen-image-2.0",
    "providers": {
      "dashscope": { "baseUrl": "https://dashscope-intl.aliyuncs.com/api/v1" }
    }
  }
}
```

### 4. Volcengine Ark (ByteDance Seedream)

```sh
export ARK_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "seedream" } }
```

> Supported `size` values are model-dependent. Seedream 5.0 / 5.0 lite / 4.5 require 2K or larger (e.g. `2048x2048`, `1728x2304`, `2848x1600`) — `1024x1024` will fail with `InvalidParameter`. Seedream 4.0 is the only one that accepts 1K sizes. Full sizing matrix in the [official docs](https://www.volcengine.com/docs/82379/1824121). Other built-in providers default to `1024x1024`, so this is the one knob to remember when switching to Seedream ≥ 4.5.

The default base URL is `https://ark.cn-beijing.volces.com/api/v3`. To use a different region (e.g. `ap-southeast`), override it:

```json
{
  "pi-image-gen": {
    "defaultModel": "seedream",
    "providers": {
      "ark": { "baseUrl": "https://ark.ap-southeast.bytepluses.com/api/v3" }
    }
  }
}
```

### 5. OpenRouter (one key, many models)

```sh
export OPENROUTER_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "openrouter/bytedance-seed/seedream-4.5" } }
```

The string after `openrouter/` is the OpenRouter model slug; pass any image model OpenRouter supports (`google/gemini-3.1-flash-image`, `openai/gpt-image-2`, `bytedance-seed/seedream-4.5`, …).

OpenRouter's image API is **not** OpenAI-compatible despite the family name — it lives at `POST /api/v1/images` (no `/generations` suffix) and uses JSON `input_references` for image-to-image. The extension targets the right endpoint automatically; no wire-shape config needed.

## Custom providers

Use `customProviders` for anything not built in: a self-hosted Stable Diffusion, an internal corp gateway, a third-party image API. The shape mirrors [pi.dev's custom-provider docs](https://pi.dev/docs/latest/custom-provider).

Each custom provider declares:

| Field      | Required | Notes                                                                                |
| ---------- | -------- | ------------------------------------------------------------------------------------ |
| `api` | yes      | One of `openai`, `gemini`, `dashscope`, `openrouter`, `ark`. Picks the image-API wire shape. |
| `baseUrl`  | yes, unless runtime auth | API endpoint URL. `$VAR` syntax supported.                              |
| `apiKey`   | usually, unless runtime auth | API key string. `$VAR` syntax supported.                          |
| `name`     | no       | Display name shown in `/image-gen list`.                                             |
| `headers`  | no       | Extra headers merged into every request.                                             |
| `runtimeAuthProvider` | no | Pi model-registry provider used for session-scoped API credentials and endpoint. |
| `models`   | no       | Optional model id/alias list. Omit to make this a **catch-all** — the provider will accept any unknown model id (passed through as the remote id). Provide a list only when you want aliases or want to route specific ids elsewhere. Each entry is a string or `{ id, alias?, name? }`. |

> Note: pi.dev custom providers also have an `api` field, but its values (`openai-completions`, `anthropic-messages`, …) are LLM streaming formats that don't apply to image generation. The values here (`openai`, `gemini`, `dashscope`, `openrouter`, `ark`) are image-API wire shapes — same field name, different namespace.

### Example: self-hosted Stable Diffusion (OpenAI-compatible)

```sh
export SD_KEY=local-secret
```

```json
{
  "pi-image-gen": {
    "defaultModel": "sd3",
    "customProviders": {
      "my-sd": {
        "api": "openai",
        "baseUrl": "http://localhost:8000/v1",
        "apiKey": "$SD_KEY",
        "models": [{ "id": "sd-3-large", "alias": "sd3" }]
      }
    }
  }
}
```

The agent calls `image_generate({prompt: ...})`; the extension sees `defaultModel: "sd3"`, finds it under `my-sd`, and POSTs to `http://localhost:8000/v1/images/generations` with `Bearer $SD_KEY`.

### Example: Volcengine Doubao image API (OpenAI-compatible)

```json
{
  "pi-image-gen": {
    "defaultModel": "doubao-seed-image",
    "customProviders": {
      "doubao": {
        "api": "openai",
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKey": "${ARK_API_KEY}",
        "models": [{ "id": "doubao-seedream-4-0-250828", "alias": "doubao-seed-image" }]
      }
    }
  }
}
```

### Example: a Gemini-shape proxy

If your provider speaks the Google Generative Language wire format:

```json
{
  "pi-image-gen": {
    "defaultModel": "internal-banana",
    "customProviders": {
      "internal": {
        "api": "gemini",
        "baseUrl": "https://gemini-proxy.corp.example/v1beta",
        "apiKey": "$INTERNAL_GEMINI_KEY",
        "models": [{ "id": "gemini-2.5-flash-image", "alias": "internal-banana" }]
      }
    }
  }
}
```

### Direct addressing without an alias

If a custom provider has no `models` list, you can still address it with `<providerName>/<remoteId>`:

```json
{
  "pi-image-gen": {
    "defaultModel": "my-sd/sd-3-large",
    "customProviders": {
      "my-sd": { "api": "openai", "baseUrl": "http://localhost:8000/v1", "apiKey": "$SD_KEY" }
    }
  }
}
```

## Tool: `image_generate`

```ts
image_generate({
  prompt: string,                  // required — what to draw or how to edit
  image?: string[],                // optional — array of file paths or http(s) URLs
  n?: number,                      // 1–8, default 1 (variants of ONE prompt)
  size?: string,                   // e.g. "1024x1024" — provider-specific
  quality?: 'low'|'medium'|'high'|'auto', // present only for a built-in gpt-image route (see below)
  filename?: string,               // filename prefix (no extension)
  outputDir?: string,              // override settings.outputDir for this call
})
```

Returns the absolute file path(s) of saved images. Files land in `outputDir` (default `<cwd>/.pi/images`), filename pattern `<filename or model-UTC-stamp>.<ext>`.

**The schema is provider-aware.** The tool is registered once settings are loaded (on session start, and again after `/image-gen reload`), so its parameters are shaped for the active model:

- `quality` appears **only** for a **built-in gpt-image** route — the built-in OpenAI provider on `gpt-image-*`, or an OpenRouter route whose model id is gpt-image (e.g. `openrouter/openai/gpt-image-2`). Only there is it constrained to the enum `low`/`medium`/`high`/`auto` (the vocabulary those APIs document). It is **omitted from the schema entirely** for:
  - Gemini, DashScope/Qwen, and Ark/Seedream — their image APIs have no `quality` field (Seedream varies quality by `size` resolution tier instead);
  - **non-gpt-image routes** on the OpenAI/OpenRouter wire — e.g. built-in `openai/dall-e-3` (which uses `standard`/`hd`) or an OpenRouter route to a non-OpenAI model like Seedream — because the enum above is gpt-image's vocabulary, not the wire format's; and
  - **any custom provider**, including OpenAI-*compatible* ones — a self-hosted or third-party model may use a different quality vocabulary (e.g. DALL·E 3's `standard`/`hd`) or none at all, so the OpenAI wire format alone does **not** imply the four values above. Passing an unsupported value would only surface as a provider-side 400.

  If `defaultModel` is unset or misconfigured, `quality` stays present (the tool remains fully featured and `execute` surfaces a friendly config error). Use `"low"` for fast drafts and a higher level for final assets or dense text.
- `size`'s description is tailored per provider — for Ark/Seedream it spells out the 2K-minimum requirement instead of the generic `1024x1024` hint.

Because the schema is fixed at registration, switching models via `/image-gen reload` re-registers the tool so the parameter set tracks the new provider.

**Non-destructive writes:** a saved file never overwrites an existing one. Two calls with `filename: "hero"` produce `hero.png` then `hero-v2.png`, so an earlier result is preserved rather than clobbered. Path reservation is atomic (`O_EXCL`): even many concurrent calls with the same `filename` each claim a distinct path — no two clobber each other.

### Tool result format

The tool's text result is shaped as ready-to-paste markdown the model can copy verbatim into its reply, so the UI renders the image inline:

```
Generated 1 image(s) via amaster (custom) (qwen-image-2.0). Show each one to the user as inline markdown — copy the lines below verbatim into your reply:

![white](/Users/.../white.png)
```

The `alt` text is the filename without its extension — i.e. whatever you passed as `filename`, or `<model>-<UTC-stamp>` if you didn't. When OpenAI returns a `revised_prompt`, it appears as a quote line under the image:

```
![beaver](/Users/.../beaver.png)
> revised prompt: a cute beaver, photorealistic, water droplets
```

### Image-to-image / edit

`image` is always an array — pass `["path"]` for a single image, `["a", "b"]` for multi-image conditioning. Each entry must be:

- **Local file path** — absolute or relative (resolved against the session cwd).
- **http(s) URL** — downloaded with the same fetch (and abort signal) used for the API call.

Base64 strings and `data:` URIs are intentionally rejected — tool arguments don't survive megabyte-sized strings cleanly. If you have raw image bytes, write them to a file first and pass the path.

**Iterating on a previous result:** pass the previous output path back. The next image is conditioned on the last one:

```
image_generate({ prompt: "a beaver chewing wood", filename: "beaver" })
  → /Users/.../.pi/images/beaver.png

image_generate({ prompt: "now in watercolor style", image: ["/Users/.../.pi/images/beaver.png"] })
  → /Users/.../.pi/images/gpt-image-2-20260605-...png  (edited)
```

Provider behavior:

| Provider | Image input route |
|---|---|
| OpenAI (`gpt-image-2`) | `POST /v1/images/edits` (multipart). Supports multi-image. |
| Gemini (`gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`) | `inline_data` parts prepended to the user message. Supports multi-image. |
| DashScope (`qwen-image-2.0`, `qwen-image-2.0-pro`) | `image` parts in `messages[].content`. |
| OpenRouter | `POST /api/v1/images` with `input_references` JSON. Supports multi-image. |

There is intentionally no `model` parameter on the tool — the active model is fixed by `pi-image-gen.defaultModel` in settings.

## Slash commands

- `/image-gen list` — show the active model, which provider it routes to, whether the key is set, configured providers, and the catalog of built-in model ids.
- `/image-gen reload` — re-read settings from disk and re-register the tool so its schema (e.g. whether `quality` is exposed) tracks the newly selected model.
- `/image-gen generate <prompt>` — generate an image directly from the command line using the active model. Reports the saved file path(s) as a plain-text notification (the command uses `ctx.ui.notify`, which shows a status line, not rendered Markdown — so unlike the tool result it does not emit an inline `![](…)` image). Use the `image_generate` tool from the agent when you want the image rendered inline.

Use `/image-gen list` to verify your config — it will tell you when `defaultModel` is unset, points at a provider with no API key, or names an unknown id.

## Bundled skill

This package ships an `image-gen` skill (`skills/image-gen/SKILL.md`) that Pi loads on demand. It carries the prompting playbook the one-line tool guidance can't hold: when to use raster generation vs repo-native SVG/CSS, generate-vs-edit intent, `n`-is-variants-not-assets, multi-image role labeling, edit invariants, text-in-image handling, and the labeled prompt schema. The tool works without it; the skill makes the model use the tool well.
