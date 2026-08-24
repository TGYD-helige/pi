import { describe, expect, it } from 'vitest';
import { BUILT_IN_VIDEO_MODELS, findBuiltInModel } from '../providers/models.js';

describe('model registry', () => {
  it('contains only smoke-testable models (no placeholders)', () => {
    expect(BUILT_IN_VIDEO_MODELS.length).toBeGreaterThanOrEqual(9);
    for (const m of BUILT_IN_VIDEO_MODELS) {
      expect(['ark', 'dashscope', 'kling', 'openrouter', 'minimax']).toContain(m.provider);
      expect(
        m.id.startsWith('doubao-seedance-2-0-') ||
          m.id.startsWith('happyhorse-') ||
          m.id.startsWith('kling-') ||
          m.id.startsWith('google/') ||
          m.id.startsWith('MiniMax-'),
      ).toBe(true);
      expect(m.capabilities.durations[0]).toBeLessThan(m.capabilities.durations[1]);
      expect(m.defaultResolution).toBeOneOf(m.capabilities.resolutions);
      expect(m.defaultAspectRatio).toBeOneOf(m.capabilities.aspectRatios);
    }
  });

  it('minimax entry: v2 contract — 768P/2K, flf, no audio, no adaptive ratio', () => {
    const h3 = findBuiltInModel('minimax-h3')!;
    expect(h3.id).toBe('MiniMax-H3');
    expect(h3.provider).toBe('minimax');
    expect(h3.capabilities.resolutions).toEqual(['768P', '2K']);
    expect(h3.capabilities.aspectRatios).not.toContain('adaptive');
    expect(h3.capabilities.nativeAudio).toBe(false);
    expect(h3.capabilities.supportsFirstLastFrame).toBe(true);
    expect(h3.capabilities.durations).toEqual([4, 15]);
    expect(findBuiltInModel('MiniMax-H3')?.id).toBe('MiniMax-H3');
    expect(findBuiltInModel('h3')?.id).toBe('MiniMax-H3');
  });

  it('aliases always carry a version marker (no vendor-name aliases)', () => {
    // A version-less alias (seedance, kling, minimax) becomes ambiguous the
    // day the next model generation ships — the registry must never regain one.
    for (const m of BUILT_IN_VIDEO_MODELS) {
      for (const alias of m.aliases) {
        expect(alias, `${m.id} alias "${alias}" has no version marker`).toMatch(/\d/);
      }
    }
  });

  it('version-less vendor aliases do not resolve', () => {
    for (const alias of [
      'seedance',
      'seedance-fast',
      'seedance-mini',
      'seedance-std',
      'happyhorse',
      'kling',
      'kling-turbo',
      'kling-omni',
      'veo',
      'minimax',
    ]) {
      expect(findBuiltInModel(alias), alias).toBeUndefined();
    }
  });

  it('veo entry: openrouter provider, audio + flf, 5-8s', () => {
    const veo = findBuiltInModel('veo-3.1')!;
    expect(veo.id).toBe('google/veo-3.1');
    expect(veo.provider).toBe('openrouter');
    expect(veo.capabilities.nativeAudio).toBe(true);
    expect(veo.capabilities.supportsFirstLastFrame).toBe(true);
    expect(veo.capabilities.durations).toEqual([5, 8]);
  });

  it('kling entries: turbo silent, omni audio-capable', () => {
    const turbo = findBuiltInModel('kling-v3-turbo')!;
    expect(turbo.id).toBe('kling-3.0-turbo');
    expect(turbo.provider).toBe('kling');
    expect(turbo.capabilities.nativeAudio).toBe(false);
    expect(turbo.capabilities.supportsFirstLastFrame).toBe(false);
    const omni = findBuiltInModel('kling-v3-omni')!;
    expect(omni.id).toBe('kling-3.0');
    expect(omni.capabilities.nativeAudio).toBe(true);
    expect(omni.capabilities.supportsFirstLastFrame).toBe(true);
    expect(omni.capabilities.resolutions).toContain('4k');
  });

  it('happyhorse entries: dashscope provider, no audio, no last-frame', () => {
    const hh = findBuiltInModel('happyhorse-1.1')!;
    expect(hh.id).toBe('happyhorse-1.1');
    expect(hh.provider).toBe('dashscope');
    expect(hh.capabilities.nativeAudio).toBe(false);
    expect(hh.capabilities.supportsFirstLastFrame).toBe(false);
    expect(hh.capabilities.maxReferenceImages).toBe(9);
  });

  it('resolves the seedance 2.0 aliases to their dated model ids', () => {
    expect(findBuiltInModel('seedance-2.0')?.id).toBe('doubao-seedance-2-0-260128');
    expect(findBuiltInModel('seedance-2.0-fast')?.id).toBe('doubao-seedance-2-0-fast-260128');
    expect(findBuiltInModel('seedance-2.0-mini')?.id).toBe('doubao-seedance-2-0-mini-260615');
  });

  it('declares current-account trusted image/video/audio assets for Seedance 2.0', () => {
    for (const id of ['seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini']) {
      const capabilities = findBuiltInModel(id)!.capabilities;
      expect(capabilities.referenceAssetModalities).toEqual(['image', 'video', 'audio']);
      expect(capabilities.maxReferenceImages).toBe(9);
      expect(capabilities.maxReferenceVideos).toBe(3);
      expect(capabilities.maxReferenceAudios).toBe(3);
    }
    expect(
      findBuiltInModel('kling-v3-turbo')!.capabilities.referenceAssetModalities,
    ).toBeUndefined();
  });

  it('fast/mini cap resolution at 720p', () => {
    for (const id of ['seedance-2.0-fast', 'seedance-2.0-mini']) {
      const caps = findBuiltInModel(id)!.capabilities;
      expect(caps.resolutions).not.toContain('1080p');
    }
  });

  it('returns undefined for unknown ids', () => {
    expect(findBuiltInModel('seedance-2.5')).toBeUndefined();
    expect(findBuiltInModel('')).toBeUndefined();
  });
});
