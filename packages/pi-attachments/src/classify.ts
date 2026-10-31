/**
 * Attachment classification and prompt rendering utilities.
 */
import { createReadStream, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type AttachmentKind = 'image' | 'text' | 'doc' | 'binary';

export type AttachmentMeta = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  path?: string;
  url?: string;
};

const TEXT_FILE_EXTENSIONS =
  /\.(csv|tsv|json|jsonl|md|markdown|mdx|txt|html|htm|xml|svg|ya?ml|js|jsx|ts|tsx|mjs|cjs|mts|cts|css|scss|sass|less|sql|log|sh|bash|zsh|fish|py|rb|go|rs|java|kt|kts|scala|swift|m|mm|c|h|hh|hpp|cpp|cxx|cc|cs|php|r|lua|toml|ini|cfg|conf|env|gitignore|dockerfile|makefile|gradle|properties|tf|hcl|nix|patch|diff|proto|graphql|gql)$/i;

const DOC_EXTENSIONS = /\.(pdf|docx|doc|pptx|ppt|xlsx|xls)$/i;

const FENCE_BY_EXT: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  r: 'r',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  json: 'json',
  jsonl: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'ini',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  sql: 'sql',
  log: '',
  csv: 'csv',
  tsv: 'tsv',
  patch: 'diff',
  diff: 'diff',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  tf: 'hcl',
  hcl: 'hcl',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

export function classifyAttachment(name: string, mime: string | undefined): AttachmentKind {
  const lower = name.toLowerCase();
  const m = mime?.toLowerCase();
  if (m?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(lower)) {
    return 'image';
  }
  if (
    DOC_EXTENSIONS.test(lower) ||
    m === 'application/pdf' ||
    m === 'application/msword' ||
    m === 'application/vnd.ms-excel' ||
    m === 'application/vnd.ms-powerpoint' ||
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'doc';
  }
  if (
    m?.startsWith('text/') ||
    TEXT_FILE_EXTENSIONS.test(lower) ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/javascript' ||
    m === 'application/typescript' ||
    m === 'application/x-yaml' ||
    m === 'application/yaml'
  ) {
    return 'text';
  }
  return 'binary';
}

export function fenceForName(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return '';
  return FENCE_BY_EXT[m[1]!] ?? m[1]!;
}

export function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]\n[Read the source file in bounded chunks for the remaining content.]`;
}

export function docReadInstruction(
  name: string,
  fsPath: string,
  mimeType: string | undefined,
): string | undefined {
  const lower = name.toLowerCase();
  const mime = mimeType?.toLowerCase();
  const isPdf = lower.endsWith('.pdf') || mime === 'application/pdf';
  if (isPdf) {
    return `Extract text from this PDF via shell — try \`pdftotext "${fsPath}" -\` first, fall back to a Python one-liner using pypdf or pdfminer. If text extraction returns empty/garbage (likely a scanned PDF), render pages with PyMuPDF (\`fitz.open(...).get_pixmap().save(...)\`) and OCR via pytesseract. Do NOT open it in a browser, take viewer screenshots, or read raw bytes.`;
  }
  if (/\.docx$/.test(lower)) {
    return `Extract text from this .docx via a Python one-liner with python-docx, e.g. \`python -c "import docx; print('\\n'.join(p.text for p in docx.Document('${fsPath}').paragraphs))"\`. Do NOT open it in a browser or screenshot.`;
  }
  if (/\.xlsx$/.test(lower)) {
    return `Extract data from this .xlsx via a Python one-liner using openpyxl. Do NOT open it in a browser or screenshot.`;
  }
  if (/\.pptx$/.test(lower)) {
    return `Extract text from this .pptx via a Python one-liner using python-pptx. Do NOT open it in a browser or screenshot.`;
  }
  if (/\.(docx?|xlsx?|pptx?)$/.test(lower)) {
    return `Convert this Office document with \`libreoffice --headless --convert-to txt "${fsPath}"\` (or a Python equivalent). Do NOT open it in a browser, screenshot, or read it as raw bytes.`;
  }
  return undefined;
}

