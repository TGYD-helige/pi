import { describe, expect, it } from 'vitest';
import { sessionToolResult } from '../session-control.js';

describe('sessionToolResult error classification', () => {
  it('keeps a session deadline distinct from a lost connection', async () => {
    const result = await sessionToolResult('retain', async () => {
      throw new DOMException('secret-token', 'TimeoutError');
    });
    expect(result).toHaveProperty('structuredContent.errorCategory', 'timeout');
    expect(result.content[0]!.text).toContain('timed out');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});
