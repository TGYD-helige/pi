# pi-video-gen

Pi extension for agentic video generation. Ships the single-clip primitive
(`video_generate`), the multi-shot render pipeline (`video_render`), local
lossless clip composing and mixed-media promo timelines with overlays, TTS,
soft or burned subtitles, source-video audio, and BGM (`video_compose`), the read-only
`video_capabilities` query, a `/video-gen` command, and the `video-gen` skill
that orchestrates the full shot-book workflow together with
[pi-image-gen](../pi-image-gen) (all image work).

## Providers

| Wire format | Models | Status |
|---|---|---|
| `ark` (Volcengine Ark) | Seedance 2.0 standard / fast / mini | ✅ built-in |
| `dashscope` (Alibaba) | HappyHorse 1.1 / 1.0 (t2v/i2v/r2v auto-routed) | ✅ built-in |
| `kling` (Kuaishou) | Kling 3.0 Turbo / 3.0 Omni (API 2.0) | ✅ built-in |
| `minimax` | MiniMax-H3 (v2 API) | ✅ built-in |
| `openrouter` | google/veo-3.1 (+ custom models) | ✅ built-in |
| `newapi` | self-hosted NewAPI relay (Kling / Jimeng / Vidu / Gemini channels) | ✅ via `customProviders` — `baseUrl` **required** |
| custom | your own endpoints | ✅ via `customProviders` |

Registry entries are written against provider documentation (each adapter's
header notes the source) and are pending live smoke tests against real
accounts — verify with `/video-gen doctor` + one small paid clip before heavy
use. Seedance 2.5 stays on the roadmap until its official API ID and parameter
contract are published.

## Setup

Global settings (`~/.pi/agent/settings.json`):

```jsonc
{
  "pi-video-gen": {
    "defaultModel": "seedance-2.0",              // alias of doubao-seedance-2-0-260128
    "providers": {
      "ark": { "apiKey": "${ARK_API_KEY}" }      // Volcengine Ark key
    },
    "rateLimit": { "maxRequestsPerMinute": 2, "maxRequestsPerDay": 20 },
    "concurrency": { "clips": 2 }
  }
}
```

**Custom providers** (same idea as pi-image-gen's — point any Ark-compatible
endpoint at your own models; string models get conservative capabilities,
object models declare them). When a custom model's `id` names a built-in
model (e.g. `"MiniMax-H3"` behind your relay), the built-in capability table
and defaults are inherited automatically — undeclared `capabilities`,
`defaultResolution`/`defaultAspectRatio`/`defaultDurationSec` fall back to
the registry values instead of the conservative 720p/16:9 profile, and any
field you do declare overrides the inherited one:

```jsonc
{
  "pi-video-gen": {
    "defaultModel": "fast9",
    "customProviders": {
      "myproxy": {
        "api": "ark",
        "baseUrl": "https://proxy.example/api/v3",
        "apiKey": "${MY_PROXY_KEY}",
        "models": [
          "seedance-lite-x",
          { "id": "remote-model-9", "alias": "fast9",
            "capabilities": { "maxReferenceImages": 2, "durations": [2, 30],
              "resolutions": ["480p", "720p", "1080p"], "aspectRatios": ["16:9", "9:16"],
              "nativeAudio": true, "supportsFirstLastFrame": true } }
        ]
      }
    }
  }
}
```

