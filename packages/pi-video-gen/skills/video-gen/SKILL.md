---
name: video-gen
description: "Video creation and local composition: join existing clips or render mixed image/video timelines with video_compose, generate one AI clip with video_generate, or make a multi-shot AI film with video_render. Use when the deliverable is a video. Do NOT use for still images (use pi-image-gen directly)."
---

# Video generation

This skill orchestrates four published flows:

- **C0 local concat** — `video_compose` joins compatible existing MP4 clips.
- **Timeline render** — `video_compose` locally turns images/screenshots and existing video clips into a video with overlays, motion, transitions, soft or burned subtitles, source audio, and optional BGM. Narration is an optional network feature.
- **Single AI clip** — one paid `video_generate` call.
- **Shot-book AI film** — author a shot book, generate frames with `image_generate`, then ONE paid `video_render` call renders and stitches.

The AI video model is fixed by `pi-video-gen.defaultModel`; generated images use pi-image-gen's active model.

## A. Workflow rules

0. **Route first.** Choose the right flow before anything:

   | User goal | Flow |
   |---|---|
   | Existing local mp4 clips to join | `video_compose` (C0 — lossless, local, no paid models) |
   | One AI-generated moving shot | `video_generate` |
   | Multi-shot film with keyframes | `video_render` |
   | Promo/explainer from images, screenshots & clips | `video_compose` (TimelineSpec — local mixed-media render; optional network TTS) |

