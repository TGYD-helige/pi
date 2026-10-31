# @amaster.ai/pi-attachments

![pi-attachments preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-attachments/preview.png)

Pi extension that intercepts user input, resolves `@`-references to local resources, and injects their content into the prompt before the model sees it.

Hooks the `input` event of `@earendil-works/pi-coding-agent`. When a recognized mention appears in the user message, the original mention is stripped and replaced with structured context (skill block, attachment listing, or `<system-reminder>`). Image attachments are passed through as multimodal `ImageContent`.

## Recognized mentions

| Syntax                          | Resolves to                                                       |
|---------------------------------|-------------------------------------------------------------------|
| `@path/to/file.ts`              | File contents (text/doc) or base64 image                          |
| `@"/path with spaces/file.pdf"` | Same as above, supports whitespace in paths                       |
| `@path/to/file.ts#L10-20`       | Line range syntax preserved in the reference (range applied downstream) |
| `@path/to/dir`                  | Directory listing (files + subdirs, ignores `.git`/`node_modules`/build outputs) |
| `@skill:<name>`                 | Loads `SKILL.md` for a registered skill                           |

`@http(s)://...` is **not** treated as a file reference. Unknown namespaces (e.g. `@app:erp-prod`) are left alone — neither resolved as a skill nor as a file.

## Skill resolution

`@skill:<name>` searches in this order, first hit wins:

1. `<cwd>/.pi/skills/<name>/SKILL.md` — project-level skill
2. `<agentDir>/skills/<name>/SKILL.md` — user-level skill (resolved via `@amaster.ai/pi-shared`'s `resolveAgentDir()`, override with `PI_AGENT_HOME`)

The order matches `loadSkillsFromAllLocations` in the pi-coding-agent SDK so a project skill overrides a user-installed one. Frontmatter is stripped; the body is wrapped in `<skill name="..." location="...">…</skill>` and prepended to the user message.

## Output assembly

When at least one mention resolves, the input is rewritten as three optional segments in this order:

```
<skill name="..." location="...">…</skill>   ← skill blocks (if any)

<original user text with mentions stripped>

<system-reminder>
## file.ts: /abs/path/file.ts
```text
…contents…
```
</system-reminder>
```

Pure-text inputs with no resolvable mentions are left untouched (handler returns `undefined`).

## Configuration

| Env var                          | Default     | Meaning                                                  |
|----------------------------------|-------------|----------------------------------------------------------|
| `PI_ATTACHMENT_MAX_TEXT_CHARS`   | `128000`    | Shared text budget per input across file/directory blocks      |
| `PI_AGENT_HOME`                  | (from pi-shared) | Override for user-level skill search root           |

## Limits

Text files are read as bounded UTF-8 prefixes instead of loading the full file. File and directory blocks share `PI_ATTACHMENT_MAX_TEXT_CHARS` (default 128,000); later contents are omitted when the budget is exhausted, with their references retained. Invalid or non-positive environment values use the default. `renderAttachmentContext(attachments, options)` callers share the same budget through `options.maxTextChars`; a zero budget emits references and omission notes only.

Image attachments share a 20 MiB raw-byte budget per input, including drag uploads and file mentions. Images outside the vision budget retain source paths with a visible resize/crop hint; drag uploads are persisted incrementally within a separate 128 MiB storage budget per input. Uploads beyond that storage budget require a file reference or smaller image. Accepted vision images and Markdown references retain matching order.

- **Directory listing**: capped at 200 entries per directory; remainder is summarized as `[Listing truncated: showing 200 of N entries]`.
- **Ignored directory entries**: `.git`, `node_modules`, `.DS_Store`, `.next`, `.turbo`, `dist`, `build`, `.cache`.
- **Mention ordering**: skills are matched before files, so the resolved `mentions[]` array groups by kind rather than preserving textual order. Downstream consumers must not rely on textual order.
