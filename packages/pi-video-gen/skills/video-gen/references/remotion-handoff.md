# Remotion handoff

Use Remotion when the work needs exact text, UI, charts, editable React animation or frame control. Write an ordinary local Remotion project with an entry that calls `registerRoot()`. Install matching `remotion`, `@remotion/bundler`, `@remotion/renderer`, React and React DOM in that project. Provide an installed Chrome or Chromium binary through `browserExecutable` or `REMOTION_BROWSER_EXECUTABLE`. The plugin does not install packages or download a browser during a tool call.

Write `<jobDir>/remotion-input.json` and call `video_compose({"composeSpecPath":".../remotion-input.json"})`:

```json
{"projectDir":"/absolute/path/remotion-project","compositionId":"Promo","assets":{"demo":"/absolute/path/demo.mp4"},"inputProps":{"title":"Product"}}
```

The project must be inside the trusted working directory. Set `entryPoint` to a project-relative file when the usual `src/index.ts`, `src/index.tsx`, `src/index.js` or `src/index.jsx` is missing or ambiguous. `assets` paths stay on the Node side. The plugin copies the project's original `public/` tree into the job snapshot, keeps relative paths such as `logo.png` and `fonts/brand.woff`, then copies injected assets into reserved `__pi_video_gen__/`. If the original public tree already uses this namespace, the call fails without overwriting it. The plugin passes `videoGenAssets: { demo: "__pi_video_gen__/demo.mp4" }` in `inputProps`; the composition uses `staticFile(videoGenAssets.demo)`. Ordinary `staticFile('logo.png')` and font references continue to work.

Treat the configured video output directory as generated artifacts. Keep the Remotion entry and every source file it imports outside that directory; it is excluded from the frozen project fingerprint so sibling jobs cannot invalidate one another. The entry is checked and rejected if it is inside the output directory. Do not configure video output inside the project's `public/` tree.

For `video_render`, use `assembly.type: "remotion"` with the same project fields. Every shot ID appears in `videoGenAssets` after download, and additional `assembly.assets` may be supplied under distinct IDs. Before a paid submission, the plugin builds a temporary public snapshot with browser-playable placeholder video and renders one frame. After download it rebuilds the snapshot with actual clips. Original project source, dependency files and original `public/` content are frozen separately from generated clip hashes; adding generated clips does not invalidate the paid input fingerprint.

For batch `video_render`, the selected composition must expose `props.videoGenShotTimesSec`, a map from every shot ID to a time in seconds where that shot is visible in the finished film. Set it in `defaultProps` for a fixed edit, or return it from `calculateMetadata` when timing depends on the actual clips. The plugin checks the map during the placeholder preflight, then reads the actual map after rendering and extracts final QC frames at those times. The values must be finite and within the composition duration. Direct `video_compose` does not need this map.

The final MP4 and assembly manifest live under `<jobDir>/assembly/` for `video_render`; direct `video_compose` writes them in its own job directory. Preserve the Remotion project as an editable deliverable. Inspect actual frames after rendering; a successful bundle and media probe do not establish visual correctness.

## Review moments and sound

`remotion-input.json` and `assembly.type: "remotion"` accept optional `qcTimesSec`, an array of at most 32 finite, non-negative times in seconds. Each must be strictly less than the selected composition duration; batch preflight checks this before model submission, and the export is checked again. For a handoff at 4 seconds, for example, use `"qcTimesSec": [3.8, 4, 4.2]`. See [motion authoring](motion-authoring.md) for how to select these times.

New renders automatically extract beginning, middle and ending samples from the encoded MP4, plus the requested times, sorted and deduplicated. They return `qcFrames` and `qcReportPath`; the report records video-track duration, sample times and final video SHA-256. Batch `video_render` includes these frames alongside its shot samples; its QC report links the Remotion frame list and SHA-bound report under `remotion`. Frame/report hashes join the Remotion manifest and are verified on resume. Missing or changed evidence fails instead of silently regenerating it. Historical manifests without QC hashes resume with no recorded QC; create a new job to obtain evidence. `qcStatus: "recorded"` means evidence exists, not that the film passed visual, motion or audio review.

Keep `videoGenShotTimesSec` for the existing batch shot-visibility contract. `qcTimesSec` supplements that contract with handoff and reading checks and does not replace it. The plugin does not inspect object identity or automatically assign a continuity score.

For frame-derived animation, persistent carriers and shared picture/sound timing, follow [motion authoring](motion-authoring.md). Existing audio can be passed through `assets` and read with `staticFile(videoGenAssets[id])`; author gain changes and clip placement in the project. This does not add timed audio or dynamic ducking to FFmpeg Timeline.

The [continuous motion film](../examples/continuous-demo/README.md) is an editable 26-second project: one persistent preview travels through material collection, a full-frame shot, an editing timeline, separated picture/text/audio planes, a review view and a closing play mark. Shared event times drive both motion landings and the locally synthesized score. Its UI illustrates the workflow rather than an editor supplied by the plugin.

Remotion has its own [license terms and FAQ](https://www.remotion.dev/docs/license/faq). The project owner should check the applicable terms before using this path in commercial automation. The plugin does not bundle Remotion code.
