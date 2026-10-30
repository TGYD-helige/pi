import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { VideoGenError } from './errors.js';
import { probeCommand, waitForProbe } from './probe.js';
import { CancelledError } from './providers/task.js';
import type { OverlayPosition, TimelineOverlay, TimelineSubtitles } from './timeline.js';

/**
 * Text overlay rendering (C1): SVG template → PNG overlay via sharp.
 *
 * Chinese text is rendered by the LOCAL font stack (model never writes
 * pixels — that's the Codex/hypeframes lesson: model-generated CJK text
 * comes out garbled). Positioning follows Remotion's video-layout rule of a
 * ~8% safe margin.
 */

const FONT_STACK = 'PingFang SC, Hiragana Sans GB, Microsoft YaHei, Noto Sans CJK SC, sans-serif';
const SAFE_MARGIN_RATIO = 0.08;

export async function hasCjkFont(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new CancelledError();
  const deadline = Date.now() + 2000;
  const windowsFonts = process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : '';
  for (const path of [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    windowsFonts && join(windowsFonts, 'msyh.ttc'),
    windowsFonts && join(windowsFonts, 'simsun.ttc'),
  ]) {
    if (!path) continue;
    if (Date.now() >= deadline) return false;
    const font = await waitForProbe(
      stat(path).catch((error: NodeJS.ErrnoException) => {
        if (
          !signal?.aborted &&
          Date.now() < deadline &&
          !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code ?? '')
        ) {
          console.error('[pi-video-gen] font lookup failed');
        }
        return undefined;
      }),
      signal,
      deadline,
    );
    if (signal?.aborted) throw new CancelledError();
    if (Date.now() >= deadline) return false;
    if (font?.isFile()) return true;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  const listed = await probeCommand('fc-list', [':lang=zh-cn', 'family'], signal, 2000, deadline);
  return Boolean(listed?.trim());
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function estimatedTextWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce((width, char) => {
    if (/\s/u.test(char)) return width + fontSize * 0.33;
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
        char,
      ) ||
      /[MWmw@%&]/u.test(char)
    ) {
      return width + fontSize;
    }
    if (/[A-Z0-9]/u.test(char)) return width + fontSize * 0.75;
    return width + fontSize * 0.62;
  }, 0);
}

