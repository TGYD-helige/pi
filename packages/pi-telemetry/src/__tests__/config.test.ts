import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';

describe('config', () => {
  it('only enables media when content export is explicitly enabled', () => {
    expect(resolveConfig({ mediaUploadEnabled: true })).toMatchObject({
      includePayloads: false,
      mediaUploadEnabled: false,
    });
    expect(resolveConfig({ includePayloads: true, mediaUploadEnabled: true })).toMatchObject({
      mediaUploadEnabled: true,
    });
    expect(resolveConfig({ includePayloads: true })).toMatchObject({ mediaUploadEnabled: false });
  });

  it('excludes payloads by default', () => {
    expect(resolveConfig()).toMatchObject({
      includePayloads: false,
    });
  });
});
