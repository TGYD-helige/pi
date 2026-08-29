# @amaster.ai/pi-image-gen

![pi-image-gen preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-image-gen/preview.png)

Pi extension that adds an `image_generate` tool. Supported providers:

| Provider                       | Model id (alias)                              | Env var               |
| ------------------------------ | --------------------------------------------- | --------------------- |
| OpenAI                         | `gpt-image-2`                                 | `OPENAI_API_KEY`      |
| Google Gemini ("Nano Banana")  | `gemini-3-pro-image` (alias `nano-banana-pro`), `gemini-3.1-flash-image` (alias `nano-banana-2`), `gemini-3.1-flash-lite-image` (alias `nano-banana-2-lite`), `gemini-2.5-flash-image` (alias `nano-banana`) | `GEMINI_API_KEY` |
| Alibaba DashScope (Qwen-Image) | `qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro`, `qwen-image-2.0` | `DASHSCOPE_API_KEY`   |
| Volcengine Ark (ByteDance Seedream) | `doubao-seedream-5-0-pro-260628` (alias `seedream-5-pro`, retired id `doubao-seedream-5-0-pro-260128` still resolves), `doubao-seedream-5-0-260128` (aliases `seedream-5`, `seedream`; the same model also answers to `doubao-seedream-5-0-lite-260128` / `seedream-5-lite`), `doubao-seedream-4-5-251128` (alias `seedream-4-5`), `doubao-seedream-4-0-250828` (alias `seedream-4`) | `ARK_API_KEY`         |
| OpenRouter                     | any (use `openrouter/<vendor>/<id>`)          | `OPENROUTER_API_KEY`  |
| Custom providers               | whatever you declare in settings              | (your choice, via `$VAR`) |

Upstream API docs (handy when debugging gateway behavior or adding new models):

