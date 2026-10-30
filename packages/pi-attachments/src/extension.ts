/**
 * Pi Attachments Extension
 *
 * Intercepts user input containing @-references, reads referenced resources,
 * and injects their content into the prompt as context.
 *
 * Recognized references:
 * - @skill:<name> — load SKILL.md for a registered skill (project > user > global agent dir)
 * - @path/to/file.ts — unquoted file reference
 * - @"/path with spaces/file.pdf" — quoted file reference
 * - @file.ts#L10-20 — line range (parsed but range applied by LLM tools)
 *
 * Image attachments are exposed on two parallel channels:
 *   1. event.images[] — base64 image content the model sees via vision.
 *   2. event.text     — `![name](path)` markdown line per image, in the same order.
 *
 * The two channels are kept in lock-step so that "the first image you see" in
 * the vision channel is the same one the first markdown ref points to. This is
 * what lets a model call `image_generate({ image: [path] })` after looking at
 * an uploaded image.
 *
 * Drag-uploaded images (those that arrive on event.images[] without an
 * @-mention) have no source path. We materialize them to <cwd>/.pi/uploads/
 * with a sha256-derived filename and surface that path. They're rendered
 * before the @-mention block, matching "user uploads first, then types".
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveHome } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI, InputEventResult } from '@earendil-works/pi-coding-agent';
import {
  type AttachmentMeta,
  classifyAttachment,
  readFilePrefix,
  renderAttachmentBlock,
} from './classify.js';

type ImageContent = { type: 'image'; mimeType: string; data: string };

const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const SKILL_NAMESPACE = 'skill';
const NAMESPACE_AT_RE = /(^|\s)@([a-z][a-z0-9_-]*):([^\s@"]+)/gi;
const QUOTED_AT_RE = /(^|\s)@"([^"]+)"/g;
const REGULAR_AT_RE = /(^|\s)@([^\s@"]+)/g;

type Mention = { kind: 'skill'; name: string } | { kind: 'file'; ref: string };

type Item =
  | { kind: 'image'; name: string; absolutePath: string; image: ImageContent }
  | { kind: 'file'; meta: AttachmentMeta }
  | { kind: 'skill'; block: string }
  | { kind: 'notice'; block: string };

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic',
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
};

export default function piAttachmentsExtension(pi: ExtensionAPI): void {
  const configuredTextChars = Number(process.env.PI_ATTACHMENT_MAX_TEXT_CHARS);
  const maxTextChars =
    Number.isSafeInteger(configuredTextChars) && configuredTextChars > 0
      ? configuredTextChars
      : 128_000;

  pi.on('input', async (event, ctx): Promise<InputEventResult | undefined> => {
    const { mentions } = extractMentions(event.text);
    const incomingImages = event.images ?? [];

    if (mentions.length === 0 && incomingImages.length === 0) {
      return;
    }

    const cwd = ctx.cwd;
    const items: Item[] = [];
    let remainingImageBytes = MAX_INPUT_IMAGE_BYTES;
    const resolvedPaths = new Set<string>();
    const resolvedSkills = new Set<string>();

    // Drag-uploaded images go first, in arrival order. Persist each to disk so
    // we can give the model a concrete path it can pass to file-aware tools.
    for (const image of incomingImages) {
      const estimatedBytes = Buffer.byteLength(image.data, 'base64');
      if (estimatedBytes > remainingImageBytes) {
        items.push({ kind: 'notice', block: '[Image omitted: input image budget is 20 MiB.]' });
        continue;
      }
      remainingImageBytes -= estimatedBytes;
      try {
        const persisted = await persistDragUploadedImage(image, cwd);
        if (resolvedPaths.has(persisted.absolutePath)) continue;
        resolvedPaths.add(persisted.absolutePath);
        items.push({
          kind: 'image',
          name: persisted.name,
          absolutePath: persisted.absolutePath,
          image,
        });
      } catch {
        // If we can't persist (read-only fs, permissions), keep the vision
        // channel anyway by recording the image with no path. The markdown
        // line will use a placeholder so the model knows the image is there.
        items.push({
          kind: 'image',
          name: 'uploaded-image',
          absolutePath: '',
          image,
        });
      }
    }

    // @-mentions in the order they appeared in the user's text.
    for (const mention of mentions) {
      if (mention.kind === 'skill') {
        if (resolvedSkills.has(mention.name)) continue;
        resolvedSkills.add(mention.name);
        const block = await loadSkillBlock(mention.name, cwd);
        if (block) items.push({ kind: 'skill', block });
        continue;
      }

      const { filename } = parseFileReference(mention.ref);
      const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(cwd, filename);
      if (resolvedPaths.has(absolutePath)) continue;
      resolvedPaths.add(absolutePath);

      try {
        const stats = await stat(absolutePath);
        if (stats.isDirectory()) {
          items.push({
            kind: 'file',
            meta: {
              id: absolutePath,
              name: path.basename(absolutePath),
              path: absolutePath,
              mimeType: 'inode/directory',
            },
          });
          continue;
        }

        const name = path.basename(absolutePath);
        const mimeType = guessMimeType(name);
        const kind = classifyAttachment(name, mimeType);

        if (kind === 'image') {
          try {
            if (stats.size > remainingImageBytes) {
              items.push({
                kind: 'notice',
                block: `## ${name}: ${absolutePath}\n[Image omitted: input image budget is 20 MiB.]`,
              });
              continue;
            }
            const bytes = await readFilePrefix(absolutePath, remainingImageBytes + 1);
            if (bytes.length > remainingImageBytes) {
              items.push({
                kind: 'notice',
                block: `## ${name}: ${absolutePath}\n[Image omitted: input image budget is 20 MiB.]`,
              });
              continue;
            }
            remainingImageBytes -= bytes.length;
            items.push({
              kind: 'image',
              name,
              absolutePath,
              image: {
                type: 'image',
                mimeType: mimeType ?? 'image/png',
                data: bytes.toString('base64'),
              },
            });
          } catch {
            // skip unreadable images
          }
        } else {
          items.push({
            kind: 'file',
            meta: {
              id: absolutePath,
              name,
              path: absolutePath,
              ...(mimeType ? { mimeType } : {}),
              size: stats.size,
            },
          });
        }
      } catch {
        // skip files that don't exist or can't be accessed
      }
    }

    if (items.length === 0) {
      return;
    }

    // Emit images in the same order they appear in items[]. Lock-step ordering
    // is what guarantees `images[N]` corresponds to the Nth `![](...)` line.
    const outputImages: ImageContent[] = items
      .filter((item): item is Extract<Item, { kind: 'image' }> => item.kind === 'image')
      .map((item) => item.image);

    const cleanText = stripMentions(event.text);
    const renderedItems: string[] = [];
    let remainingTextChars = maxTextChars;
    for (const item of items) {
      if (item.kind === 'image') {
        renderedItems.push(renderImageMarkdown(item.name, item.absolutePath));
      } else if (item.kind === 'skill' || item.kind === 'notice') {
        renderedItems.push(item.block);
      } else {
        const block = await renderAttachmentBlock(item.meta, remainingTextChars);
        renderedItems.push(block);
        remainingTextChars = Math.max(0, remainingTextChars - block.length);
      }
    }

    const parts: string[] = [];
    if (cleanText) parts.push(cleanText);
    if (renderedItems.length > 0) parts.push(renderedItems.join('\n\n'));
    const text = parts.join('\n\n');

    return {
      action: 'transform',
      text,
      ...(outputImages.length > 0 || incomingImages.length > 0 ? { images: outputImages } : {}),
    };
  });
}

/**
 * Render an inline image reference. `![alt](path)` is the standard markdown
 * shape; if path is empty (drag-upload that we couldn't persist) we fall back
 * to a name-only marker so the model still sees the slot.
 */
