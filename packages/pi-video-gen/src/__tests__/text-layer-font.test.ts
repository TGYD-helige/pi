import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fontStat, fontRun } = vi.hoisted(() => ({ fontStat: vi.fn(), fontRun: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: fontStat,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: fontRun }),
  };
});

import { hasCjkFont, renderTextOverlay } from '../text-layer.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-text-font');

beforeEach(() => {
  fontStat.mockReset().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  fontRun
    .mockReset()
    .mockRejectedValue(Object.assign(new Error('fontconfig unavailable'), { code: 'ENOENT' }));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(suiteDir, { recursive: true, force: true });
});

describe('renderTextOverlay font preflight', () => {
  it('cancels stalled font metadata without waiting for it or starting fontconfig', async () => {
    let finish: (value: unknown) => void = () => {};
    fontStat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { CancelledError } = await import('../providers/task.js');
    const controller = new AbortController();
    let settled = false;
    const result = hasCjkFont(controller.signal).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(await result).toBeInstanceOf(CancelledError);
    finish({ isFile: () => true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fontStat.mock.calls.length).toBe(1);
    expect(fontRun.mock.calls.length).toBe(0);
  });

  it('applies one font deadline to stalled metadata and never starts fontconfig afterward', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let finish: (value: unknown) => void = () => {};
    fontStat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let settled = false;
    const result = hasCjkFont().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(true);
    expect(await result).toBe(false);
    finish({ isFile: () => true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fontStat.mock.calls.length).toBe(1);
    expect(fontRun.mock.calls.length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares fontconfig work and cached results despite different metadata latencies', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let delay = 1;
    fontStat.mockImplementation(async (path: string) => {
      if (path === 'fc-list') return { ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 };
      await new Promise((resolve) => setTimeout(resolve, delay));
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    let finish: (value: { stdout: string }) => void = () => {};
    fontRun.mockImplementationOnce(
      () =>
        new Promise<{ stdout: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const first = hasCjkFont();
    await vi.advanceTimersByTimeAsync(10);
    delay = 2;
    const second = hasCjkFont();
    await vi.advanceTimersByTimeAsync(20);
    expect(fontRun.mock.calls.length).toBe(1);
    finish({ stdout: 'Noto Sans CJK' });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    const cached = hasCjkFont();
    await vi.advanceTimersByTimeAsync(20);
    expect(await cached).toBe(true);
    expect(fontRun.mock.calls.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors cancellation before the known-font fast path', async () => {
    fontStat.mockResolvedValue({ isFile: () => true });
    const controller = new AbortController();
    controller.abort();
    await expect(hasCjkFont(controller.signal)).rejects.toThrow(/cancelled/i);
    expect(fontStat.mock.calls.length).toBe(0);
  });

  it('checks cancellation after an asynchronous font lookup', async () => {
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
