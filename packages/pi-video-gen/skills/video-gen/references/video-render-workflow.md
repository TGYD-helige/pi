# Render script and recovery

Create `<outputDir>/<jobId>/render-input.json`. The job ID and each shot ID use letters, digits, dash or underscore. The parent directory is the immutable job. Use `video_generate` directly when batch automation and recovery are unnecessary.

```json
{
  "title": "Mixed product film",
  "style": "cinematic product demo",
  "shots": [
    {"id":"opening","prompt":{"visuals":"static medium shot","action":"presenter lifts the product"},"firstFramePath":"/absolute/path/opening.png","durationSec":5},
    {"id":"demo","videoPath":"/absolute/path/demo.mp4"}
  ],
  "assembly": {"type":"remotion","projectDir":"/absolute/path/project","compositionId":"Promo"}
}
```

Each shot has exactly one source. `videoPath` uses a local video and has no prompt, frame, reference asset or duration fields. A generated shot requires `firstFramePath` or a nonempty `referenceAssets` array, plus a structured `prompt` with `visuals` and `action`. `lastFramePath` requires `firstFramePath`. When using provider-managed reference assets without a first frame, also supply film-level `style` and shot-level `scene`; those prompt fields do not replace the visual input. The plugin snapshots local inputs, records remote task handles immediately and does not submit paid work again when resuming a finished shot.

`assembly` is optional. Without it, clips are concatenated in shot order. For a local FFmpeg timeline, use `{"type":"timeline","timeline":{"segments":[{"id":"a","shotId":"opening","durationSec":5},{"id":"b","shotId":"demo","durationSec":5}]}}`; timeline segments may also carry supported overlay, narration and transition fields. Every segment must refer to an existing shot ID and must not supply a separate `video` or `image`. For Remotion, pass `projectDir`, `compositionId`, optional `entryPoint`, `inputProps`, `assets` and `browserExecutable`. The plugin supplies a `videoGenAssets` map keyed by shot ID and merges extra assets with distinct IDs.

Before the first paid submit, the script checks all shot references, existing media, model capabilities and assembly environment. Remotion additionally bundles the project with placeholder video, selects the composition and renders frame zero. This does not prove that the eventual generated codec or duration is compatible; downloaded clips are checked again. If assembly fails after generation, rerun the same script after fixing the environment. The saved shot files and handles remain; changing frozen project source, original public resources, existing assets or the script requires a new job.

Approval is scoped to the generated shots, provider/account, model and duration. Reuse an existing approval only for the same scope. On ambiguous remote submission, inspect the provider console, then use `/video-gen recover <jobId> <shotId> reset` only when the task is confirmed absent or `adopt <taskId>` when found. Cancellation stops local work and may not cancel provider billing. A legacy completed manifest without a saved final SHA-256 cannot verify the old film; compose its saved clips in a new job directory.

## Generated-shot example

Write `<outputDir>/<jobId>/render-input.json` (jobId: letters/digits/dash/underscore). This is a generated-shot example; for local `videoPath` shots and optional Timeline or Remotion assembly, use the mixed-source and assembly rules above:

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

The plugin assembles each shot's labeled prompt (`[Style]` / `[Character]` / `[Scene]` / `[Visuals]` / `[Action]` / `[Effects]` / `[Audio]` + consistency and negative directives) — never pre-join a prompt string yourself. Validation fails before any paid call when: a generated shot has neither `firstFramePath` nor `referenceAssets`, `visuals`/`action` are empty, `visibleCharacters` references an id missing from `characters`, or a shot without `firstFramePath` lacks `style`/`scene`. Film-level `style`/`consistency`/`negative` apply to every shot — write them once; shot-level `scene` repeats per shot even when consecutive shots share a location (each shot is submitted independently).

Every reference-frame path that is present must resolve to a regular png/jpg/webp file inside the session cwd. Absolute paths are accepted only when they remain inside that approved project directory; symlinks and outside paths are rejected. `referenceAssets` are provider-managed and are not local files. Keep their order stable: changing an asset, modality, or order changes the request and requires a new job directory and paid confirmation.

Then call `video_render` with that path. Interrupted? Call it again with the same path — it resumes. If an ambiguous submit is reported, do not delete a shot or call render again blindly: run `/video-gen recover <jobId>`, check the provider console, then explicitly `reset` a confirmed-absent task or `adopt` its task id. Revisions? New job directory.