function renderImageMarkdown(name: string, absolutePath: string): string {
  if (!absolutePath) {
    return `![${escapeMarkdown(name)}](#)`;
  }
  return `![${escapeMarkdown(name)}](${absolutePath})`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[[\]()]/g, (ch) => `\\${ch}`);
}

/**
 * Persist a drag-uploaded image (which has no source path) into
 * `<cwd>/.pi/uploads/`, naming it by sha256 of its bytes. Same image uploaded
 * twice → same path, no duplicate write.
 */
async function persistDragUploadedImage(
  image: ImageContent,
  cwd: string,
): Promise<{ absolutePath: string; name: string }> {
  const bytes = Buffer.from(image.data, 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const ext = MIME_TO_EXT[image.mimeType] ?? 'png';
  const name = `${hash}.${ext}`;
  const dir = path.resolve(cwd, '.pi', 'uploads');
  const absolutePath = path.join(dir, name);

  await mkdir(dir, { recursive: true });
  try {
    await stat(absolutePath);
    // already on disk — same content (sha256 collision-resistant)
  } catch {
    await writeFile(absolutePath, bytes);
  }
  return { absolutePath, name };
}

export function extractMentions(content: string): { mentions: Mention[]; raw: string[] } {
  const mentions: Mention[] = [];
  const raw: string[] = [];
  const seenSkills = new Set<string>();
  const seenFiles = new Set<string>();
  const namespaceSpans: Array<[number, number]> = [];

  for (const match of content.matchAll(NAMESPACE_AT_RE)) {
    const ns = match[2]!.toLowerCase();
    const value = match[3]!;
    const start = match.index! + (match[1]?.length ?? 0);
    namespaceSpans.push([start, start + 1 + ns.length + 1 + value.length]);
    if (ns === SKILL_NAMESPACE) {
      if (!seenSkills.has(value)) {
        seenSkills.add(value);
        mentions.push({ kind: 'skill', name: value });
        raw.push(`@${ns}:${value}`);
      }
    }
  }

  const isInsideNamespace = (start: number, end: number) =>
    namespaceSpans.some(([s, e]) => start >= s && end <= e);

  for (const match of content.matchAll(QUOTED_AT_RE)) {
    const value = match[2]!;
    const start = match.index! + (match[1]?.length ?? 0);
    const end = start + 2 + value.length + 1;
    if (isInsideNamespace(start, end)) continue;
    if (!seenFiles.has(value)) {
      seenFiles.add(value);
      mentions.push({ kind: 'file', ref: value });
      raw.push(`@"${value}"`);
    }
  }

  for (const match of content.matchAll(REGULAR_AT_RE)) {
    const value = match[2]!;
    const start = match.index! + (match[1]?.length ?? 0);
    const end = start + 1 + value.length;
    if (isInsideNamespace(start, end)) continue;
    if (value.startsWith('http')) continue;
    if (seenFiles.has(value)) continue;
    seenFiles.add(value);
    mentions.push({ kind: 'file', ref: value });
    raw.push(`@${value}`);
  }

  return { mentions, raw };
}

export function stripMentions(content: string): string {
  return content
    .replace(NAMESPACE_AT_RE, '$1')
    .replace(QUOTED_AT_RE, '$1')
    .replace(REGULAR_AT_RE, '$1')
    .trim();
}

function parseFileReference(mention: string): {
  filename: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const hashIdx = mention.indexOf('#L');
  if (hashIdx === -1) {
    return { filename: mention };
  }
  const filename = mention.slice(0, hashIdx);
  const range = mention.slice(hashIdx + 2);
  const parts = range.split('-');
  const lineStart = Number(parts[0]) || undefined;
  const lineEnd = parts[1] ? Number(parts[1]) || undefined : undefined;
  return {
    filename,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  };
}

/**
 * Search order for `@skill:<name>`: project-level (`<cwd>/.pi/skills`) before
 * user-level (`<agentDir>/skills`). Matches `loadSkillsFromAllLocations` in
 * the pi-coding-agent SDK so a project skill overrides a user-installed one.
 */
export function skillSearchPaths(name: string, cwd: string): string[] {
  const projectDir = path.resolve(cwd, '.pi', 'skills', name);
  const userDir = path.resolve(resolveHome(), 'skills', name);
  return [projectDir, userDir].map((dir) => path.join(dir, 'SKILL.md'));
}

async function loadSkillBlock(name: string, cwd: string): Promise<string | undefined> {
  for (const filePath of skillSearchPaths(name, cwd)) {
    try {
      const content = await readFile(filePath, 'utf8');
      const baseDir = path.dirname(filePath);
      const body = stripFrontmatter(content).trim();
      return [
        `<skill name="${escapeXmlAttribute(name)}" location="${escapeXmlAttribute(filePath)}">`,
        `References are relative to ${baseDir}.`,
        '',
        body,
        '</skill>',
      ].join('\n');
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const close = content.indexOf('\n---', 3);
  if (close === -1) return content;
  const after = close + '\n---'.length;
  return content.slice(content[after] === '\n' ? after + 1 : after);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function guessMimeType(name: string): string | undefined {
  const ext = name.toLowerCase().split('.').pop();
  return ext ? MIME_BY_EXT[ext] : undefined;
}
