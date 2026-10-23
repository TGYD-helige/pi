---
name: video-gen
description: "Create or edit videos using existing media, video models, FFmpeg timelines or Remotion. Use for clips, video assembly, product films and animated explainers; use image-gen for still-image deliverables."
---

# Video generation

Choose each shot's source independently: existing media, a model-generated clip, or graphics in an editable Remotion project. Name the executable tool at each handoff. The video model comes from `pi-video-gen.defaultModel`; image generation uses pi-image-gen's active model. `<outputDir>` is the configured `pi-video-gen.outputDir`, defaulting to `<cwd>/.video-gen`; `/video-gen doctor` reports its resolved path.

## Route the task

Honor the user's specified method and existing usable material. Read only the relevant assembly guide:

| Goal | Tool and reference |
|---|---|
| Join compatible MP4 clips without re-encoding | `video_compose`; follow Compatible clip concat below |
| Create one or several model clips under direct control | `video_generate`; follow Direct model clips below; use `video_compose` if assembly is needed |
| Assemble images/screenshots and clips with overlays, transitions or narration | `video_compose`; read [Timeline composition](references/timeline-compose.md) |
| Animate exact UI, charts, typography or editable graphics | `video_compose`; read [Remotion handoff](references/remotion-handoff.md) |
| Execute a prepared batch with saved remote tasks and optional assembly | `video_render`; read [render script and recovery](references/video-render-workflow.md), plus the selected assembly guide |

For a product film, demonstration, capability showcase or authored explainer, read [film direction](references/film-direction.md) before designing scenes. An explicitly supplied edit, single clip or straightforward assembly follows its supplied instructions without that planning stage. For continuous UI/graphic handoffs, film direction routes to the motion-authoring guide. Read [shot planning and frame preparation](references/shot-planning.md) only when recurring identities, narrative continuity or missing reference frames require it.

## Execution rules

- **Preserve scope.** Reuse suitable assets; generate or replace images when needed or explicitly requested. Use `image_generate` for those images and read the installed image-gen skill before using it. If it is unavailable, disclose the gap and continue only with suitable existing material or an agreed alternative. Any user restriction on generation charges also applies to image calls.
- **Model preflight.** Before preparing new generated-video requests, call `video_capabilities` and respect the active model's durations, ratios, audio, frame and trusted-asset support. Local-only work needs no video-model credentials or capability call. For Seedance recognizable portraits or provider-managed portrait/material choices, read [Seedance assets](references/seedance-assets.md) before selecting inputs or preparing a paid call.
- **Paid scope.** Before the first paid video call, state the generated shot count and durations, provider/account, model and exact asset choices. Obtain approval unless that exact scope is already authorized; reuse approval for unchanged resumes using the saved job identity. A material scope change needs agreement. A prepared batch uses one initial `video_render` call per requested version; resume the same spec after interruption. Additional prototypes or versions must serve the requested task.
- **Cost.** State call counts and durations. If the user requests prices, verify current provider pricing and state the assumptions; if pricing cannot be verified, say so rather than guessing. Do not promise a fixed completion time.
- **Immutable jobs.** Revised inputs or frozen project source require a NEW job directory. Rerunning the SAME spec resumes completed shots without resubmitting them. Preserve saved clips and remote handles; never delete shot outputs to force a retry. Missing or changed committed artifacts fail integrity checks rather than being silently regenerated.
- **Degradation.** When a capability or preflight check fails, explain supported alternatives and obtain agreement for a materially changed result. Omit unsupported native-audio cues; if requested audio would be lost, resolve that gap before generation. Narration uploads and silent-subtitle fallbacks follow the Timeline guide's disclosure and agreement rules.
- **Cancellation.** Stopping local polling/rendering may leave a remote task running and billable; Ark remote cancellation is unverified. Report that limitation.

## Compatible clip concat

1. **Tell the user first**: clip count, order, output location (`<jobDir>/final_video.mp4`), `mode: "copy"`. This is LOCAL compute — do not use the paid-model confirmation script for it.
2. Write `<jobDir>/compose-input.json` (`{"clips":[{"id":"c1","path":"/abs/a.mp4"},…],"output":{"mode":"copy"}}`) under the video-gen output dir, then call `video_compose` ONCE. Keep source clips outside `<jobDir>/clips/`; that directory and `final_video.mp4` are reserved pipeline outputs, and a fresh job refuses either conflict.
3. **Only promise** lossless concat of compatible MP4s (C0). **Never promise** trimming, transitions, overlays, subtitles, TTS, BGM, or re-encoding **for the C0 path** — those live in [Timeline composition](references/timeline-compose.md), not here; do not hint at them for `compose-input.json`.
4. On any ordered stream incompatibility across all tracks (codec/resolution/fps/timebase/pix_fmt/sample-rate/audio layout), hand the exact ffprobe differences back to the user/agent: re-encode the odd clips first. NEVER silently transcode, and NEVER fall back to `video_generate`/`video_render` as a workaround.
5. Interrupted? Rerun the SAME path (fingerprint-verified resume / cached). Changed clips or order? NEW job directory. A completed final video is hash-bound; if it is missing or changed, restore the exact artifact or start a NEW job.

## Direct model clips

1. Complete model preflight and any applicable Seedance asset checks above. Use the active tool schema.
2. Fill structured prompt fields: `visuals` describes camera/framing, `action` in-frame movement, `scene` the setting, `effects` time-varying appearance, and `audio` sound/dialogue. `visuals` and `action` are required; without `firstFrame`, `style` and `scene` are also required. The tool assembles the prompt.
3. Generate requested/missing source frames through `image_generate`, recording its returned paths. Confirm the exact paid-video scope if not already authorized.
4. Call `video_generate` for each missing clip. Resume an interrupted clip with its returned `jobId`; `prompt` is not needed on resume. An ambiguous submit requires checking the provider console and `/video-gen recover <jobId>`: `reset` only a confirmed-absent task or `adopt` its existing task ID. Do not blindly resubmit. Choose the appropriate local assembly path if needed.
5. Inspect the returned saved video or available QC evidence and report its path, accepted degradation and any verification limitation.

## Completion

Before reporting success, verify the requested clip/segment count and order, review the actual exported version or available QC evidence, and return the absolute output path plus any editable project and accepted limitations. Complete the selected assembly guide's checks. For creative films, apply film direction's delivery review and revision rules and report separately what was checked in stills, motion and audio. A successful render or recorded QC is evidence, not visual or user acceptance.
