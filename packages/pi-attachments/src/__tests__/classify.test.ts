import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyAttachment,
  docReadInstruction,
  fenceForName,
  renderAttachmentBlock,
  renderAttachmentContext,
  truncateText,
} from '../classify.js';

describe('classifyAttachment', () => {
  it('classifies image files by extension', () => {
    expect(classifyAttachment('photo.png', undefined)).toBe('image');
    expect(classifyAttachment('shot.jpg', undefined)).toBe('image');
    expect(classifyAttachment('icon.webp', undefined)).toBe('image');
  });

  it('classifies image files by mime type', () => {
    expect(classifyAttachment('file', 'image/png')).toBe('image');
    expect(classifyAttachment('file', 'image/jpeg')).toBe('image');
  });

  it('classifies text files by extension', () => {
    expect(classifyAttachment('main.ts', undefined)).toBe('text');
    expect(classifyAttachment('data.json', undefined)).toBe('text');
    expect(classifyAttachment('readme.md', undefined)).toBe('text');
    expect(classifyAttachment('config.yaml', undefined)).toBe('text');
  });

  it('classifies text files by mime type', () => {
    expect(classifyAttachment('file', 'text/plain')).toBe('text');
    expect(classifyAttachment('file', 'application/json')).toBe('text');
  });

  it('classifies document files', () => {
    expect(classifyAttachment('report.pdf', undefined)).toBe('doc');
    expect(classifyAttachment('file.docx', undefined)).toBe('doc');
    expect(classifyAttachment('data.xlsx', undefined)).toBe('doc');
    expect(classifyAttachment('slides.pptx', undefined)).toBe('doc');
  });

  it('classifies document files by mime type', () => {
    expect(classifyAttachment('file', 'application/pdf')).toBe('doc');
  });

  it('classifies unknown files as binary', () => {
    expect(classifyAttachment('archive.zip', undefined)).toBe('binary');
    expect(classifyAttachment('app.exe', undefined)).toBe('binary');
    expect(classifyAttachment('file', 'application/octet-stream')).toBe('binary');
  });
});

describe('fenceForName', () => {
  it('returns language for known extensions', () => {
    expect(fenceForName('main.ts')).toBe('typescript');
    expect(fenceForName('app.py')).toBe('python');
    expect(fenceForName('style.css')).toBe('css');
    expect(fenceForName('data.json')).toBe('json');
  });

  it('returns the extension itself for unknown types', () => {
    expect(fenceForName('file.xyz')).toBe('xyz');
  });

  it('returns empty string for files without extension', () => {
    expect(fenceForName('Makefile')).toBe('');
  });
});

describe('truncateText', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });

  it('truncates text exceeding limit', () => {
    const result = truncateText('abcdefghij', 5);
    expect(result).toContain('abcde');
    expect(result).toContain('[truncated after 5 characters]');
  });

  it('returns unchanged when limit is 0 or negative', () => {
    expect(truncateText('hello', 0)).toBe('hello');
    expect(truncateText('hello', -1)).toBe('hello');
  });
});

describe('docReadInstruction', () => {
  it('returns pdftotext instruction for PDF files', () => {
    const result = docReadInstruction('report.pdf', '/tmp/report.pdf', 'application/pdf');
    expect(result).toContain('pdftotext');
    expect(result).toContain('/tmp/report.pdf');
    expect(result).toContain('PyMuPDF');
  });

  it('returns python-docx instruction for .docx', () => {
    const result = docReadInstruction('doc.docx', '/tmp/doc.docx', undefined);
    expect(result).toContain('python-docx');
    expect(result).toContain('/tmp/doc.docx');
  });

  it('returns openpyxl instruction for .xlsx', () => {
    const result = docReadInstruction('data.xlsx', '/tmp/data.xlsx', undefined);
    expect(result).toContain('openpyxl');
  });

  it('returns python-pptx instruction for .pptx', () => {
    const result = docReadInstruction('slides.pptx', '/tmp/slides.pptx', undefined);
    expect(result).toContain('python-pptx');
  });

  it('returns undefined for non-document files', () => {
    expect(docReadInstruction('code.ts', '/tmp/code.ts', undefined)).toBeUndefined();
    expect(docReadInstruction('data.json', '/tmp/data.json', undefined)).toBeUndefined();
  });
});

