import { describe, expect, it } from 'vitest';
import { createSourceObservationReceipt } from '../source-observation.js';

describe('createSourceObservationReceipt', () => {
  it('returns content-free metadata and redacts locator credentials and query values', () => {
    const receipt = createSourceObservationReceipt({
      runId: 'run-1',
      toolName: 'web_fetch',
      requestedLocator: 'https://user:pass@example.com/private?token=secret#section',
      finalLocator: 'https://example.com/private?session=other-secret',
      mediaType: 'text/html',
      content: 'sensitive source body',
      truncated: false,
      now: new Date('2026-08-05T10:00:00.000Z'),
      observationId: 'observation-1',
    });

    expect(receipt).toEqual({
      version: 'source_observation_v1',
      observationId: 'observation-1',
      runId: 'run-1',
      toolName: 'web_fetch',
      requestedLocator: 'https://example.com/private',
      finalLocator: 'https://example.com/private',
      capturedAt: '2026-08-05T10:00:00.000Z',
      mediaType: 'text/html',
      contentHash: 'sha256:30eb575e8e123670455e5235aa8c52f02f32dacc2430f408e09243a6b9809cec',
      observedChars: 21,
      observedBytes: 21,
      truncated: false,
    });
    expect(JSON.stringify(receipt)).not.toContain('sensitive source body');
    expect(JSON.stringify(receipt)).not.toContain('secret');
  });
});