**NewAPI notes** ([video format docs](https://www.newapi.ai/zh/docs/api/ai-model/videos/createvideogeneration)):
NewAPI is a self-hosted relay, so the `newapi` wire format has NO default
endpoint — `baseUrl` is mandatory and resolution fails with the exact
settings path to fix when it is absent. Both the server root
(`"https://newapi.example.com"`) and the OpenAI-style `"…/v1"` form are
accepted. Channel-specific parameters ride in `metadata` following the
upstream doc examples: `aspect_ratio` + `resolution` (Jimeng/Vidu style),
`image_tail` for the last frame (Kling style) and `image_urls` for extra
reference images (Jimeng style); the first frame goes in the top-level
`image` field. There is no documented audio toggle or idempotency key, so
ambiguous submits are parked for manual resolution rather than auto-retried:

```jsonc
{
  "pi-video-gen": {
    "defaultModel": "kling-v1",
    "customProviders": {
      "newapi": {
        "api": "newapi",
        "baseUrl": "https://newapi.example.com",   // REQUIRED
        "apiKey": "${NEWAPI_API_KEY}",
        "models": ["kling-v1", "jimeng_vgfm_t2v_l20", "viduq1"]
      }
    }
  }
}
```

**MiniMax notes** (v2 API, [create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) / [query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)):
MiniMax-H3 speaks a multimodal task API — prompt + frames ride in one
`content` array with `first_frame` / `last_frame` / `reference_image` roles
(first/last frames and reference images are mutually exclusive; a last frame
requires a first frame). Resolution is `768P` or `2K`, duration 4–15s, ratio
`16:9|4:3|1:1|3:4|9:16|21:9` — required and non-adaptive for text-to-video,
ignored (forced adaptive) once a first frame is present. There is no audio
toggle, no idempotency key and no documented cancel endpoint, so ambiguous
submits are parked for manual resolution rather than auto-retried. Auth is a
plain Bearer key (`providers.minimax.apiKey`, env `MINIMAX_API_KEY`), and keys
are region-locked: the default endpoint is international
`api.minimax.io` — mainland-China keys need `providers.minimax.baseUrl` set
to `https://api.minimaxi.com` (and vice versa a 401 means wrong region).
Result URLs are time-limited; clips are downloaded immediately, and tasks
stay queryable for 7 days.

**Kling notes** (verified against kling.ai/document-api via browser, 2026-07):
current Kling API 2.0 uses a plain API key (`providers.kling.apiKey`, env
`KLING_API_KEY`) — the JWT ak/sk scheme is legacy. The model lives in the URL
path (`kling-3.0-turbo` / `kling-3.0`); default base is
`api-singapore.klingai.com` (regional endpoints via `baseUrl`). Kling 3.0 Omni
supports last-frame, native audio and 4k; Turbo is first-frame-only and
silent. Submits carry `external_task_id` (our request fingerprint), so
ambiguous failures are looked up first; an inconclusive lookup is parked for
manual resolution rather than blindly resubmitted.

**HappyHorse notes**: no native audio and no last-frame interpolation
(`nativeAudio: false`, `supportsFirstLastFrame: false` in the capability table,
so the tools hide/reject those options). One call takes either a first frame
(i2v) OR reference images (r2v, prompt them as `[Image 1]`, `[Image 2]`, …),
not both. The default endpoint is the classic `dashscope.aliyuncs.com` (no
workspace id needed); if you use a new Bailian workspace, set
`providers.dashscope.baseUrl` to `https://{workspaceId}.cn-beijing.maas.aliyuncs.com`.
Video/task URLs expire after 24h — clips are downloaded immediately.

**Trust boundary**: `providers.*`, `customProviders.*` and `ffmpegPath` are
honored ONLY from global / agent-dir settings — project-level
`.pi/settings.json` can set `outputDir`, `defaultModel`, `rateLimit`,
`concurrency` only (and only when the project is trusted). A malicious repo
cannot redirect your API key or swap binaries.

**ffmpeg**: required for multi-shot concat and installed automatically with
the plugin through a platform-specific optional npm package. The main plugin
stays small, while `pi install npm:@amaster.ai/pi-video-gen` downloads only
the platform payload matching the current OS and CPU. That payload contains a
default LGPL build plus separately named GPL `ffmpeg-gpl`/`ffprobe-gpl`
binaries with libx264 for requested H.264 timeline output. Supported bundled
targets are macOS 11+ arm64/x64, glibc Linux arm64/x64 (built on Ubuntu 22.04),
and Windows x64; musl Linux uses a system FFmpeg through PATH. Resolution order:
`ffmpegPath` setting → `FFMPEG_PATH` env → installed platform package →
ffmpeg-static (development only) → PATH. An automatic bundled candidate that
is present but not runnable is skipped so it cannot mask a working PATH
installation. Check with `/video-gen doctor`.
Release CI builds every platform package from the pinned official FFmpeg
source with external-library autodetection disabled; the exact FFmpeg, zlib,
and x264 source archives, build script, licenses, and provenance ship beside
the binaries.

## Tools

| Tool | What it does |
|---|---|
| `video_compose` | **Local video assembly, no paid video models.** C0 (`compose-input.json`) concatenates compatible clips. Timeline media, overlays, transitions, subtitles, source audio, and BGM render locally. Narration is an explicit network feature: setting `voice` to `edge-tts:<voice-name>` sends narration text to Microsoft Edge TTS. |
| `video_generate` | One short clip from a structured prompt (style/scene/visuals/action/effects/audio + optional first/last frame images). Paid, minutes per clip. Interrupted after receiving a task id? Resume with the returned `jobId`; an ambiguous submit is parked and never resubmitted automatically. |
| `video_render` | Multi-shot film from `<jobDir>/render-input.json`: snapshots + hashes all frames, submits one paid task per shot (resume-aware, finished shots never re-bill), downloads clips, ffmpeg-concats into `final_video.mp4`. |
| `video_capabilities` | Read-only: active model's capability table + registered models. Call before composing prompts or shot books. |

## Structured prompts

Both paid tools take structured prompt fields, never a pre-joined string. The
plugin assembles the labeled prompt text (`[Style]` / `[Character]` / `[Scene]`
/ `[Visuals]` / `[Action]` / `[Effects]` / `[Audio]` + consistency/negative
directives), so every shot reliably carries the film-level directives:

- **Film level** — `style` (genre/quality/texture), `characters`
  (`{id, description}` registry), `consistency` (identity/no-drift directive),
  `negative` (e.g. "no text, watermarks, or subtitles").
- **Shot level** (`prompt` object) — `visuals` (camera/framing) and `action`
  are always required; `scene` plus film-level `style` are **required when no
  first frame anchors the shot** (text-to-video must not go out action-only);
  `effects` carries time-varying content a static frame cannot express
  (transformations, lighting shifts, atmosphere); `audio` takes
  `[Sound Effect] … / [Speaker] …` cues; `visibleCharacters` inlines the
  referenced character descriptions.

## Commands

| Command | What it does |
|---|---|
| `/video-gen compose <spec>` | Same as the `video_compose` tool |
| `/video-gen generate --visuals ".." --action ".." [--style ".." --scene ".."]` | Structured-prompt flags for the `video_generate` tool (also `--effects/--audio/--consistency/--negative/--first-frame/--last-frame/--duration/--ratio`; quote values may escape their delimiter as `\"`). The `characters` registry is tool/render-spec only — not available via flags |
| `/video-gen render <spec>` | Same as the `video_render` tool |
| `/video-gen recover <jobId>` | List ambiguous render shots; explicitly `reset` a confirmed-absent task or `adopt <taskId>` found in the provider console |
| `/video-gen models` | List registered models + key readiness |
| `/video-gen reload` | Reload settings |
| `/video-gen doctor` | Environment check (key, ffmpeg+ffprobe, libx264, CJK fonts, `image_generate`, output dir, trust) |

## The shot-book workflow (multi-shot films)

Driven by the `video-gen` skill in conversation:

1. **Shot book** — the agent authors a shot book (characters + shots with
   first/last-frame descriptions, visuals+action, effects, audio, continuity)
   and you review it in chat. Default small: 1 scene, 3–5 shots.
2. **Frames** — the agent generates character portraits and per-shot frames via
   `image_generate` (pi-image-gen), tracking real returned paths in
   `assets.json`.
3. **Render** — after explicit confirmation, ONE `video_render` call pays for
   and stitches everything.

## Jobs on disk

```
<cwd>/.video-gen/<jobId>/
├── render-input.json   # immutable spec (revisions = new job dir)
├── assets.json         # semantic assets ↔ image_generate's real returned paths
├── manifest.json       # state + per-shot remote handles + frame SHA-256 (atomic, single writer)
├── shots/<shotId>/first_frame.png|last_frame.png|video.mp4
└── final_video.mp4
```

Crash or cancel mid-render? Rerun the same spec path — the input fingerprint
(spec + frame hashes + model/provider) is verified, then persisted handles
resume via `inspect` without re-billing. NOTE: cancelling stops local polling
only; the remote task may keep running and billable (Ark cancellation support
is unverified). If submit completion is ambiguous, rerun is blocked until
`/video-gen recover <jobId>` explicitly resets or adopts the affected shot.
Single-clip ambiguous submits are also persisted and blocked; check the provider
console before starting another generation. Single-job resume independently
recomputes the request fingerprint from its frozen `input.json`; an inspect 404
keeps the remote handle and parks the job as ambiguous instead of declaring it
safe to resubmit.

**Upgrading from the pre-structured format**: render jobs whose
`render-input.json` still uses the old `videoPrompt` string can no longer be
parsed or resumed (the structured `prompt` object replaced it deliberately,
with no compatibility layer). If an in-flight paid task is stranded by the
upgrade, download its clip manually from the provider console — task URLs
expire (Ark: 24h). Single-clip jobs are unaffected: their frozen `input.json`
is read, not re-parsed.
