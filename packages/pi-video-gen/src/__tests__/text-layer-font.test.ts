import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fontStat } = vi.hoisted(() => ({ fontStat: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: fontStat,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_command, _args, _opts, callback) =>
      callback(Object.assign(new Error('fontconfig unavailable'), { code: 'ENOENT' })),
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

import { hasCjkFont, renderTextOverlay } from '../text-layer.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-text-font');

beforeEach(() => {
  fontStat.mockReset().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  vi.mocked(existsSync).mockReturnValue(false);
});

afterEach(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

describe('renderTextOverlay font preflight', () => {
  it('honors cancellation before the known-font fast path', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(true);
    fontStat.mockResolvedValue({ isFile: () => true });
    const controller = new AbortController();
    controller.abort();
    await expect(hasCjkFont(controller.signal)).rejects.toThrow(/cancelled/i);
    expect(fontStat.mock.calls.length).toBe(0);
  });

  it('checks cancellation after an asynchronous font lookup', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(true);
    const controller = new AbortController();
    fontStat.mockImplementationOnce(async () => {
      controller.abort();
      return { isFile: () => true };
    });
    await expect(hasCjkFont(controller.signal)).rejects.toThrow(/cancelled/i);
  });

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