1. **Local flows stop here.** For C0 follow §A0; for Timeline follow §A1. Do not run the AI preflight, shot-book steps, or paid confirmation gates below. Timeline only needs `image_generate` when its source images do not already exist.
2. **AI preflight only.** For `video_generate` or `video_render`, call `video_capabilities` and respect the active model's duration range and audio support, frame support, and trusted asset modalities. Confirm `image_generate` is available only when source frames need to be generated (`/video-gen doctor` checks; config health is `/image-gen list`).
3. **Pick the AI flow.** A vague idea or a script that needs multiple shots → shot-book flow. One moving shot → `video_generate`. A still → pi-image-gen.
4. **Write the shot book in conversation** (schema in §B). If the user only has a vague idea, first be the screenwriter: three-act structure, filmable actions ("show, don't tell"), concrete visual detail. Iterate with the user in chat.
5. **Confirmation gate 1 (shot-book only).** Show the shot-book summary — shot count, character list, estimated image calls (~2N+3C) and video calls (N) — and get an explicit go-ahead. **Default small: 1 scene, 3–5 shots** unless the user asks for more.
6. **Source stage (shot-book only).** Use trusted portrait assets per §A2 when Seedance will receive a recognizable real person. Otherwise generate the required character portraits and per-shot frames via `image_generate` per §C. Show each generated batch to the user.
7. **Paid confirmation.** Before `video_generate`, confirm its one paid call. For a shot book, once frames are ready, state "about to make N paid video calls" and get an explicit render order. Then assemble the render spec and call `video_render` ONCE.
8. **Cost honesty.** AI video calls are paid and take minutes each. Never state amounts (prices change); state call counts and durations.
9. **Revisions.** The render spec is immutable per job directory. Text-stage revisions happen in chat (regenerate frames as needed); a revised film goes in a NEW job directory. NEVER suggest "delete shots/<id>/ and rerender" — that breaks downstream dependencies. Rerunning the SAME spec path resumes an interrupted job (finished shots don't re-bill).
10. **Degradation negotiation.** If `video_render` preflight fails (e.g. last frame unsupported), present the options (switch model / edit spec / `allowDegradations`) and let the user choose. Never degrade silently. When the model's `nativeAudio` is false, don't write audio cues into video prompts unless the user accepted silence.
11. **Cancellation honesty.** Interrupting stops local polling only — remote tasks may keep running and billable (Ark cancellation is unverified). Say so.

## A0. C0 — composing existing clips (`video_compose`)

1. **Tell the user first**: clip count, order, output location (`<jobDir>/final_video.mp4`), `mode: "copy"`. This is LOCAL compute — do not use the paid-model confirmation script for it.
2. Write `<jobDir>/compose-input.json` (`{"clips":[{"id":"c1","path":"/abs/a.mp4"},…],"output":{"mode":"copy"}}`) under the video-gen output dir, then call `video_compose` ONCE. Keep source clips outside `<jobDir>/clips/`; that directory and `final_video.mp4` are reserved pipeline outputs, and a fresh job refuses either conflict.
3. **Only promise** lossless concat of compatible MP4s (C0). **Never promise** trimming, transitions, overlays, subtitles, TTS, BGM, or re-encoding **for the C0 path** — those live in the Timeline path (A1 below), not here; do not hint at them for `compose-input.json`.
4. On any ordered stream incompatibility across all tracks (codec/resolution/fps/timebase/pix_fmt/sample-rate/audio layout), hand the exact ffprobe differences back to the user/agent: re-encode the odd clips first. NEVER silently transcode, and NEVER fall back to `video_generate`/`video_render` as a workaround.
5. Interrupted? Rerun the SAME path (fingerprint-verified resume / cached). Changed clips or order? NEW job directory. A completed final video is hash-bound; if it is missing or changed, restore the exact artifact or start a NEW job.

## A1. Timeline compose (`video_compose` with `timeline-input.json`)

Use for promos/explainers from still images and existing clips. Media rendering is local and uses no paid video model. If narration is requested, disclose that the explicit `edge-tts:<voice>` option sends narration text to Microsoft before using it.

1. **Collect existing images/screenshots/clips first**, and use `image_generate` only for missing visual material. Keep all source media outside the job directory, then author `<jobDir>/timeline-input.json`. `assets/`, `overlays/`, `audio/`, `segments/`, `qc/`, generated tracks, subtitles, and `final_video.mp4` are reserved pipeline outputs; a fresh job refuses any conflicts rather than deleting them.
   ```jsonc
   {
     "title": "产品宣传片",
     "output": { "resolution": "1920x1080", "fps": 25, "codec": "h264" },
     "voice": "edge-tts:zh-CN-YunyangNeural",   // explicit opt-in: narration text is sent to Microsoft
     "ttsFailureMode": "fail",                  // or "silent-subtitles" only after the user accepts that degradation
     "subtitles": { "mode": "burn", "fontSize": 36,
       "textColor": "#ffffff", "backgroundColor": "#000000", "backgroundOpacity": 0.55 },
     "segments": [
       {
         "id": "intro",
         "image": "/abs/frame-1.png",
         "durationSec": 5,                      // image only: may be "auto" from narration
         "motion": "kenburns-in",               // image only
         "transitionTo": { "type": "xfade", "style": "fade", "durationSec": 0.8 },
         "overlay": { "title": "标题", "subtitle": "副标题", "position": "bottom-left" },
         "narration": "这一段的中文旁白文本"
       },
       {
         "id": "demo",
         "video": "/abs/demo.mp4",
         "trimStartSec": 2.5,
         "durationSec": 6,                      // video always uses a numeric duration
         "fit": "contain",                      // contain | cover
         "sourceAudio": { "muted": false, "volume": 0.25 }
       }
     ]
   }
   ```
2. **Chinese text NEVER comes from an image model** — titles/subtitles go in `overlay` and are rendered locally via SVG (no garbled CJK).
3. **Paid-model confirmation is unnecessary** for the local media render, but still show the segment count and total planned duration before calling `video_compose`. Obtain explicit agreement before sending narration text to Edge TTS.
4. Every segment contains exactly one of `image` or `video`. Video segments are normalized to the output resolution/fps, may be trimmed/scaled, and mix their source audio with narration before optional BGM. Video source audio without a stream degrades to silence; `sourceAudio.muted: true` or `volume: 0` disables it. A video's numeric `durationSec` is its fixed trim window; narration that does not fit is rejected instead of extending it.
5. Narration uses Edge TTS only with an explicit `edge-tts:<voice>` selection; its text is sent to Microsoft. Measured audio duration drives image `durationSec: "auto"`; subtitles use each segment's actual video timing. `subtitles.mode` defaults to `"soft"` (`mov_text`); `"burn"` renders the configured font/color/background directly into each narrated segment. TTS failures stop the job by default. Use `ttsFailureMode: "silent-subtitles"` only as an explicit degradation choice; it keeps the subtitle track and fills that segment with silence. Once accepted, that degradation is cached for the immutable job; create a NEW job to retry real narration.
6. On completion, review the QC frames in `<jobDir>/qc/` yourself (Read the PNGs) before showing the result — flipped/overlapping text only shows up visually. Soft `mov_text` subtitles are not burned into those PNGs; the pipeline separately verifies that the subtitle stream exists and that the SRT cues match the resolved segment timeline.
7. The spec is immutable per job: rerunning the same path resumes only regular job-local artifacts whose manifest hashes still match; changes require a NEW job directory. A committed artifact that is missing or changed is rejected rather than regenerated underneath cached downstream outputs. A completed manifest with any missing artifact hash is rejected; an interrupted manifest invalidates unverified downstream hashes before rebuilding an uncommitted upstream artifact.

## A2. Seedance trusted portraits and provider-managed assets

Before any paid Seedance call that may contain a recognizable human face:

1. **Classify the source.** Ordinary uploaded or generated images/videos of a recognizable real person may be rejected by Seedance's privacy checks. Do not treat a local file path or public URL as an authorized portrait.
2. **Search preset personas when needed.** If the user has not already chosen an identity, run this skill's `scripts/search-seedance-personas.mjs` with `--query "<space-separated traits>" --framing half|full --limit 5`. Use `half` for close/medium portrait shots and `full` when the whole body or body movement must be visible. Present the bounded matches with label, short bio, framing, and Asset ID; let the user choose before a paid call. The script is the access path; do not load the entire 3.6 MB JSON catalog into context.
3. **Use the exact trusted asset.** For a catalog choice, copy the returned `selectedAssetId`. Otherwise ask the user for a preset-avatar or Active authorized-person `asset-...` ID from the current Ark account/project. Catalog IDs were observed on 2026-08-24 and are not documented as permanent or cross-account. If the active account rejects one, ask the user to copy the current ID from that account's virtual-avatar library.
4. **Preserve modality order.** Put provider assets in `referenceAssets` as `{ "modality": "image|video|audio", "assetId": "asset-..." }`. Order is significant within each modality. In the prompt say `Image 1`, `Video 1`, or `Audio 1`; never expose or cite the Asset ID in prompt prose. For the built-in Seedance 2.0 models, keep each request within 9 image references total (local frames plus image assets), 3 video assets, and 3 audio assets.
5. **Reconfirm the paid context.** Approval is scoped to the exact asset list, provider/account context, model, clip count, and duration. A changed asset, account/project, provider, model, or job requires a new confirmation.
6. **Keep onboarding out of scope.** This package submits already-created assets. It does not perform identity verification, authorization H5 flows, asset activation, upload, or asset-library management.

Official references: [preset avatars](https://docs.volcengine.com/docs/82379/2608626?lang=zh#preset-avatar), [authorized-person assets](https://docs.volcengine.com/docs/82379/2223965?lang=zh), and [Seedance asset request format](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2333589?projectName=default&lang=zh#d9a7d853).

## A3. Seedance public image/video/audio materials

When the user asks for built-in Seedance materials, action references, camera references, visual styles, environments, characters, or sample voices, read [`references/seedance-public-material-library.md`](references/seedance-public-material-library.md) completely before proposing choices. Use the exact Chinese display labels from that catalog, copy its exact Asset IDs into `referenceAssets`, and keep the selected media in modality order. These IDs were read from the public material cards, not from the separate virtual-avatar library. If the active account rejects a listed ID, re-open the experience center and copy the current card ID instead of guessing or substituting a media URL.

## B. Shot book (VideoProject) — authoring reference

Author as JSON in conversation; save to `<jobDir>/project.json` for the record.

```jsonc
{
  "title": "...", "style": "Cartoon",
  "characters": [{ "id": "alice", "visible": true,
    "appearance": "long blonde hair, blue eyes, slender",   // static features
    "outfit": "red scarf, black leather jacket" }],          // dynamic features
  "shots": [{
    "id": "s1",
    "intent": "Wide shot, rainy alley. <Alice> enters from the left, stops under the streetlamp…",
    "scene": "Rainy alley at night, neon signs, wet pavement",   // optional: the shot's setting
    "firstFrame": "…pure static description of the FIRST frame…",
    "lastFrame": "…(optional) pure static description of the LAST frame…",
    "visuals": "Static camera, wide shot from across the street…",   // camera + framing only
    "action": "A woman with long blonde hair and a red scarf walks in from the left…",
    "effects": "…(optional) time-varying visuals: rain picks up, neon reflections intensify…",
    "audio": "[Sound Effect] rain, distant traffic. [Speaker] Alice (soft): \"We're here.\"",
    "visibleCharacters": ["alice"],
    "durationSec": 5,
    "continuityGroup": "alley",
    "startFrameFromShotId": "s0",   // optional: this shot's frame builds on s0's frame
    "continuityNote": "In s0's frame Alice faces away; front view missing"
  }]
}
```

Field rules:

- **Every shot needs a narrative purpose** (establish / emotion / reaction). First shot: widest view of the scene. Close-ups for emotion, wide shots for context.
- **At most one dialogue line per shot.** Character names in `intent` are wrapped in angle brackets: `<Alice>`.
- **firstFrame / lastFrame are pure static snapshots** — no ongoing actions ("he is sitting, leaning forward", NOT "he is about to stand"). Include shot size, angle, composition, who is where and facing which way.
- **visuals = camera + framing only** (movement, shot size, angle, focus); **action = in-frame movement only**. Split them — they become separate labeled sections in the assembled prompt. Refer to characters by visible traits ("the woman in the red scarf"), never by name.
- **scene is the shot's setting**, copied verbatim into the render spec's `prompt.scene`. Optional when the first frame fully anchors the setting; write it when the setting carries mood/lighting the frame may not convey.
- **effects is for what a static frame cannot carry**: transformations, lighting/atmosphere shifts, particles, slow motion. Omit when the shot is visually static.
- **lastFrame needed when**: composition/focus changes drastically, a character enters or turns to face camera, a major reveal happens. Otherwise omit it.
- **Few camera positions.** Default: one `continuityGroup` for everything. New group only when shot size/angle/focus differs significantly.
- **continuityGroup** = shots sharing a space/base image; **startFrameFromShotId** pins a specific parent frame for composition; **continuityNote** says what the parent frame lacks (the frame prompt must then keep the background and replace those elements). Self-check: parent shot EXISTS, comes EARLIER, same continuityGroup, no cycles.
- **audio** uses `[Sound Effect] …` / `[Speaker] Name (Emotion): "line"` format.
- **durationSec and all capability values come from `video_capabilities`** — never from memory or this document. Durations, resolutions, ratios, audio and frame support differ per model and change over time.
- **Behavioral quirks worth knowing** (still verify with `video_capabilities`): some models have no native audio (omit audio cues or the render is silent); some cannot do last-frame interpolation (never pass lastFrame to them); HappyHorse takes a first frame OR reference images in one call, not both — cite references in the prompt as `[Image 1]`, `[Image 2]`, …

## C. Image operation manual (via `image_generate`)

Generic `image_generate` usage (params, sizes, `n`, edit labeling) follows the **pi-image-gen skill** — it is the single authority; do not deviate. Two video-specific handoff rules:

- **Never assume a saved filename**: the actual extension follows the MIME type and collisions get `-v2`. **The returned absolute path is the only truth** — record it immediately in `assets.json` (see below) and reference it in the render spec.
- `assets.json` in the job dir: `{ "assets": { "<shotId>/<part>": { "sourcePath": "…" } } }` mapping semantic assets (e.g. `s1/firstFrame`, `alice/front`) to real paths.

**Character portraits (3 views per visible character)**:

- front (text-to-image): `Generate a full-body, front-view portrait of character {identifier} based on the following description, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Gazing straight ahead. Standing with arms relaxed at sides. Natural expression. Features: {appearance}; {outfit}. Style: {style}`
- side (edit with front as reference): `Generate a full-body, side-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Facing left. Standing with arms relaxed at sides.`
- back (edit with front as reference): `Generate a full-body, back-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. No facial features should be visible.`

If side/back fails after one retry, reuse front. Characters with `visible: false` get no portraits.

**Reference selection for frames**: candidates = portraits of visible characters (ONE view each, chosen by facing) + continuity frames. Pick a SMALL set of the most relevant ones — same camera/group first, most recent frames first, drop redundant near-duplicates, prefer the portrait when a character newly appears. How many images a call accepts is pi-image-gen's authority (its skill/tool description), not this document's.

**Frame prompt assembly**: prefix each reference image with its role, then the frame description mapping elements to images:

```
Image 0: A front view portrait of Alice.
Image 1: [alley] Wide shot of the rainy alley from shot s1.
Create an image based on the following description: <firstFrame text>. The alley background should reference Image 1; Alice's appearance should reference Image 0.
```

## D. Assemble the render spec and render

Write `<outputDir>/<jobId>/render-input.json` (jobId: letters/digits/dash/underscore):

```jsonc
{
  "title": "…", "aspectRatio": "16:9",
  "style": "Cartoon, warm palette, soft shading",        // film-level look — from the shot book's style
  "characters": [                                        // film-level registry — id + appearance/outfit merged
    { "id": "alice", "description": "long blonde hair, blue eyes, slender; red scarf, black leather jacket" }
  ],
  "consistency": "Faces, hair and outfits stay identical across the shot, no morphing or drift.",
  "negative": "no text, watermarks, or subtitles",
  "shots": [{
    "id": "s1",
    "prompt": {                                          // from the shot book's fields, verbatim
      "scene": "Rainy alley at night, neon signs, wet pavement",   // omit when the first frame says it all
      "visuals": "Static camera, wide shot from across the street",
      "action": "The woman in the red scarf walks in from the left, stops under the streetlamp",
      "effects": "Rain picks up halfway through; neon reflections ripple in puddles",
      "audio": "[Sound Effect] rain, distant traffic. [Speaker] Alice (soft): \"We're here.\"",
      "visibleCharacters": ["alice"]
    },
    "firstFramePath": "<project>/path/from/assets.json.png", // optional for asset-only shots
    "lastFramePath": "<project>/optional.png",
    "referenceAssets": [
      { "modality": "image", "assetId": "asset-avatar-from-current-account" },
      { "modality": "audio", "assetId": "asset-voice-from-current-account" }
    ],
    "durationSec": 5
  }]
}
```

The plugin assembles each shot's labeled prompt (`[Style]` / `[Character]` / `[Scene]` / `[Visuals]` / `[Action]` / `[Effects]` / `[Audio]` + consistency and negative directives) — never pre-join a prompt string yourself. Validation fails the run before any paid call when: `visuals`/`action` are empty, `visibleCharacters` references an id missing from `characters`, or a shot without `firstFramePath` lacks `style`/`scene` (a frameless request must not go out action-only, including an asset-only request). Film-level `style`/`consistency`/`negative` apply to every shot — write them once; shot-level `scene` repeats per shot even when consecutive shots share a location (each shot is submitted independently).

Every reference-frame path that is present must resolve to a regular png/jpg/webp file inside the session cwd. Absolute paths are accepted only when they remain inside that approved project directory; symlinks and outside paths are rejected. `referenceAssets` are provider-managed and are not local files. Keep their order stable: changing an asset, modality, or order changes the request and requires a new job directory and paid confirmation.

Then call `video_render` with that path. Interrupted? Call it again with the same path — it resumes. If an ambiguous submit is reported, do not delete a shot or call render again blindly: run `/video-gen recover <jobId>`, check the provider console, then explicitly `reset` a confirmed-absent task or `adopt` its task id. Revisions? New job directory.
