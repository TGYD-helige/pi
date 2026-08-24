---
name: image-gen
description: "Generate or edit raster images with the image_generate tool: photos, illustrations, textures, sprites, product/UI mockups, concept art, or image-to-image edits. Use when the deliverable is a bitmap asset. Do NOT use for icons, logos, diagrams, or UI graphics that should be repo-native SVG/vector/CSS/canvas — edit or write those directly."
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

## Two questions before every call

1. **Intent — generate or edit?**
   - No `image`, or `image` entries used only as style/composition/mood references → **generate**.
   - Modify an existing image while preserving most of it → **edit** (pass that image).
   - When unsure, assume the user wants a new image unless they clearly ask to change an existing one.
2. **Strategy — one asset or many?**
   - `n` produces **variants of ONE prompt**, not distinct assets.
   - For several *different* assets, make **one `image_generate` call per asset**, each with its own prompt. Do not raise `n` to cover distinct subjects.

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
Text (verbatim): "<exact text>"
Constraints: <must keep / must avoid>
```

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

Start from a clean base prompt, then make **one targeted change at a time** and re-check subject, style, composition, text accuracy, and invariants. Prefer a single focused follow-up over rewriting the whole prompt.

## Parameters

- `prompt` (required) — what to draw or how to edit.
- `image` — array of reference/target image paths or URLs.
- `n` — 1–8 variants of the one prompt (default 1).
- `size` — e.g. `"1024x1024"`. Provider-specific; some models require a minimum (Seedream ≥ 4.5 needs 2K+, so `1024x1024` fails there).
- `quality` — one of `"low"` / `"medium"` / `"high"` / `"auto"` (`"low"` for fast drafts/thumbnails, `"high"` for final assets or dense text). This parameter is **provider-conditional**: it only exists in the tool schema for a built-in gpt-image route — the built-in OpenAI provider on a `gpt-image-*` model, or an OpenRouter route whose model id is gpt-image (e.g. `openrouter/openai/gpt-image-2`). It is absent for Gemini, DashScope/Qwen, Ark/Seedream (Seedream varies quality by `size` resolution tier instead), for non-gpt-image routes like `openai/dall-e-3` or an OpenRouter route to a non-OpenAI model, and for any custom provider — even OpenAI-compatible ones, since their quality vocabulary may differ (e.g. DALL·E 3 uses `standard`/`hd`). If you don't see a `quality` parameter, the active provider has no such knob; do not try to force it.
- `filename` — output filename prefix (no extension). Reusing a name does not overwrite an earlier file — a sibling `-v2` is written instead.
- `outputDir` — override the configured output dir for this call.

## Reporting results

The tool result already contains a copy-pasteable markdown line per image (`![alt](/abs/path.png)`). Render each generated image inline in your reply so the UI can display it — do not paste the bare path. Always report the final saved path(s).