function wrapSubtitleLines(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s+|[^\s]+/gu) ?? []) {
      const candidate = line + token;
      if (line.trim() && estimatedTextWidth(candidate, fontSize) > maxWidth) {
        lines.push(line.trim());
        line = token.trimStart();
      } else {
        line = candidate;
      }
      while (estimatedTextWidth(line, fontSize) > maxWidth) {
        const chars = Array.from(line);
        let cut = 1;
        while (
          cut < chars.length &&
          estimatedTextWidth(chars.slice(0, cut + 1).join(''), fontSize) <= maxWidth
        ) {
          cut += 1;
        }
        lines.push(chars.slice(0, cut).join('').trim());
        line = chars.slice(cut).join('').trimStart();
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

function positionFor(
  pos: OverlayPosition | undefined,
  width: number,
  height: number,
  blockH: number,
): { x: number; y: number; anchor: 'start' | 'middle' } {
  const marginX = Math.round(width * SAFE_MARGIN_RATIO);
  const marginY = Math.round(height * SAFE_MARGIN_RATIO);
  if (pos === 'bottom-center') {
    return { x: Math.round(width / 2), y: height - marginY - blockH, anchor: 'middle' };
  }
  if (pos === 'top-left') {
    return { x: marginX, y: marginY, anchor: 'start' };
  }
  if (pos === 'center') {
    return { x: Math.round(width / 2), y: Math.round((height - blockH) / 2), anchor: 'middle' };
  }
  return { x: marginX, y: height - marginY - blockH, anchor: 'start' };
}

function overlaySvg(
  overlay: TimelineOverlay,
  width: number,
  height: number,
  titleLines: string[],
  subtitleLines: string[],
): string {
  const titleSize = Math.max(28, Math.round(height * 0.055));
  const subtitleSize = Math.max(20, Math.round(height * 0.032));
  const lineGap = Math.round(titleSize * 0.5);
  const blockH =
    titleLines.length * Math.round(titleSize * 1.25) +
    (titleLines.length && subtitleLines.length ? lineGap : 0) +
    subtitleLines.length * Math.round(subtitleSize * 1.25);
  const { x, y, anchor } = positionFor(overlay.position, width, height, blockH);

  const lines: string[] = [];
  let cursorY = y + titleSize;
  for (const line of titleLines) {
    lines.push(
      `<text x="${x}" y="${cursorY}" font-size="${titleSize}" font-weight="700" fill="#ffffff" text-anchor="${anchor}" font-family="${FONT_STACK}">${escapeXml(line)}</text>`,
    );
    cursorY += Math.round(titleSize * 1.25);
  }
  if (titleLines.length && subtitleLines.length) cursorY += lineGap;
  for (const line of subtitleLines) {
    lines.push(
      `<text x="${x}" y="${cursorY}" font-size="${subtitleSize}" font-weight="400" fill="rgba(255,255,255,0.85)" text-anchor="${anchor}" font-family="${FONT_STACK}">${escapeXml(line)}</text>`,
    );
    cursorY += Math.round(subtitleSize * 1.25);
  }

  // Soft dark plate behind the text block for legibility over any image.
  const platePad = Math.round(titleSize * 0.45);
  const plateY = y - platePad;
  const plateH = blockH + platePad * 2;
  const plate = `<rect x="0" y="${plateY}" width="${width}" height="${plateH}" fill="rgba(0,0,0,0.32)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${plate}${lines.join('')}</svg>`;
}

async function actualTextWidth(
  text: string,
  fontSize: number,
  weight: number,
  maxWidth: number,
): Promise<number> {
  const size = Math.max(
    512,
    Math.ceil(maxWidth * 2),
    Math.ceil(estimatedTextWidth(text, fontSize) * 2 + fontSize * 4),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${fontSize * 4}"><text x="${fontSize}" y="${fontSize * 2}" font-size="${fontSize}" font-weight="${weight}" fill="#fff" font-family="${FONT_STACK}">${escapeXml(text)}</text></svg>`;
  const { info } = await sharp(Buffer.from(svg)).trim().png().toBuffer({ resolveWithObject: true });
  return info.width;
}

/** Render an overlay to a PNG with alpha, sized to the video frame. */
export async function renderTextOverlay(opts: {
  overlay: TimelineOverlay;
  width: number;
  height: number;
  outPath: string;
  signal?: AbortSignal | undefined;
}): Promise<string | null> {
  if (!opts.overlay.title && !opts.overlay.subtitle) return null;
  const text = `${opts.overlay.title ?? ''}${opts.overlay.subtitle ?? ''}`;
  if (/\p{Script=Han}/u.test(text) && !(await hasCjkFont(opts.signal))) {
    throw new VideoGenError(
      'A CJK font is required for Chinese text overlays. Install PingFang, Microsoft YaHei, Noto Sans CJK, or WenQuanYi, then retry.',
      'text-layer: CJK font missing',
    );
  }
  const titleSize = Math.max(28, Math.round(opts.height * 0.055));
  const subtitleSize = Math.max(20, Math.round(opts.height * 0.032));
  const maxWidth = opts.width * (1 - SAFE_MARGIN_RATIO * 2);
  const titleLines = opts.overlay.title
    ? wrapSubtitleLines(opts.overlay.title, titleSize, maxWidth)
    : [];
  const subtitleLines = opts.overlay.subtitle
    ? wrapSubtitleLines(opts.overlay.subtitle, subtitleSize, maxWidth)
    : [];
  for (const [line, size, weight] of [
    ...titleLines.map((line) => [line, titleSize, 700] as const),
    ...subtitleLines.map((line) => [line, subtitleSize, 400] as const),
  ]) {
    if ((await actualTextWidth(line, size, weight, maxWidth)) > maxWidth)
      throw new VideoGenError(
        'Text overlay exceeds the safe frame width. Shorten the title or reduce text length.',
        'text-layer: overlay width',
      );
  }
  const blockH =
    titleLines.length * Math.round(titleSize * 1.25) +
    subtitleLines.length * Math.round(subtitleSize * 1.25);
  if (blockH + titleSize > opts.height * (1 - SAFE_MARGIN_RATIO * 2))
    throw new VideoGenError(
      'Text overlay exceeds the safe frame height. Shorten the title or subtitle.',
      'text-layer: overlay height',
    );
  const svg = overlaySvg(opts.overlay, opts.width, opts.height, titleLines, subtitleLines);
  // Render the SVG at ~2x density for crisp text, then downscale to frame size.
  await sharp(Buffer.from(svg, 'utf-8'), { density: 150 })
    .resize(opts.width, opts.height)
    .png()
    .toFile(opts.outPath);
  return opts.outPath;
}

/** Render one narration cue as a branded, bottom-centered burned subtitle. */
export async function renderBurnedSubtitle(opts: {
  text: string;
  style: TimelineSubtitles;
  width: number;
  height: number;
  outPath: string;
  signal?: AbortSignal | undefined;
}): Promise<string> {
  if (/\p{Script=Han}/u.test(opts.text) && !(await hasCjkFont(opts.signal))) {
    throw new VideoGenError(
      'A CJK font is required for burned Chinese subtitles. Install PingFang, Microsoft YaHei, Noto Sans CJK, or WenQuanYi, then retry.',
      'text-layer: CJK font missing',
    );
  }
  const fontSize = opts.style.fontSize ?? Math.max(20, Math.round(opts.height * 0.032));
  const lineHeight = Math.round(fontSize * 1.35);
  const margin = Math.round(opts.height * SAFE_MARGIN_RATIO);
  const padding = Math.round(fontSize * 0.5);
  const lines = wrapSubtitleLines(opts.text, fontSize, opts.width - margin * 2 - padding * 2);
  for (const line of lines)
    if (
      (await actualTextWidth(line, fontSize, 500, opts.width - margin * 2 - padding * 2)) >
      opts.width - margin * 2 - padding * 2
    )
      throw new VideoGenError(
        'Burned subtitle exceeds the safe frame width. Shorten the text or reduce subtitles.fontSize.',
        'text-layer: subtitle width',
      );
  const blockHeight = Math.max(1, lines.length) * lineHeight;
  if (blockHeight + padding * 2 > opts.height - margin * 2) {
    throw new VideoGenError(
      'Burned subtitle text is too long to fit the video frame. Shorten the narration or reduce subtitles.fontSize.',
      'text-layer: subtitle too long',
    );
  }
  const plateY = opts.height - margin - blockHeight - padding;
  const textY = plateY + padding + fontSize;
  const textColor = opts.style.textColor ?? '#ffffff';
  const backgroundColor = opts.style.backgroundColor ?? '#000000';
  const backgroundOpacity = opts.style.backgroundOpacity ?? 0.55;
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${Math.round(opts.width / 2)}" y="${textY + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}">
    <rect x="0" y="${plateY}" width="${opts.width}" height="${blockHeight + padding * 2}" fill="${backgroundColor}" fill-opacity="${backgroundOpacity}"/>
    <text font-size="${fontSize}" font-weight="500" fill="${textColor}" text-anchor="middle" font-family="${FONT_STACK}">${tspans}</text>
  </svg>`;
  await sharp(Buffer.from(svg, 'utf-8'), { density: 150 })
    .resize(opts.width, opts.height)
    .png()
    .toFile(opts.outPath);
  return opts.outPath;
}
