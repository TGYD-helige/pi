# pi-video-gen

Pi extension for video creation. `video_generate` calls a video model directly for one clip; `video_compose` assembles existing media by lossless concat, FFmpeg timeline or a trusted Remotion project; `video_render` executes a prepared batch script with generated and existing shots, persistent remote-task recovery and optional assembly. The `video-gen` skill explains how to choose per shot. `video_capabilities` and `/video-gen` provide model information and direct commands.

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

Registry entries are written against provider documentation (each adapter's header notes the source) and are pending live smoke tests against real accounts — verify with `/video-gen doctor` + one small paid clip before heavy use. Seedance 2.5 stays on the roadmap until its official API ID and parameter contract are published.

**Seedance trusted portrait assets**: Seedance may reject ordinary image/video references containing recognizable real people. For those shots, select a preset avatar or an Active authorized-person asset in the same Volcengine Ark account/project used for generation, then pass its `asset-...` ID (or `asset://asset-...` URI) through `referenceAssets`. The extension supports trusted `image`, `video`, and `audio` assets for the built-in Seedance 2.0 models and maps them to Ark's `asset://` request format. Prompt text refers to their order as `Image 1`, `Video 1`, and `Audio 1` — never by Asset ID.

This package ships dated snapshots of the public material cards and preset persona library under `skills/video-gen/references/`, including the Asset IDs needed by `referenceAssets`. Volcengine does not document those IDs as permanent or cross-account, so retry with an ID copied from the active account's library if a snapshot ID is rejected. Private or authorized-person assets always require the user to provide the current account/project's actual ID. Identity verification, authorization H5 flows, activation, uploading, and asset-library management remain outside this package. See Volcengine's [preset-avatar guide](https://docs.volcengine.com/docs/82379/2608626?lang=zh#preset-avatar), [authorized-person asset guide](https://docs.volcengine.com/docs/82379/2223965?lang=zh), and [Seedance request format](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2333589?projectName=default&lang=zh#d9a7d853).

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

**Custom providers** (same idea as pi-image-gen's — point any Ark-compatible endpoint at your own models; string models get conservative capabilities, object models declare them). When a custom model's `id` names a built-in model (e.g. `"MiniMax-H3"` behind your relay), the built-in capability table and defaults are inherited automatically — undeclared `capabilities`, `defaultResolution`/`defaultAspectRatio`/`defaultDurationSec` fall back to the registry values instead of the conservative 720p/16:9 profile, and any field you do declare overrides the inherited one:

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
            "capabilities": { "maxReferenceImages": 9,
              "maxReferenceVideos": 3, "maxReferenceAudios": 3, "durations": [2, 30],
              "resolutions": ["480p", "720p", "1080p"], "aspectRatios": ["16:9", "9:16"],
              "nativeAudio": true, "supportsFirstLastFrame": true,
              "referenceAssetModalities": ["image", "video", "audio"] } }
        ]
      }
    }
  }
}
```

**NewAPI notes** ([video format docs](https://www.newapi.ai/zh/docs/api/ai-model/videos/createvideogeneration)): NewAPI is a self-hosted relay, so the `newapi` wire format has NO default endpoint — `baseUrl` is mandatory and resolution fails with the exact settings path to fix when it is absent. Both the server root (`"https://newapi.example.com"`) and the OpenAI-style `"…/v1"` form are accepted. Channel-specific parameters ride in `metadata` following the upstream doc examples: `aspect_ratio` + `resolution` (Jimeng/Vidu style), `image_tail` for the last frame (Kling style) and `image_urls` for extra reference images (Jimeng style); the first frame goes in the top-level `image` field. There is no documented audio toggle or idempotency key, so ambiguous submits are parked for manual resolution rather than auto-retried:

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

**MiniMax notes** (v2 API, [create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) / [query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)): MiniMax-H3 speaks a multimodal task API — prompt + frames ride in one `content` array with `first_frame` / `last_frame` / `reference_image` roles (first/last frames and reference images are mutually exclusive; a last frame requires a first frame). Resolution is `768P` or `2K`, duration 4–15s, ratio `16:9|4:3|1:1|3:4|9:16|21:9` — required and non-adaptive for text-to-video, ignored (forced adaptive) once a first frame is present. There is no audio toggle, no idempotency key and no documented cancel endpoint, so ambiguous submits are parked for manual resolution rather than auto-retried. Auth is a plain Bearer key (`providers.minimax.apiKey`, env `MINIMAX_API_KEY`), and keys are region-locked: the default endpoint is international `api.minimax.io` — mainland-China keys need `providers.minimax.baseUrl` set to `https://api.minimaxi.com` (and vice versa a 401 means wrong region). Result URLs are time-limited; clips are downloaded immediately, and tasks stay queryable for 7 days.

