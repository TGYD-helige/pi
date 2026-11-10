import { describe, expect, it } from 'vitest';
import { BUILT_IN_MODELS, findBuiltInModel } from '../models.js';

describe('BUILT_IN_MODELS registry', () => {
  it('resolves new image models and their documented reference limits', () => {
    for (const [id, alias, provider, references] of [
      ['gpt-image-2.6-flare', 'gpt-image-2.6', 'openai', 16],
      ['gpt-image-2.6-sunburst', 'gpt-image-2.6-sunburst', 'openai', 16],
      ['gemini-nano-banana-2.1', 'nano-banana-2.1', 'gemini', 14],
      ['qwen-image-2.1-pro', 'qwen-image-2.1-pro', 'dashscope', 10],
      ['qwen-image-2.1-turbo', 'qwen-image-2.1-turbo', 'dashscope', 10],
      ['doubao-seedream-5-0-flash-260915', 'seedream-5-flash', 'ark', 10],
    ] as const) {
      const entry = findBuiltInModel(alias);
      expect(entry?.id, alias).toBe(id);
      expect(entry?.provider, id).toBe(provider);
      expect(entry?.capabilities?.maxReferenceImages, id).toBe(references);
    }
    expect(findBuiltInModel('nano-banana-2.1')?.capabilities?.imageSizes).toEqual([
      '1K',
      '2K',
      '4K',
    ]);
  });

  it('routes the supplied Seedream 5.5 ID without claiming unverified model limits', () => {
    const entry = findBuiltInModel('seedream-5.5');
    expect(entry?.id).toBe('seedream-5.5');
    expect(entry?.provider).toBe('ark');
    expect(entry?.capabilities).toBeUndefined();
  });

  it('has unique ids and no alias collisions across the id/alias namespace', () => {
    const seen = new Map<string, string>();
    for (const entry of BUILT_IN_MODELS) {
      for (const name of [entry.id, ...(entry.aliases ?? [])]) {
        const owner = seen.get(name);
        expect(owner, `"${name}" claimed by both ${owner ?? '?'} and ${entry.id}`).toBeUndefined();
        seen.set(name, entry.id);
      }
    }
  });

  it('verified entries declare a capability contract', () => {
    for (const entry of BUILT_IN_MODELS) {
      if (entry.id === 'seedream-5.5') continue;
      expect(entry.capabilities, `${entry.id} is missing capabilities`).toBeDefined();
    }
  });

  it('capability contracts are internally sane', () => {
    for (const entry of BUILT_IN_MODELS) {
      if (entry.id === 'seedream-5.5') continue;
      const caps = entry.capabilities!;
      expect(caps.nMax, entry.id).toBeGreaterThanOrEqual(1);
      expect(caps.maxReferenceImages, entry.id).toBeGreaterThanOrEqual(0);
      expect(caps.inputFormats.length, entry.id).toBeGreaterThan(0);
      expect(caps.inputMaxBytes, entry.id).toBeGreaterThan(0);
      // Gemini-style models expose aspect ratios and no pixel-size knob.
      if (caps.aspectRatios) {
        expect(caps.sizeRange, entry.id).toBeUndefined();
        expect(caps.sizes, entry.id).toBeUndefined();
        expect(caps.aspectRatios.length, entry.id).toBeGreaterThan(0);
      }
      const range = caps.sizeRange;
      if (range) {
        expect(range.maxArea, entry.id).toBeGreaterThan(range.minArea);
        if (range.minRatio != null && range.maxRatio != null) {
          expect(range.maxRatio, entry.id).toBeGreaterThan(range.minRatio);
        }
        for (const tier of range.tiers ?? []) {
          expect(tier, `${entry.id} tier "${tier}"`).toMatch(/^\d+(\.\d)?K$/);
        }
      }
    }
  });

  it('registers qwen-image-3.0 and 3.0-pro on dashscope with the asterisk size form', () => {
    for (const id of ['qwen-image-3.0', 'qwen-image-3.0-pro']) {
      const entry = findBuiltInModel(id);
      expect(entry, id).toBeDefined();
      expect(entry?.provider).toBe('dashscope');
      expect(entry?.capabilities?.sizeRange?.separator).toBe('*');
      expect(entry?.capabilities?.nMax).toBe(6);
      expect(entry?.capabilities?.maxReferenceImages).toBe(3);
    }
  });

  it('routes the retired seedream pro id to the current -260628 entry', () => {
    const legacy = findBuiltInModel('doubao-seedream-5-0-pro-260128');
    expect(legacy?.id).toBe('doubao-seedream-5-0-pro-260628');
    expect(findBuiltInModel('seedream-5-pro')?.id).toBe('doubao-seedream-5-0-pro-260628');
  });

  it('resolves the 5.0 and 5.0-lite ids to one merged entry', () => {
    const plain = findBuiltInModel('doubao-seedream-5-0-260128');
    const lite = findBuiltInModel('doubao-seedream-5-0-lite-260128');
    expect(plain?.id).toBe('doubao-seedream-5-0-260128');
    expect(lite?.id).toBe(plain?.id);
    // The generic aliases keep pointing at the latest stable 5.0 release.
    expect(findBuiltInModel('seedream')?.id).toBe(plain?.id);
    expect(findBuiltInModel('seedream-5-lite')?.id).toBe(plain?.id);
  });

  it('registers gpt-image-2.5 flare/sunburst on openai with the gpt-image-2 contract', () => {
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      const entry = findBuiltInModel(id);
      expect(entry, id).toBeDefined();
      expect(entry?.provider).toBe('openai');
      expect(entry?.capabilities?.sizeRange?.allowAuto).toBe(true);
      expect(entry?.capabilities?.nMax).toBe(10);
      expect(entry?.capabilities?.maxReferenceImages).toBe(16);
    }
    // The generic 2.5 id points at the default tier.
    expect(findBuiltInModel('gpt-image-2.5')?.id).toBe('gpt-image-2.5-flare');
  });

  it('limits nano-banana-2-lite to the standard 10 aspect ratios', () => {
    const lite = findBuiltInModel('gemini-3.1-flash-lite-image');
    expect(lite?.capabilities?.aspectRatios).toHaveLength(10);
    expect(findBuiltInModel('gemini-3.1-flash-image')?.capabilities?.aspectRatios).toHaveLength(14);
  });
});
