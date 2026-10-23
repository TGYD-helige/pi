# Shot planning and frame preparation

Use a shot book when narrative continuity benefits from one. Author it in conversation; save `project.json` beside the editable source, outside generated job directories, when the project needs an editable planning record.

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

- **Give each story shot a purpose** (establish / emotion / reaction). Choose framing to serve that purpose; use close-ups for emotion and wide shots for context when appropriate.
- **Keep dialogue within the selected model's duration and audio support.** Character names in `intent` may be wrapped in angle brackets: `<Alice>`.
- **firstFrame / lastFrame are pure static snapshots** — no ongoing actions ("he is sitting, leaning forward", NOT "he is about to stand"). Include shot size, angle, composition, who is where and facing which way.
- **visuals = camera + framing only** (movement, shot size, angle, focus); **action = in-frame movement only**. Split them — they become separate labeled sections in the assembled prompt. Refer to characters by visible traits ("the woman in the red scarf"), never by name.
- **scene is the shot's setting**, copied verbatim into the render spec's `prompt.scene`. Optional when the first frame fully anchors the setting; write it when the setting carries mood/lighting the frame may not convey.
- **effects is for what a static frame cannot carry**: transformations, lighting/atmosphere shifts, particles, slow motion. Omit when the shot is visually static.
- **lastFrame needed when**: composition/focus changes drastically, a character enters or turns to face camera, a major reveal happens. Otherwise omit it.
- **Use `continuityGroup` where shots share a space or visual base.** Start a new group when the setting or camera relationship warrants it.
- **continuityGroup** = shots sharing a space/base image; **startFrameFromShotId** pins a specific parent frame for composition; **continuityNote** says what the parent frame lacks (the frame prompt must then keep the background and replace those elements). Self-check: parent shot EXISTS, comes EARLIER, same continuityGroup, no cycles.
- **audio** uses `[Sound Effect] …` / `[Speaker] Name (Emotion): "line"` format.
- **durationSec and all capability values come from `video_capabilities`** — never from memory or this document. Durations, resolutions, ratios, audio and frame support differ per model and change over time.
- **Behavioral quirks worth knowing** (still verify with `video_capabilities`): some models have no native audio (omit audio cues or the render is silent); some cannot do last-frame interpolation (never pass lastFrame to them); HappyHorse takes a first frame OR reference images in one call, not both — cite references in the prompt as `[Image 1]`, `[Image 2]`, …

## Frame preparation (via `image_generate`)

When a shot book needs missing character portraits or first/last frames, call `image_generate` to create those images before `video_render`. Follow the **pi-image-gen skill** for parameters, sizes, `n`, and edit labeling; it is the single authority. Two video-specific handoff rules:

- **Never assume a saved filename**: the actual extension follows the MIME type and collisions get `-v2`. **The returned absolute path is the only truth** — record it immediately in `assets.json` (see below) and reference it in the render spec.
- `assets.json` in the job dir: `{ "assets": { "<shotId>/<part>": { "sourcePath": "…" } } }` mapping semantic assets (e.g. `s1/firstFrame`, `alice/front`) to real paths.

**Character portrait views (generate only those the planned frames need)**:

- front (text-to-image): `Generate a full-body, front-view portrait of character {identifier} based on the following description, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Gazing straight ahead. Standing with arms relaxed at sides. Natural expression. Features: {appearance}; {outfit}. Style: {style}`
- side (edit with front as reference): `Generate a full-body, side-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Facing left. Standing with arms relaxed at sides.`
- back (edit with front as reference): `Generate a full-body, back-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. No facial features should be visible.`

If an optional side/back view fails after one retry, reuse an existing suitable view. Characters with `visible: false` get no portraits.

**Reference selection for frames**: candidates = portraits of visible characters (ONE view each, chosen by facing) + continuity frames. Pick a SMALL set of the most relevant ones — same camera/group first, most recent frames first, drop redundant near-duplicates, prefer the portrait when a character newly appears. How many images a call accepts is pi-image-gen's authority (its skill/tool description), not this document's.

**Frame prompt assembly**: prefix each reference image with its role, then the frame description mapping elements to images:

```
Image 1: A front view portrait of Alice.
Image 2: [alley] Wide shot of the rainy alley from shot s1.
Create an image based on the following description: <firstFrame text>. The alley background should reference Image 2; Alice's appearance should reference Image 1.
```