**Kling notes** (verified against kling.ai/document-api via browser, 2026-07): current Kling API 2.0 uses a plain API key (`providers.kling.apiKey`, env `KLING_API_KEY`) — the JWT ak/sk scheme is legacy. The model lives in the URL path (`kling-3.0-turbo` / `kling-3.0`); default base is `api-singapore.klingai.com` (regional endpoints via `baseUrl`). Kling 3.0 Omni supports last-frame, native audio and 4k; Turbo is first-frame-only and silent. Submits carry `external_task_id` (our request fingerprint), so ambiguous failures are looked up first; an inconclusive lookup is parked for manual resolution rather than blindly resubmitted.

**HappyHorse notes**: no native audio and no last-frame interpolation (`nativeAudio: false`, `supportsFirstLastFrame: false` in the capability table, so the tools hide/reject those options). One call takes either a first frame (i2v) OR reference images (r2v, prompt them as `[Image 1]`, `[Image 2]`, …), not both. The default endpoint is the classic `dashscope.aliyuncs.com` (no workspace id needed); if you use a new Bailian workspace, set `providers.dashscope.baseUrl` to `https://{workspaceId}.cn-beijing.maas.aliyuncs.com`. Video/task URLs expire after 24h — clips are downloaded immediately.

**Trust boundary**: `providers.*`, `customProviders.*` and `ffmpegPath` are honored ONLY from global / agent-dir settings — project-level `.pi/settings.json` can set `outputDir`, `defaultModel`, `rateLimit`, `concurrency` only (and only when the project is trusted). A malicious repo cannot redirect your API key or swap binaries.

**ffmpeg**: required for multi-shot concat and installed automatically with the plugin through a platform-specific optional npm package. The main plugin stays small, while `pi install npm:@amaster.ai/pi-video-gen` downloads only the platform payload matching the current OS and CPU. That payload contains a default LGPL build plus separately named GPL `ffmpeg-gpl`/`ffprobe-gpl` binaries with libx264 for requested H.264 timeline output. Supported bundled targets are macOS 11+ arm64/x64, glibc Linux arm64/x64 (built on Ubuntu 22.04), and Windows x64; musl Linux uses a system FFmpeg through PATH. Resolution order: `ffmpegPath` setting → `FFMPEG_PATH` env → installed platform package → ffmpeg-static (development only) → PATH. An automatic bundled candidate that is present but not runnable is skipped so it cannot mask a working PATH installation. Check with `/video-gen doctor`. Release CI builds every platform package from the pinned official FFmpeg source with external-library autodetection disabled; the exact FFmpeg, zlib, and x264 source archives, build script, licenses, and provenance ship beside the binaries.

## Tools

| Tool | What it does |
|---|---|
| `video_compose` | **Local video assembly, no paid video models.** `compose-input.json` concatenates compatible clips; `timeline-input.json` renders FFmpeg media, overlays, transitions and subtitles; `remotion-input.json` renders a trusted editable Remotion project. Narration with `edge-tts:<voice-name>` sends text to Microsoft Edge TTS. |
| `video_generate` | One short clip from a structured prompt plus optional first/last frames or current-account trusted `referenceAssets`. Paid, minutes per clip. Interrupted after receiving a task id? Resume with the returned `jobId`; an ambiguous submit is parked and never resubmitted automatically. |
| `video_render` | Executes `<jobDir>/render-input.json`: each shot uses either `videoPath` or a generated prompt with a first frame/trusted asset. Only generated shots need a model and API key. The default assembly concatenates; optional `assembly` selects FFmpeg timeline or Remotion. Paid handles, local snapshots, final SHA-256 and QC hashes support safe recovery. |
| `video_capabilities` | Read-only: active model's capability table, trusted asset modalities, and registered models. Call before composing prompts or shot books. |

## Structured prompts

