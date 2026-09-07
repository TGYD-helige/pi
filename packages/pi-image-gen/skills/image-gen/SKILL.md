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

1. **Intent — generate or edit?**
   - No `image`, or `image` entries used only as style/composition/mood references → **generate**.
   - Modify an existing image while preserving most of it → **edit** (pass that image).
   - When unsure, assume the user wants a new image unless they clearly ask to change an existing one.
2. **Strategy — one asset or many?**
   - `n` produces **variants of ONE prompt**, not distinct assets.
   - For several *different* assets, make **one `image_generate` call per asset**, each with its own prompt. Do not raise `n` to cover distinct subjects.
3. **Inputs — what must the prompt preserve?** Collect exact text, constraints/avoid items, and every input image's role. Ask only when a missing detail blocks a usable result; otherwise proceed.

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

## Specificity policy

- If the user's prompt is already **specific and detailed**, normalize it into a clean spec — do not add creative requirements it didn't ask for.
- If the prompt is **generic**, add tasteful detail only when it materially improves output.

Allowed augmentation: composition/framing cues, polish-level or intended-use hints, practical layout guidance, reasonable scene concreteness. Do **not** add: extra characters/props not implied, brand palettes/slogans/story beats not implied, or arbitrary left/right placement the layout doesn't support.

## Text inside images

- Put literal text in quotes or ALL CAPS; specify typography (style, size, color, placement).
- Spell uncommon words letter-by-letter when accuracy matters; require verbatim rendering.
- Where the model exposes a quality knob, use a higher `quality` for small text, dense infographics, legends, axes, and multi-font layouts.

## Editing and multi-image conditioning

- Label every input image by index and role: `Image 1: edit target`, `Image 2: style reference`. Do not assume every provided image is an edit target.
- For edits, state invariants explicitly — `change only X; keep Y unchanged` — and **repeat them on every iteration** to reduce drift.
- For compositing, describe how images interact: `place the subject from Image 2 into Image 1; match lighting, perspective, and scale`.
- To iterate on a previous result, pass its saved file path back as `image`.
- Reference images must be a **file path** (absolute or relative to cwd) or an **http(s) URL**. Base64 and `data:` URIs are rejected — write bytes to a file first.

## Iterate deliberately

Start from a clean base prompt, then make **one targeted change at a time**. After each output, inspect the subject, style, composition, text accuracy, and edit invariants before reporting success or iterating. Prefer a single focused follow-up over rewriting the whole prompt.

## Parameters

Use only parameters exposed by the current image_generate schema; its descriptions are the authority for the active model's values, reference limits and count limits.

- `prompt` describes the image or edit; `image` supplies labeled targets/references.
- When `n` is offered, it requests variants of one prompt within the current model's documented limit. Distinct assets still require separate calls.
- Set `size` only when offered. Models with `aspectRatio` and optional `imageSize` use those instead; copy supported values from the schema.
- Use `quality` only when offered: lower for drafts, higher for final assets or dense text. Resolution tiers and quality are different controls.
- `filename` is a prefix without an extension; collisions produce a sibling such as `-v2`. Use the returned paths.
- `outputDir` overrides the configured directory for this call.

## Reporting results

The tool result already contains a copy-pasteable markdown line per image (`![alt](/abs/path.png)`). Render each generated image inline in your reply so the UI can display it — do not paste the bare path. Always report the final saved path(s).