- OpenAI gpt-image-2 — [developers.openai.com/api/docs/models/gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2)
- Google Gemini image generation — [ai.google.dev/gemini-api/docs/image-generation](https://ai.google.dev/gemini-api/docs/image-generation)
- Alibaba Qwen-Image 3.0 (generation & editing) — [help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)
- Alibaba DashScope Qwen-Image 2.0 (text-to-image) — [help.aliyun.com/zh/model-studio/qwen-image-api](https://help.aliyun.com/zh/model-studio/qwen-image-api)
- Alibaba DashScope Qwen-Image-Edit — [help.aliyun.com/zh/model-studio/qwen-image-edit-api](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)
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

Project settings are ignored when project trust is declined. `${ENV_VAR}` interpolation is supported in global and agent settings only, so keep environment-backed credentials out of project settings.

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
| `providers`       | Per-built-in-provider override. Set `apiKey`, `baseUrl`, or `headers` to point at a proxy or non-standard env var. |
| `customProviders` | User-defined providers — see below.                                                      |

In global and agent settings, `apiKey`, `baseUrl`, and `headers` values support `$VAR` and `${VAR}` environment interpolation. Fallbacks require the braced form (for example, `${FOO:-default}`); `$FOO:-default` is not supported. Project settings keep all of these placeholders literal.

## DeepSeek Harness

| Host | `pi-image-gen` status |
| --- | --- |
| [pi2dsh](https://github.com/weijiafu14/pi2dsh) | `@amaster.ai/pi-image-gen@0.1.8` was exercised against a controlled OpenAI-compatible endpoint ([scope and evidence](https://github.com/TGYD-helige/pi/issues/159)). |
| [dsh-pi-host](https://github.com/TGYD-helige/dsh-pi) | Loads `@amaster.ai/pi-image-gen` when selected in its `extensions` list. |

Follow the selected host's documentation for installation and current compatibility details.

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

> Supported `size` values are model-dependent, and the tool schema tells the agent the exact form for the active model: a tier token (`1K`/`1.5K`/`2K`/`3K`/`4K` — the list differs per model) or an explicit `"<w>x<h>"` pixel string, never mixed. Seedream 5.0 / 4.5 enforce a 2K pixel floor (`1024x1024` fails with `InvalidParameter`); 5.0 pro accepts `1K`/`1.5K`/`2K` down to 921,600 px; 4.0 accepts 1K. Full sizing matrix in the [official docs](https://www.volcengine.com/docs/82379/1824121). Seedream has **no `n` parameter** — the API generates one image per request (multi-image is the `sequential_image_generation` mechanism, not exposed here), so `n` is hidden for these models. The extension always sends `watermark: false` — Seedream's watermark switch defaults to `true` and would otherwise stamp an "AI 生成" badge in the corner of every image.

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
| `baseUrl`  | yes      | API endpoint URL. `$VAR` syntax supported.                                           |
| `apiKey`   | usually  | API key string. `$VAR` syntax supported.                                             |
| `name`     | no       | Display name shown in `/image-gen list`.                                             |
| `headers`  | no       | Extra headers merged into every request.                                             |
| `models`   | no       | Optional model id/alias list. Omit to make this a **catch-all** — the provider will accept any unknown model id (passed through as the remote id). Provide a list only when you want aliases or want to route specific ids elsewhere. Each entry is a string or `{ id, alias?, name?, capabilities? }`. |

A custom model whose `id` names a built-in model **inherits that model's capability contract** (size form, `n` ceiling, reference-image rules) so the tool schema stays accurate when you route a known model through your own gateway. Declare `capabilities` on the entry to override individual fields; anything undeclared falls back to the built-in entry, then to a conservative generic contract. Catch-all routes and unknown ids get no contract — the schema stays fully generic, as before.

```json
{
  "pi-image-gen": {
    "defaultModel": "qwen-image-3.0",
    "customProviders": {
      "corp-gateway": {
        "api": "dashscope",
        "baseUrl": "https://gateway.corp.example/api/v1",
        "apiKey": "$GW_KEY",
        "models": [
          "qwen-image-3.0",
          { "id": "my-finetune", "capabilities": { "nMax": 4, "maxReferenceImages": 2 } }
        ]
      }
    }
  }
}
```

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
  n?: number,                      // per-model ceiling (qwen 1–6, gpt-image-2 1–10); hidden for Seedream
  size?: string,                   // per-model form (see below); hidden for Gemini models
  aspectRatio?: string,            // Gemini models only — enum from the model's vocabulary
  imageSize?: string,              // Gemini models only — tier enum ("1K"/"2K"/"4K"), when the model has tiers
  quality?: 'low'|'medium'|'high'|'auto', // present only for a built-in gpt-image route (see below)
  filename?: string,               // filename prefix (no extension)
  outputDir?: string,              // override settings.outputDir for this call
})
```

Returns the absolute file path(s) of saved images. Files land in `outputDir` (default `<cwd>/.pi/images`), filename pattern `<filename or model-UTC-stamp>.<ext>`.

**The schema is model-aware.** Every built-in model carries a capability contract sourced from the official API docs, and the tool is registered with parameters shaped by that contract (on session start, and again after `/image-gen reload`) — so the agent sees exactly the knobs the active model honors, with the documented values in enums and descriptions. The contract is **advice, not a gate**: numeric limits (size ranges, `n` ceilings, reference-image counts and byte ceilings) are stated in the descriptions but never hard-enforced client-side — a self-hosted deployment or gateway may legitimately diverge from the cloud platform's documented limits, and the provider's own error is the backstop. The only client-side rejections are parameter combinations the adapters would silently drop (a pixel `size` sent to a Gemini model, or `aspectRatio` sent to a pixel-size model — the provider never sees those, so it can't complain).

- `size` follows the model's documented form:
  - **Qwen** (`qwen-image-*`): `"<width>*<height>"` (asterisk, e.g. `"2048*2048"`), total pixels 512²–2048²; 3.0 models additionally cap aspect ratio at 1:8–8:1. The x-form is normalized automatically as a safety net.
  - **Seedream** (`doubao-seedream-*`): a tier token from the model's list (`1K`/`1.5K`/`2K`/`3K`/`4K`) **or** an explicit `"<w>x<h>"` within the model's pixel window (2K floor on 5.0/4.5).
  - **gpt-image-2**: `"auto"` or `"<w>x<h>"` — arbitrary sizes allowed (both edges divisible by 16, ratio ≤ 3:1, 655,360–8,294,400 px, longest edge ≤ 3840), beyond the standard `1024x1024`/`1536x1024`/`1024x1536`.
  - Omit `size` to use the model's own default (qwen-image-3.0 auto-picks from the prompt).
- `aspectRatio` / `imageSize` replace `size` for **Gemini** models (they have no pixel-size knob): `aspectRatio` is an enum from the model's vocabulary (10–14 values), `imageSize` an enum of the model's tiers (`1K`/`2K`/`4K`; hidden when the model is fixed at one tier, as `gemini-3.1-flash-lite-image` and `gemini-2.5-flash-image` are).
- `n` carries the model's documented ceiling in its description (qwen 6, gpt-image-2 10) and is **hidden for Seedream** — that API has no count parameter, so `n` would be silently dropped.
- `image` spells out the active model's documented reference-image contract in its description (formats, max count, per-image byte ceiling, dimension advice): qwen documents ≤ 3 images (JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF, ≤ 10MB each), Seedream ≤ 10–14 (incl. HEIC/HEIF, ≤ 30MB), gpt-image-2 ≤ 16 (png/webp/jpg, ≤ 50MB), Gemini ≤ 3–14 (≤ 20MB). These are descriptions of the cloud platform's limits, not client-side gates — the provider enforces its own rules.
- `quality` appears **only** for a **built-in gpt-image** route — the built-in OpenAI provider on `gpt-image-*`, or an OpenRouter route whose model id is gpt-image (e.g. `openrouter/openai/gpt-image-2`). Only there is it constrained to the enum `low`/`medium`/`high`/`auto` (the vocabulary those APIs document). It is **omitted from the schema entirely** for:
  - Gemini, DashScope/Qwen, and Ark/Seedream — their image APIs have no `quality` field (Seedream varies quality by `size` resolution tier instead);
  - **non-gpt-image routes** on the OpenAI/OpenRouter wire — e.g. built-in `openai/dall-e-3` (which uses `standard`/`hd`) or an OpenRouter route to a non-OpenAI model like Seedream — because the enum above is gpt-image's vocabulary, not the wire format's; and
  - **any custom provider**, including OpenAI-*compatible* ones — a self-hosted or third-party model may use a different quality vocabulary (e.g. DALL·E 3's `standard`/`hd`) or none at all, so the OpenAI wire format alone does **not** imply the four values above. Passing an unsupported value would only surface as a provider-side 400.

  If `defaultModel` is unset or misconfigured, `quality` stays present (the tool remains fully featured and `execute` surfaces a friendly config error). Use `"low"` for fast drafts and a higher level for final assets or dense text.

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

The markdown URL is platform-shaped so any CommonMark host (desktop, TUI, CLI) keeps it intact: on macOS/Linux a bare absolute path — byte-identical unless it contains markdown-unsafe characters (whitespace, `#`, `?`, `%`, `()`, `<>`), which are percent-escaped; on Windows a percent-encoded `file:///…` URL (`![result](file:///C:/Users/.../result.png)`) — sanitizers such as react-markdown's `defaultUrlTransform` read `C:` as an unknown URI scheme and strip the img `src`. Independently of the markdown, `details.images[].path` always carries the raw filesystem path.

### Image-to-image / edit

`image` is always an array — pass `["path"]` for a single image, `["a", "b"]` for multi-image conditioning. Each entry must be:

- **Local file path** — a regular png/jpeg/gif/webp/bmp/tiff/heic/heif file inside the session cwd (the active model's accepted formats may be narrower — the `image` parameter description lists them). Paths may be absolute or relative, but symlinks and paths outside cwd are rejected.
- **Public http(s) URL** — private, loopback, link-local, metadata, credentialed, and unsafe redirect destinations are rejected.

Base64 strings and `data:` URIs are intentionally rejected — tool arguments don't survive megabyte-sized strings cleanly. If you have raw image bytes, write them to a file under the session cwd and pass that path.

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
| DashScope (`qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro`, `qwen-image-2.0`) | `image` parts in `messages[].content`. Up to 3 images. |
| OpenRouter | `POST /api/v1/images` with `input_references` JSON. Supports multi-image. |

There is intentionally no `model` parameter on the tool — the active model is fixed by `pi-image-gen.defaultModel` in settings.

## Slash commands

- `/image-gen list` — show the active model, which provider it routes to, whether the key is set, configured providers, and the catalog of built-in model ids.
- `/image-gen reload` — re-read settings from disk and re-register the tool so its schema (e.g. whether `quality` is exposed) tracks the newly selected model.
- `/image-gen generate <prompt>` — generate an image directly from the command line using the active model. Reports the saved file path(s) as a plain-text notification (the command uses `ctx.ui.notify`, which shows a status line, not rendered Markdown — so unlike the tool result it does not emit an inline `![](…)` image). Use the `image_generate` tool from the agent when you want the image rendered inline.

Use `/image-gen list` to verify your config — it will tell you when `defaultModel` is unset, points at a provider with no API key, or names an unknown id.

## Bundled skill

This package ships an `image-gen` skill (`skills/image-gen/SKILL.md`) that Pi loads on demand. Agents are encouraged to read it before using `image_generate`, but the tool remains usable without it. The skill carries the prompting playbook the one-line tool guidance can't hold: when to use raster generation vs repo-native SVG/CSS, generate-vs-edit intent, `n`-is-variants-not-assets, multi-image role labeling, edit invariants, text-in-image handling, and the labeled prompt schema.