Both paid tools take structured prompt fields, never a pre-joined string. The plugin assembles the labeled prompt text (`[Style]` / `[Character]` / `[Scene]` / `[Visuals]` / `[Action]` / `[Effects]` / `[Audio]` + consistency/negative directives), so every shot reliably carries the film-level directives:

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
- **Trusted asset references** — `referenceAssets` is an ordered array of
  `{modality: "image"|"video"|"audio", assetId: "asset-..."}`. The public API
  also accepts `asset://asset-...` and normalizes it. Only models declaring the
  requested modality accept it; unsupported inputs fail before a paid submit.
  Built-in Seedance 2.0 models enforce separate request maxima: 9 image
  references total (local frames plus image assets), 3 video assets, and 3
  audio assets.

## Commands

| Command | What it does |
|---|---|
| `/video-gen compose <spec>` | Same as the `video_compose` tool |
| `/video-gen generate --visuals ".." --action ".." [--style ".." --scene ".."]` | Structured-prompt flags for `video_generate` (also `--effects/--audio/--consistency/--negative/--first-frame/--last-frame/--asset-images/--asset-videos/--asset-audios/--duration/--ratio`). Asset flags take comma-separated current-account IDs; request order is images, videos, then audios. The `characters` registry is tool/render-spec only. |
| `/video-gen render <spec>` | Same as the `video_render` tool |
| `/video-gen recover <jobId>` | List ambiguous render shots; explicitly `reset` a confirmed-absent task or `adopt <taskId>` found in the provider console |
| `/video-gen models` | List registered models + key readiness |
| `/video-gen reload` | Reload settings |
| `/video-gen doctor` | Environment check (key, ffmpeg+ffprobe, libx264, CJK fonts, `image_generate`, output dir, trust) |

## Choosing the path

Choose the source for each shot: reuse existing video, call `video_generate` directly for a missing model clip, or draw precise text/UI/chart animation in Remotion. Use `video_render` when a prepared batch needs automation and reliable recovery. A shot book, character portraits and first/last frames are optional creative aids. See [the skill](skills/video-gen/SKILL.md), [render script examples](skills/video-gen/references/video-render-workflow.md) and [Remotion handoff](skills/video-gen/references/remotion-handoff.md).

`video_compose` accepts `<jobDir>/remotion-input.json` with absolute `projectDir`, `compositionId`, optional `entryPoint`, `assets`, `inputProps` and `browserExecutable`. The project must be in a trusted working directory and have local Remotion dependencies plus Chrome/Chromium installed. Original `public/` files are copied with their relative paths; injected assets are available through `inputProps.videoGenAssets` and `staticFile()`. `video_render` uses the same contract under `assembly.type: "remotion"`; it preflights the project with placeholders before any model submit. The plugin does not install Remotion or download a browser during a render.

Remotion specs also accept `qcTimesSec`, up to 32 non-negative timestamps in seconds strictly within the composition duration. Use these to review key handoffs before, during and after the movement. New renders extract first/middle/last review frames plus these times from the actual MP4 and return `qcFrames` and `qcReportPath`. For batch assembly, the returned frame list also includes the Remotion review frames; the batch QC report links their SHA-bound report under `remotion`. Sampling uses the video-track duration so an audio tail cannot push a frame past the picture. Frame/report hashes are verified on resume; missing or changed evidence is rejected. Older jobs without QC hashes resume without recorded QC. See [motion authoring](skills/video-gen/references/motion-authoring.md) and the editable [continuous motion demo](skills/video-gen/examples/continuous-demo/README.md). Both build on the existing Remotion path without another skill or runtime.

For Remotion batch rendering, the composition must expose `props.videoGenShotTimesSec` with one in-film sample time (seconds) per shot ID. It may be set through `defaultProps` or computed by `calculateMetadata` from the actual assets. The placeholder preflight checks that every shot has a valid time before paid submission; the final QC uses the values returned by the rendered composition. Default concat and FFmpeg timeline QC use actual clip or resolved segment durations instead.

Keep Remotion source files and imports outside the video output directory; that directory is excluded from the frozen project fingerprint so other jobs cannot invalidate paid work. The entry point is rejected if it is inside the output directory, and the output directory cannot be inside the project's `public/` tree.

