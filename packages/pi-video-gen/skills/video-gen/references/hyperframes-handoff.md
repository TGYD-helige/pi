# HyperFrames handoff

Default new editable UI, typography, chart and product animation to HyperFrames. Honor an existing or explicitly requested [Remotion project](remotion-handoff.md). Use a standalone project inside the trusted working directory; keep editable source and local media outside the configured video output directory. Install the verified CLI in that project with `npm install --save-exact hyperframes@0.9.26`. Use the plugin's FFmpeg and an installed browser. Explicit `browserExecutable` or `HYPERFRAMES_BROWSER_PATH` wins; otherwise the plugin checks `hyperframes browser path` for an already-installed CLI browser before trying system Chrome/Chromium. Prefer the CLI's headless shell when GUI Chrome produces clipped exports. Provision it separately with `npx --no-install hyperframes browser ensure` before the tool call if needed. Tool calls do not install dependencies or download a browser.

## Author and preview

Read the [official authoring guide](https://github.com/heygen-com/hyperframes#how-it-works) and the installed CLI's help before authoring. Use HTML/CSS and seekable animation: declare a root `data-composition-id`, `data-width`, `data-height`, `data-duration` and optionally `data-fps`. Set clip timing with `data-start`, `data-duration` and `data-track-index`. Register a paused GSAP timeline in `window.__timelines[compositionId]`, or follow the official adapter contract for another animation engine. Wall-clock timers and unseeded randomness do not define reproducible video frames.

Use local fonts, scripts and media for reproducible offline rendering. Vendor browser libraries into the project; browser asset URLs should not depend on `node_modules`, which is excluded from snapshots. Keep the project small and dedicated to the film. The plugin snapshots its files, excluding root `node_modules`, `.git` and the configured video output directory. Symlinks in source/resources and the reserved `__pi_video_gen__/` directory are rejected. Remote resources and mutable dependencies are not frozen by the plugin's hashes.

Run `npx --no-install hyperframes lint`, `npx --no-install hyperframes preview`, and `npx --no-install hyperframes snapshot --at 0,2,4 --no-end` in the project to review key moments before the full export. For a creative film, follow [film direction](film-direction.md) and [motion authoring](motion-authoring.md).

## Compose

Write `<outputDir>/<jobId>/hyperframes-input.json`:

```json
{"projectDir":"/absolute/path/html-project","durationSec":10,"assets":{"demo":"/absolute/path/demo.mp4"},"qcTimesSec":[3.8,4,4.2]}
```

Call `video_compose({"composeSpecPath":".../hyperframes-input.json"})` or `/video-gen compose <spec>`. `entryPoint` optionally selects a project-relative HTML file; default `index.html`. `durationSec` is positive and must match the HTML composition and encoded video duration. `qcTimesSec` has at most 32 finite non-negative times strictly within that duration. `compositionId` and `inputProps` are Remotion concepts; edit HTML for HyperFrames content changes.

The plugin copies `assets` into a job-owned project snapshot and injects same-origin URLs in `window.videoGenAssets`, keyed by asset ID. Read them when authoring media, for example:

```html
<video id="demo" class="clip" data-start="0" data-duration="5" data-track-index="0" muted playsinline></video>
<script>document.getElementById('demo').src = window.videoGenAssets.demo;</script>
```

Existing relative project resources keep their paths. The injected asset namespace is reserved. The CLI runs against the snapshot; original HTML and assets remain editable. Each render has a 20-minute deadline including CLI startup; cancellation stops the renderer process tree. There is no fallback to a paid video model or another assembly engine.

## Batch assembly and recovery

For `video_render`, add:

```json
{"assembly":{"type":"hyperframes","projectDir":"/absolute/path/html-project","durationSec":10,"shotTimesSec":{"opening":2,"demo":7}}}
```

A project assembly with no `type` also selects HyperFrames. Omitting `assembly` retains ordered concat. Supply `shotTimesSec` for every shot ID, choosing a time where that shot is visible in the final film. These are authored seconds, not inferred clip durations or measured speech alignment. Keep them synchronized with HTML timing. Additional `assembly.assets` must use IDs distinct from the shots. All shot clips become available through `window.videoGenAssets` after download.

Before a paid submit, preflight checks the project and renders frame zero with browser-playable placeholders. It verifies that sample times are within the declared duration; after assembly the encoded duration is checked again. Preflight does not establish that a shot is visible or that the film is visually correct. Preserve the project, saved remote handles and frozen clips for recovery. A revised source, spec or asset requires a new job directory; rerunning the same input verifies hashes and resumes without resubmitting finished shots.

## Review and delivery

The plugin returns the final MP4, editable project directory, `qcFrames` and `qcReportPath`. It samples beginning/middle/end and requested moments from the encoded MP4, stores evidence hashes, and verifies them on resume. Batch QC also samples `shotTimesSec` and links the project evidence under `hyperframes`. Missing or modified committed evidence fails rather than being silently regenerated.

Inspect the returned frames and review motion and sound in the actual export when available. `qcStatus: "recorded"` means evidence exists; it does not establish visual, motion or audio acceptance. Return the absolute MP4 path and editable project path, and state any unreviewed modality. HyperFrames is Apache-2.0; asset, font and third-party library licenses remain their own.
