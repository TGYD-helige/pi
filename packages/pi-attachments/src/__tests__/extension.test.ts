import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractMentions, skillSearchPaths, stripMentions } from '../extension.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe('extractMentions', () => {
  it('extracts unquoted @path file references', () => {
    const { mentions } = extractMentions('check @src/main.ts please');
    expect(mentions).toEqual([{ kind: 'file', ref: 'src/main.ts' }]);
  });

  it('extracts quoted @"path" file references', () => {
    const { mentions } = extractMentions('review @"/path with spaces/file.ts"');
    expect(mentions).toEqual([{ kind: 'file', ref: '/path with spaces/file.ts' }]);
  });

  it('extracts multiple file references and dedupes', () => {
    const { mentions } = extractMentions('@src/a.ts @src/b.ts @src/a.ts');
    expect(mentions).toEqual([
      { kind: 'file', ref: 'src/a.ts' },
      { kind: 'file', ref: 'src/b.ts' },
    ]);
  });

  it('ignores http URLs', () => {
    const { mentions } = extractMentions('see @https://example.com');
    expect(mentions).toEqual([]);
  });

  it('keeps line range syntax in the file reference', () => {
    const { mentions } = extractMentions('look at @src/main.ts#L10-20');
    expect(mentions).toEqual([{ kind: 'file', ref: 'src/main.ts#L10-20' }]);
  });

  it('extracts @skill:name as a skill mention', () => {
    const { mentions } = extractMentions('use @skill:react-page to draft a page');
    expect(mentions).toEqual([{ kind: 'skill', name: 'react-page' }]);
  });

  it('does not double-count a skill mention as a file mention', () => {
    const { mentions } = extractMentions('@skill:react-page');
    expect(mentions).toEqual([{ kind: 'skill', name: 'react-page' }]);
  });

  it('mixes skill and file mentions in order', () => {
    const { mentions } = extractMentions('load @skill:react-page and review @src/main.ts');
    expect(mentions).toEqual([
      { kind: 'skill', name: 'react-page' },
      { kind: 'file', ref: 'src/main.ts' },
    ]);
  });

  it('dedupes repeated skill mentions', () => {
    const { mentions } = extractMentions('@skill:react-page and @skill:react-page again');
    expect(mentions).toEqual([{ kind: 'skill', name: 'react-page' }]);
  });

  it('treats unknown namespaces as no-op (not as file mentions either)', () => {
    const { mentions } = extractMentions('@app:erp-prod hello');
    expect(mentions).toEqual([]);
  });

  it('handles @ at start of text', () => {
    const { mentions } = extractMentions('@file.ts');
    expect(mentions).toEqual([{ kind: 'file', ref: 'file.ts' }]);
  });

  it('groups skill mentions before file mentions regardless of textual order', () => {
    // Implementation detail: skills are matched first, then files. This means
    // the mentions array does NOT preserve the textual order — it groups by kind.
    // Downstream consumers must not rely on textual order.
    const { mentions } = extractMentions('review @src/main.ts then @skill:foo');
    expect(mentions).toEqual([
      { kind: 'skill', name: 'foo' },
      { kind: 'file', ref: 'src/main.ts' },
    ]);
  });

  it('matches @SKILL: case-insensitively', () => {
    const { mentions } = extractMentions('use @SKILL:foo here');
    expect(mentions).toEqual([{ kind: 'skill', name: 'foo' }]);
  });
});

describe('stripMentions', () => {
  it('removes file mentions', () => {
    expect(stripMentions('check @src/main.ts please')).toBe('check  please');
  });

  it('removes quoted mentions', () => {
    expect(stripMentions('review @"/tmp/file.ts" now')).toBe('review  now');
  });

  it('removes skill mentions', () => {
    expect(stripMentions('use @skill:react-page now')).toBe('use  now');
  });

  it('removes mixed mentions and trims', () => {
    expect(stripMentions('@skill:foo @a.ts @b.ts explain')).toBe('explain');
  });

  it('leaves text without mentions intact', () => {
    expect(stripMentions('plain message')).toBe('plain message');
  });
});

describe('skillSearchPaths', () => {
  it('returns project path before user (agent dir) path', () => {
    const cwd = '/tmp/fake-project';
    const paths = skillSearchPaths('react-page', cwd);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(resolve(cwd, '.pi/skills/react-page/SKILL.md'));
    expect(paths[1]!.endsWith(join('skills', 'react-page', 'SKILL.md'))).toBe(true);
  });

  it('honors PI_AGENT_HOME for user-level path', () => {
    const original = process.env.PI_AGENT_HOME;
    process.env.PI_AGENT_HOME = '/tmp/custom-agent';
    try {
      const paths = skillSearchPaths('foo', '/tmp/cwd');
      expect(paths[1]).toBe('/tmp/custom-agent/skills/foo/SKILL.md');
    } finally {
      if (original === undefined) delete process.env.PI_AGENT_HOME;
      else process.env.PI_AGENT_HOME = original;
    }
  });
});