Remotion is installed by the local project rather than distributed with this package. Review [Remotion's license FAQ](https://www.remotion.dev/docs/license/faq) for the project's usage and organization before deploying an automated rendering service.

## Jobs on disk

```
<cwd>/.video-gen/<jobId>/
├── render-input.json   # immutable spec (revisions = new job dir)
├── assets.json         # semantic assets ↔ image_generate's real returned paths
├── manifest.json       # state + per-shot remote handles/local hashes + final SHA-256
├── shots/<shotId>/first_frame.png|last_frame.png|video.mp4
├── qc/shot_<shotId>.png # one frame per source shot with content hashes
├── qc/final_part_<n>.png # samples from the assembled MP4
├── assembly/            # separate child job for timeline or Remotion mode
└── final_video.mp4      # default concat mode; assembly modes return assembly/final_video.mp4
```

Crash or cancel mid-render? Rerun the same spec path — generated-shot handles resume via `inspect` without re-billing, and local shots are checked against frozen content hashes. Completed jobs verify their final MP4 and QC hashes instead of recomposing. All-local jobs omit the model/provider from their fingerprint and need no API key. A legacy `done` render manifest without a saved final SHA-256 cannot verify its old film; create a new compose job from the saved clips. Cancelling stops local polling only; remote tasks may keep running and billable. If submit completion is ambiguous, use `/video-gen recover <jobId>` after checking the provider console.

**Upgrading from the pre-structured format**: render jobs whose `render-input.json` still uses the old `videoPrompt` string can no longer be parsed or resumed (the structured `prompt` object replaced it deliberately, with no compatibility layer). If an in-flight paid task is stranded by the upgrade, download its clip manually from the provider console — task URLs expire (Ark: 24h). Single-clip jobs are unaffected: their frozen `input.json` is read, not re-parsed.

## Structured results (Pi 0.99+)

All four tools declare `outputSchema` and return bounded `structuredContent`; codemode receives the object directly. Generation returns `jobId`, `state`, `videoPath`, and available `taskId`/`bytes`; composition/rendering return `jobId`, `state`, `finalVideoPath`, and their existing composition metadata. `video_capabilities` exposes `activeId`, `activeResolved`, `provider`, `keyReady`, `capabilities`, `models`, and `totalModels`, without provider credentials or URLs.

`qcStatus: "recorded"` means the result includes existing QC frame/report paths. It does not mean a human or visual inspection passed. `qcStatus: "not_performed"` covers single clips, concat, or historical jobs without recorded QC. Available `qcFrames`, `qcReportPath`, `subtitlePath`, and editable project paths are returned directly. Failures return `{ error, truncated }` with `isError: true` and available persisted `jobId`/`state`/`taskId` or render-shot states. An ambiguous or interrupted paid job must be inspected/resumed rather than submitted again.

```javascript
const image = await tools.image_generate({ prompt: "A blue product illustration" });
if (image.error) throw new Error(image.error);
await tools.write({ path: ".video-gen/demo/timeline-input.json", content: JSON.stringify({
  output: { resolution: "640x360", fps: 25 },
  segments: [{ id: "s1", image: image.images[0].path, durationSec: 1, motion: "static" }]
}) });
const video = await tools.video_compose({ composeSpecPath: ".video-gen/demo/timeline-input.json" });
if (video.error) throw new Error(video.error);
text({ path: video.finalVideoPath, qcStatus: video.qcStatus, frames: video.qcFrames });
```

The example's image call requires the normal image-provider configuration and authorization. `tests/structured-workflows.test.ts` exercises the same chain in real Pi codemode (`on` and `only`) with a fixed image-provider fixture and real local FFmpeg rendering, without paid/network generation.

Structured output is limited to 12 KiB and top-level lists to 100 complete records. `truncated: true` indicates omitted records; `total` retains the original count where available. Oversized records with an `id` retain that complete ID and small scalar metadata, omit large fields, and carry `truncated: true` both on the record and envelope; callers must check that flag before reusing content for an update. Oversized results without a record ID return a typed output-limit error instead of clipped paths or content. A write may already have completed when that happens: inspect saved state before retrying. Readable text and renderer details are independently bounded.

## References

- [huashu-motion skill](https://github.com/alchaincyf/huashu-motion/blob/52467f99c602b76ba86d511d37acdfe93fa1e16e/skills/huashu-motion/SKILL.md): reference for creative direction, motion rhythm, music and export review. pi-video-gen uses its own tools and composition workflows.

FFmpeg, encoder, and font probes run asynchronously and accept caller cancellation. Probes time out after 5 seconds (2 seconds for fontconfig); up to 32 successful results are cached for 30 seconds. Replacing a binary at an explicit path invalidates its cached result. Font checks try known platform font files before invoking fontconfig.
