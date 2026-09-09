---
name: image-gen
description: "Prompting workflow for image_generate when generating or editing raster images such as photos, illustrations, textures, sprites, mockups, concept art, or image-to-image edits. Use when the deliverable is a bitmap asset; keep repo-native SVG/vector/CSS/canvas work in source form."
---

# Image generation

This skill guides use of the `image_generate` tool from `@amaster.ai/pi-image-gen`. The active model is fixed by `pi-image-gen.defaultModel` in settings — the tool has **no `model` parameter**. Run `/image-gen list` to see the active model, its provider, and whether its API key is set.

## When to use

- A brand-new bitmap image: concept art, product shot, cover, website hero, texture, sprite.
- A new image guided by one or more reference images (style, composition, mood, subject).
- Editing an existing image: inpainting, background replacement, object removal, lighting or weather changes, compositing, style transfer, character preservation.
- Several assets or variants for one task.

## When NOT to use

- Extending or matching an existing SVG/vector icon set, logo system, or illustration library in the repo — edit those source files directly.
- Simple shapes, diagrams, wireframes, or icons better produced in SVG, HTML/CSS, or canvas.
- A small project-local asset edit when the source already exists in an editable native format.
- Any task where the user clearly wants deterministic code-native output, not a generated bitmap.

## Before every call

Use only parameters and values exposed by the current `image_generate` schema.

1. **Intent — generate or edit?**
   - No `image`, or `image` entries used only as style/composition/mood references → **generate**.
   - Modify an existing image while preserving most of it → **edit** (pass that image).
   - When unsure, assume the user wants a new image unless they clearly ask to change an existing one.
2. **Strategy — one asset or many?**
   - `n` produces **variants of ONE prompt**, not distinct assets.
   - For several *different* assets, make **one `image_generate` call per asset**, each with its own prompt. Do not raise `n` to cover distinct subjects.
3. **Inputs — what must the prompt preserve?** Collect exact text, constraints/avoid items, and every input image's role. Ask only when a missing detail blocks a usable result; otherwise proceed.

Inspect input images with an available image-viewing tool before describing their details or deciding what to preserve. If viewing is unavailable, rely on the user's description and disclose that limitation.

## Prompt structure

Order the prompt as: **scene/backdrop → subject → key details → constraints → intended use.** For complex requests, use short labeled lines instead of one long paragraph:

```text
Use case: <e.g. product-mockup, ui-mockup, illustration, photorealistic, concept-art>
Asset type: <where the asset will be used>
Primary request: <the main ask>
Input images: <Image 1: role; Image 2: role>   (only when passing `image`)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo / illustration / 3D / etc.>
Composition/framing: <wide / close / top-down; placement; negative space if needed>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep / must avoid>
```

The labels are scaffolding, not a required form. Keep only the lines that materially improve the request.

Describe visible choices rather than relying on mood words alone: framing, scale, materials, and light direction. For people, clarify gaze, pose, and interaction with objects when relevant. For website assets, derive crop and text-safe space from the actual layout; for photorealism, request a photograph and relevant real-world texture explicitly.

## Specificity policy

- If the user's prompt is already **specific and detailed**, normalize it into a clean spec — do not add creative requirements it didn't ask for.
- If the prompt is **generic**, add tasteful detail only when it materially improves output.

Allowed augmentation: composition/framing cues, polish-level or intended-use hints, practical layout guidance, reasonable scene concreteness. Do **not** add: extra characters/props not implied, brand palettes/slogans/story beats not implied, or arbitrary left/right placement the layout doesn't support.

## Text inside images

- Put literal text in quotes, preserving its language, capitalization, and punctuation; specify typography (style, size, color, placement).
- State how many times each string should appear and whether extra text is allowed; for exact-copy tasks, use only the supplied wording.
- Spell uncommon words letter-by-letter when accuracy matters; require verbatim rendering.
- Where the model exposes a quality knob, test a higher supported `quality` when small text, dense infographics, legends, axes, or multi-font layouts have observed legibility problems.

## Editing and multi-image conditioning

- Label every input image by index and role: `Image 1: edit target`, `Image 2: style reference`. Do not assume every provided image is an edit target.
- For edits, state invariants explicitly — `change only X; keep Y unchanged` — and **repeat them on every iteration** to reduce drift.
- For pixel-identical preservation, use deterministic editing or composite the accepted edit into the original while preserving untouched pixels; prompting alone cannot guarantee this.
- For a series, reuse an accepted character or product reference and state the features shared across assets.
- For compositing, describe how images interact: `place the subject from Image 2 into Image 1; match lighting, perspective, and scale`.
- To iterate on a previous result, pass its saved file path back as `image` when it is inside cwd.
- Reference images must be a **regular image file inside cwd** (absolute or relative path) or a **public http(s) URL**. Symlinks, Base64, and `data:` URIs are rejected — write bytes to a file under cwd first.

## Iterate deliberately

Start from a clean base prompt, then make **one targeted change at a time**. After each output, inspect the subject, style, composition, text accuracy, and edit invariants before reporting success or iterating. Prefer a single focused follow-up over rewriting the whole prompt.

Open each output with an available image-viewing tool before judging it; a saved path alone does not establish inspection. Report unmet or unverified requirements when inspection or correction is unavailable. For information graphics, check factual relationships as well as labels; for transparent assets, inspect the actual alpha channel and edges rather than assuming a checkerboard means transparency. Base each correction on an observed defect, preserve satisfied details, and stop when the requested criteria pass.

When a quality control is available, start with the default or requested setting. Adjust it for observed problems while keeping the prompt and other settings fixed for comparison; final delivery alone does not require a higher setting.

## Reporting results

The tool result already contains a copy-pasteable markdown line per image (`![alt](/abs/path.png)`). Render each generated image inline in your reply so the UI can display it — do not paste the bare path. Always report the returned saved path(s); filename collisions may change the actual filename.

Use the user's destination when provided. For project-bound assets, save or copy every selected final into the project and update consuming references when integration is requested; preview-only outputs may remain at the tool's output location. Preserve existing assets with sibling filenames unless replacement was requested, and preserve alpha when converting transparent images. If an output is relocated, use its verified final path in the image link.