describe('renderAttachmentBlock', () => {
  it('renders text file with fenced content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-attach-test-'));
    const filePath = join(dir, 'hello.ts');
    await writeFile(filePath, 'const x = 1;\n');

    const result = await renderAttachmentBlock(
      { id: '1', name: 'hello.ts', path: filePath, mimeType: 'text/typescript' },
      100_000,
    );

    expect(result).toContain(`## hello.ts: ${filePath}`);
    expect(result).toContain('```typescript');
    expect(result).toContain('const x = 1;');
  });

  it('renders doc file with path heading and instruction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-attach-test-'));
    const filePath = join(dir, 'report.pdf');
    await writeFile(filePath, '%PDF-1.4 fake');

    const result = await renderAttachmentBlock(
      { id: '1', name: 'report.pdf', path: filePath, mimeType: 'application/pdf' },
      100_000,
    );

    expect(result).toBe(`## report.pdf: ${filePath}`);
  });

  it('renders image file with just path heading', async () => {
    const result = await renderAttachmentBlock(
      { id: '1', name: 'photo.png', path: '/tmp/photo.png' },
      100_000,
    );

    expect(result).toBe('## photo.png: /tmp/photo.png');
  });

  it('renders file without path using just name', async () => {
    const result = await renderAttachmentBlock({ id: '1', name: 'unknown.bin' }, 100_000);

    expect(result).toBe('## unknown.bin');
  });

  it('renders file with url', async () => {
    const result = await renderAttachmentBlock(
      { id: '1', name: 'remote.csv', url: 'https://example.com/data.csv' },
      100_000,
    );

    expect(result).toContain('https://example.com/data.csv');
  });

  it('truncates long text files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-attach-test-'));
    const filePath = join(dir, 'long.txt');
    await writeFile(filePath, 'x'.repeat(1000));

    const result = await renderAttachmentBlock({ id: '1', name: 'long.txt', path: filePath }, 50);

    expect(result).toContain('[truncated after 50 characters]');
  });
});

describe('renderAttachmentContext', () => {
  const dir = join(tmpdir(), 'pi-attachments-context');
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  it('renders context for text attachments', async () => {
    const filePath = join(dir, 'code.ts');
    await writeFile(filePath, 'export const y = 2;\n');

    const result = await renderAttachmentContext([
      { id: '1', name: 'code.ts', path: filePath, mimeType: 'text/typescript' },
    ]);

    expect(result).toContain('# Files mentioned by the user:');
    expect(result).toContain('## code.ts');
    expect(result).toContain('export const y = 2;');
    expect(result).toContain("Respond in the user's language");
  });

  it('shares a text budget across multiple attachments', async () => {
    await writeFile(join(dir, 'first.txt'), 'a'.repeat(200));
    await writeFile(join(dir, 'second.txt'), 'b'.repeat(200));
    const result = await renderAttachmentContext(
      [
        { id: '1', name: 'first.txt', path: join(dir, 'first.txt') },
        { id: '2', name: 'second.txt', path: join(dir, 'second.txt') },
      ],
      { maxTextChars: 100 },
    );
    expect(result).toContain('first.txt');
    expect(result).toContain('second.txt');
    expect(result).not.toContain('b'.repeat(10));
    expect(result).toContain('omitted');
  });

  it('adds image guidance when hasImages is true', async () => {
    const result = await renderAttachmentContext([], { hasImages: true });

    expect(result).toContain('Image attachments are provided directly');
  });

  it('returns undefined when no attachments and no images', async () => {
    const result = await renderAttachmentContext([]);
    expect(result).toBeUndefined();
  });

  it('skips image attachments in the file listing', async () => {
    const result = await renderAttachmentContext([
      { id: '1', name: 'photo.png', path: '/tmp/photo.png', mimeType: 'image/png' },
    ]);

    expect(result).toBeUndefined();
  });
});