/** Read only a bounded prefix, even if the file grows after stat(). */
export async function readFilePrefix(fsPath: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(fsPath, {
    end: maxBytes - 1,
    highWaterMark: Math.min(maxBytes, 64 * 1024),
  })) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function renderAttachmentBlock(
  attachment: AttachmentMeta,
  maxTextChars: number,
): Promise<string> {
  const { name, path: fsPath, mimeType, url } = attachment;
  const kind = classifyAttachment(name, mimeType);

  if (kind === 'image') {
    return `## ${name}${fsPath ? `: ${fsPath}` : ''}`;
  }

  if (maxTextChars <= 0 && (kind === 'text' || mimeType === 'inode/directory')) {
    return `## ${name}${fsPath ? `: ${fsPath}` : ''}\n[Attachment text omitted: input text budget exhausted. Read the source path above in bounded chunks to recover the missing sections.]`;
  }

  if (mimeType === 'inode/directory' && fsPath) {
    return await renderDirectoryBlock(name, fsPath, maxTextChars);
  }

  if (kind === 'text' && fsPath) {
    try {
      const buffer = (await readFilePrefix(fsPath, (maxTextChars + 1) * 4)).toString('utf8');
      const text = truncateText(buffer, maxTextChars);
      const fence = fenceForName(name);
      return `## ${name}: ${fsPath}\n\`\`\`${fence}\n${text}\n\`\`\``;
    } catch (error) {
      return `## ${name}: ${fsPath}\n[Failed to read file: ${(error as Error).message}]`;
    }
  }

  if (kind === 'doc') {
    return `## ${name}${fsPath ? `: ${fsPath}` : url ? `: ${url}` : ''}`;
  }

  return `## ${name}${fsPath ? `: ${fsPath}` : url ? `: ${url}` : ''}`;
}

const DIRECTORY_LISTING_LIMIT = 200;
const DIRECTORY_IGNORE = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.next',
  '.turbo',
  'dist',
  'build',
  '.cache',
]);

async function renderDirectoryBlock(
  name: string,
  fsPath: string,
  maxTextChars: number,
): Promise<string> {
  const heading = `## ${name}: ${fsPath} (directory)`;
  let entries: Dirent[];
  try {
    entries = await readdir(fsPath, { withFileTypes: true });
  } catch (error) {
    return `${heading}\n[Failed to list directory: ${(error as Error).message}]`;
  }

  const filtered = entries
    .filter((e) => !DIRECTORY_IGNORE.has(e.name))
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

  const truncatedNote =
    filtered.length > DIRECTORY_LISTING_LIMIT
      ? `\n[Listing truncated: showing ${DIRECTORY_LISTING_LIMIT} of ${filtered.length} entries]`
      : '';
  const slice = filtered.slice(0, DIRECTORY_LISTING_LIMIT);

  const lines: string[] = [];
  for (const entry of slice) {
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
      continue;
    }
    if (entry.isSymbolicLink()) {
      lines.push(`${entry.name}@`);
      continue;
    }
    let size: number | undefined;
    try {
      const s = await stat(path.join(fsPath, entry.name));
      size = s.size;
    } catch {
      // ignore
    }
    lines.push(size !== undefined ? `${entry.name} (${formatBytes(size)})` : entry.name);
  }

  const body = truncateText(lines.join('\n'), maxTextChars);
  return `${heading}\n\`\`\`\n${body}\n\`\`\`${truncatedNote}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export async function renderAttachmentContext(
  attachments: AttachmentMeta[],
  options: { maxTextChars?: number; hasImages?: boolean } = {},
): Promise<string | undefined> {
  const maxTextChars = options.maxTextChars ?? 128_000;
  const fileAttachments = attachments.filter(
    (a) => classifyAttachment(a.name, a.mimeType) !== 'image',
  );

  if (fileAttachments.length === 0 && !options.hasImages) {
    return undefined;
  }

  const lines: string[] = [];
  if (fileAttachments.length > 0) {
    const blocks: string[] = [];
    let remaining = maxTextChars;
    for (const attachment of fileAttachments) {
      const block = await renderAttachmentBlock(attachment, remaining);
      blocks.push(block);
      remaining = Math.max(0, remaining - block.length);
    }
    if (blocks.length > 0) {
      lines.push('# Files mentioned by the user:', '', blocks.join('\n\n'));
    }
  }

  if (options.hasImages) {
    if (lines.length > 0) lines.push('');
    lines.push(
      '(Image attachments are provided directly as model-visible image content. Do not call file tools for those uploaded images.)',
    );
  }

  if (lines.length === 0) return undefined;

  lines.push(
    '',
    "(The user's language follows the request text above, not the attached file contents. Respond in the user's language.)",
  );
  return lines.join('\n').trim();
}
