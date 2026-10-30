import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_command, _args, _opts, callback) =>
      callback(new Error('fontconfig unavailable')),
    ),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import { renderTextOverlay } from '../text-layer.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-text-font');

afterEach(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

describe('renderTextOverlay font preflight', () => {
  it('refuses Chinese text when no CJK font is available', async () => {
    mkdirSync(suiteDir, { recursive: true });

    await expect(
      renderTextOverlay({
        overlay: { title: '中文标题' },
        width: 640,
        height: 360,
        outPath: join(suiteDir, 'overlay.png'),
      }),
    ).rejects.toThrow(/CJK font/i);
  });

  it('still renders Latin-only text without a CJK font', async () => {
    mkdirSync(suiteDir, { recursive: true });
    const outPath = join(suiteDir, 'overlay.png');

    await expect(
      renderTextOverlay({
        overlay: { title: 'Local title' },
        width: 640,
        height: 360,
        outPath,
      }),
    ).resolves.toBe(outPath);
  });
});