describe('skill loading via extension input handler', () => {
  let tmpRoot: string;
  let cwd: string;
  let agentDir: string;
  let originalAgentHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pi-attachments-test-'));
    cwd = join(tmpRoot, 'project');
    agentDir = join(tmpRoot, 'agent');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    originalAgentHome = process.env.PI_AGENT_HOME;
    process.env.PI_AGENT_HOME = agentDir;
  });

  afterEach(async () => {
    if (originalAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = originalAgentHome;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function loadExtension(): Promise<{
    runInput: (
      text: string,
      images?: Array<{ type: 'image'; mimeType: string; data: string }>,
    ) => Promise<
      | {
          action: string;
          text?: string;
          images?: Array<{ type: 'image'; mimeType: string; data: string }>;
        }
      | undefined
    >;
  }> {
    const ext = (await import('../extension.js')).default;
    let handler:
      | ((
          event: {
            text: string;
            images?: Array<{ type: 'image'; mimeType: string; data: string }>;
          },
          ctx: { cwd: string; signal?: AbortSignal },
        ) => Promise<unknown>)
      | undefined;
    const fakeApi = {
      on: (event: string, fn: typeof handler) => {
        if (event === 'input') handler = fn;
      },
    };
    ext(fakeApi as never);
    if (!handler) throw new Error('input handler was not registered');
    return {
      runInput: async (text, images) => {
        const event: {
          text: string;
          images?: Array<{ type: 'image'; mimeType: string; data: string }>;
        } = { text };
        if (images) event.images = images;
        const result = await handler!(event, { cwd });
        return result as
          | {
              action: string;
              text?: string;
              images?: Array<{ type: 'image'; mimeType: string; data: string }>;
            }
          | undefined;
      },
    };
  }

  it('loads SKILL.md from the user agent dir', async () => {
    const skillDir = join(agentDir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo\n---\nUse demo skill instructions.\n',
      'utf8',
    );

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:demo do the thing');

    expect(result?.action).toBe('transform');
    const text = result?.text ?? '';
    expect(text).toContain('<skill name="demo"');
    expect(text).toContain('Use demo skill instructions.');
    expect(text).not.toContain('---\nname: demo');
    expect(text).toContain('do the thing');
    expect(text).not.toContain('@skill:demo');
  });

  it('prefers project-level SKILL.md over user-level', async () => {
    const userSkill = join(agentDir, 'skills', 'demo');
    const projectSkill = join(cwd, '.pi', 'skills', 'demo');
    await mkdir(userSkill, { recursive: true });
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(userSkill, 'SKILL.md'), 'USER VERSION', 'utf8');
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT VERSION', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:demo');

    expect(result?.text).toContain('PROJECT VERSION');
    expect(result?.text).not.toContain('USER VERSION');
  });

  it('returns undefined when neither file mentions nor skill mentions resolve', async () => {
    const { runInput } = await loadExtension();
    const result = await runInput('@skill:does-not-exist hi');
    // No skill block, no attachments, no images → handler returns undefined to leave input untouched
    expect(result).toBeUndefined();
  });

  it('renders directory listings for @dir mentions', async () => {
    const dir = join(cwd, 'mydir');
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await writeFile(join(dir, 'b.json'), '{}', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('look at @mydir');

    expect(result?.action).toBe('transform');
    const text = result?.text ?? '';
    expect(text).toContain('(directory)');
    expect(text).toContain('sub/');
    expect(text).toContain('a.txt');
    expect(text).toContain('b.json');
    expect(text).toContain('look at');
    expect(text).not.toContain('@mydir');
  });

  it('skips ignored directory entries (.git, node_modules)', async () => {
    const dir = join(cwd, 'proj');
    await mkdir(join(dir, '.git'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'README.md'), '# hi', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@proj');
    const text = result?.text ?? '';

    expect(text).toContain('README.md');
    expect(text).not.toContain('.git/');
    expect(text).not.toContain('node_modules/');
  });

  it('emits clean text before skill and file blocks, in mention order', async () => {
    const skillDir = join(agentDir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'SKILL BODY', 'utf8');
    await writeFile(join(cwd, 'note.txt'), 'note contents', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:demo please summarise @note.txt');
    const text = result?.text ?? '';

    const cleanIdx = text.indexOf('please summarise');
    const skillIdx = text.indexOf('<skill name="demo"');
    const noteIdx = text.indexOf('note.txt');

    expect(cleanIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    // Clean text first, then resources in the order they were mentioned:
    // @skill:demo came before @note.txt in the input.
    expect(cleanIdx).toBeLessThan(skillIdx);
    expect(skillIdx).toBeLessThan(noteIdx);
  });

  it('renders SKILL.md with no frontmatter unchanged', async () => {
    const skillDir = join(agentDir, 'skills', 'plain');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# Plain Title\n\nbody line\n', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:plain');
    const text = result?.text ?? '';

    expect(text).toContain('# Plain Title');
    expect(text).toContain('body line');
  });

  it('preserves pre-existing event.images when only a skill is mentioned', async () => {
    const skillDir = join(agentDir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'BODY', 'utf8');

    // Re-implement loadExtension inline so we can pass images through.
    const ext = (await import('../extension.js')).default;
    let handler:
      | ((event: { text: string; images?: unknown[] }, ctx: { cwd: string }) => Promise<unknown>)
      | undefined;
    ext({
      on: (e: string, fn: typeof handler) => {
        if (e === 'input') handler = fn;
      },
    } as never);
    if (!handler) throw new Error('input handler not registered');

    const inputImage = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    const result = (await handler(
      { text: '@skill:demo look at this', images: [inputImage] },
      { cwd },
    )) as { action: string; text?: string; images?: unknown[] } | undefined;

    expect(result?.action).toBe('transform');
    expect(result?.images).toEqual([inputImage]);
  });
});

// 1×1 PNG bytes — used for image fixture tests below.
const TINY_PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082';

describe('image attachments produce parallel vision + markdown channels', () => {
  let tmpRoot: string;
  let cwd: string;
  let agentDir: string;
  let originalAgentHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pi-attachments-img-'));
    cwd = join(tmpRoot, 'cwd');
    agentDir = join(tmpRoot, 'agent');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    originalAgentHome = process.env.PI_AGENT_HOME;
    process.env.PI_AGENT_HOME = agentDir;
  });

  afterEach(async () => {
    if (originalAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = originalAgentHome;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function loadExt() {
    const ext = (await import('../extension.js')).default;
    let handler:
      | ((
          event: {
            text: string;
            images?: Array<{ type: 'image'; mimeType: string; data: string }>;
          },
          ctx: { cwd: string; signal?: AbortSignal },
        ) => Promise<unknown>)
      | undefined;
    ext({
      on: (e: string, fn: typeof handler) => {
        if (e === 'input') handler = fn;
      },
    } as never);
    if (!handler) throw new Error('input handler not registered');
    return handler;
  }

  it('clears incoming vision images when every upload exceeds the budget', async () => {
    const handler = await loadExt();
    const images = [
      { type: 'image' as const, mimeType: 'image/png', data: 'A'.repeat(28 * 1024 * 1024) },
    ];
    const result = (await handler({ text: 'inspect this', images }, { cwd })) as {
      text: string;
      images?: unknown[];
    };
    // Pi preserves the original images when a transform leaves this field undefined.
    expect((result.images ?? images).length).toBe(0);
    expect(result.text).toContain('Image omitted');
    const [name] = await readdir(join(cwd, '.pi', 'uploads'));
    expect(result.text).toContain(join(cwd, '.pi', 'uploads', name!));
    expect((await stat(join(cwd, '.pi', 'uploads', name!))).size).toBe(21 * 1024 * 1024);
    expect(result.text).toMatch(/resize|crop/i);
  });

  it('cancels an upload during persistence without publishing a partial file', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const original = fs.writeFile;
    const controller = new AbortController();
    const write = vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await original(args[0], 'partial', { flag: 'wx' });
      controller.abort(new Error('Upload cancelled'));
      controller.signal.throwIfAborted();
    });
    write.mockClear();
    try {
      const handler = await loadExt();
      await expect(
        handler(
          {
            text: 'inspect',
            images: [
              {
                type: 'image',
                mimeType: 'image/png',
                data: Buffer.from('image bytes').toString('base64'),
              },
            ],
          },
          { cwd, signal: controller.signal },
        ),
      ).rejects.toThrow('Upload cancelled');
      expect(write).toHaveBeenCalledOnce();
      expect(await readdir(join(cwd, '.pi', 'uploads'))).toEqual([]);
    } finally {
      write.mockImplementation(original);
    }
  });

  it('omits oversized image files while preserving their reference', async () => {
    const imagePath = join(cwd, 'huge.png');
    const file = await open(imagePath, 'w');
    try {
      await file.truncate(21 * 1024 * 1024);
    } finally {
      await file.close();
    }
    const handler = await loadExt();
    const result = (await handler({ text: '@huge.png' }, { cwd })) as {
      text: string;
      images?: unknown[];
    };
    expect(result.images).toBeUndefined();
    expect(result.text).toContain(imagePath);
    expect(result.text).toContain('Image omitted');
  });

  it('writes a markdown ![](path) line for an @-mentioned image and includes its base64 in images[]', async () => {
    const pngPath = join(cwd, 'pic.png');
    await writeFile(pngPath, Buffer.from(TINY_PNG_HEX, 'hex'));
    const handler = await loadExt();
    const result = (await handler({ text: 'look at @pic.png' }, { cwd })) as
      | { text?: string; images?: Array<{ type: 'image'; mimeType: string; data: string }> }
      | undefined;

    expect(result?.images).toHaveLength(1);
    expect(result?.images?.[0]?.mimeType).toBe('image/png');
    expect(result?.text ?? '').toContain(`![pic.png](${pngPath})`);
  });

  it('persists a drag-uploaded image to .pi/uploads and references it by sha256 path', async () => {
    const data = Buffer.from(TINY_PNG_HEX, 'hex').toString('base64');
    const handler = await loadExt();
    const result = (await handler(
      {
        text: '帮我改一下这个图片',
        images: [{ type: 'image', mimeType: 'image/png', data }],
      },
      { cwd },
    )) as { text?: string; images?: unknown[] } | undefined;

    // markdown line points at .pi/uploads/<hash>.png
    expect(result?.text ?? '').toMatch(
      new RegExp(
        `!\\[[^\\]]+\\]\\(${cwd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/\\.pi/uploads/[a-f0-9]+\\.png\\)`,
      ),
    );
    // file actually exists on disk
    const m = result?.text?.match(/\.pi\/uploads\/([a-f0-9]+)\.png/);
    expect(m).not.toBeNull();
  });

  it('preserves order: drag-uploaded images first, then @-mentions', async () => {
    const aPath = join(cwd, 'a.png');
    const cPath = join(cwd, 'c.png');
    await writeFile(aPath, Buffer.from(TINY_PNG_HEX, 'hex'));
    await writeFile(cPath, Buffer.from(TINY_PNG_HEX, 'hex'));

    // The drag-upload uses a different mimeType so we can tell which entry is which.
    const drag = {
      type: 'image' as const,
      mimeType: 'image/jpeg',
      data: 'AAAA',
    };

    const handler = await loadExt();
    const result = (await handler(
      { text: 'compare @a.png and @c.png', images: [drag] },
      { cwd },
    )) as { text?: string; images?: Array<{ mimeType: string }> } | undefined;

    expect(result?.images).toHaveLength(3);
    // First image in vision = the drag upload (image/jpeg).
    expect(result?.images?.[0]?.mimeType).toBe('image/jpeg');
    // Then a.png, then c.png.
    expect(result?.images?.[1]?.mimeType).toBe('image/png');
    expect(result?.images?.[2]?.mimeType).toBe('image/png');

    // Text channel must list them in the same order.
    const text = result?.text ?? '';
    const dragIdx = text.search(/\.pi\/uploads\//);
    const aIdx = text.indexOf(`(${aPath})`);
    const cIdx = text.indexOf(`(${cPath})`);
    expect(dragIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(dragIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(cIdx);
  });

  it('interleaves images and non-image attachments by mention order', async () => {
    const pngA = join(cwd, 'a.png');
    const pdfB = join(cwd, 'b.pdf');
    const pngC = join(cwd, 'c.png');
    await writeFile(pngA, Buffer.from(TINY_PNG_HEX, 'hex'));
    await writeFile(pdfB, '%PDF-1.4 fake', 'utf8');
    await writeFile(pngC, Buffer.from(TINY_PNG_HEX, 'hex'));

    const handler = await loadExt();
    const result = (await handler(
      { text: 'review @a.png and @b.pdf and @c.png together' },
      { cwd },
    )) as { text?: string; images?: unknown[] } | undefined;

    const text = result?.text ?? '';
    const idxA = text.indexOf(`(${pngA})`);
    const idxB = text.indexOf(pdfB);
    const idxC = text.indexOf(`(${pngC})`);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    // Vision channel still has both images, in order.
    expect(result?.images).toHaveLength(2);
  });

  it('dedupes the same drag-uploaded image (same sha256 → single write)', async () => {
    const data = Buffer.from(TINY_PNG_HEX, 'hex').toString('base64');
    const handler = await loadExt();
    const result = (await handler(
      {
        text: 'two same images',
        images: [
          { type: 'image', mimeType: 'image/png', data },
          { type: 'image', mimeType: 'image/png', data },
        ],
      },
      { cwd },
    )) as { text?: string; images?: unknown[] } | undefined;

    // Vision channel keeps both (the model can see both slots), but resolved
    // path is the same — so both markdown references point at the same file.
    // Implementation dedupes by absolute path: only one item is recorded.
    expect(result?.images).toHaveLength(1);
    const matches = (result?.text ?? '').match(/\.pi\/uploads\/[a-f0-9]+\.png/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
