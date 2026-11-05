import { describe, expect, it } from 'vitest';
import { classifyError, describeToolError, SafeToolError } from '../tool-errors.js';

describe('tool errors', () => {
  it.each([
    [new DOMException('secret', 'TimeoutError'), 'timeout'],
    [new DOMException('secret', 'AbortError'), 'cancelled'],
    [new Error('secret', { cause: new DOMException('secret', 'TimeoutError') }), 'timeout'],
    [
      Object.assign(new Error('secret'), {
        name: 'AbortError',
        cause: new DOMException('secret', 'TimeoutError'),
      }),
      'timeout',
    ],
    [Object.assign(new Error('secret'), { errorCategory: 'secret' }), 'request_failed'],
    [Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }), 'timeout'],
    [Object.assign(new Error('secret'), { code: -32001 }), 'timeout'],
    [
      new TypeError('secret', {
        cause: Object.assign(new Error('secret'), { code: 'UND_ERR_BODY_TIMEOUT' }),
      }),
      'timeout',
    ],
    [Object.assign(new Error('secret'), { code: 'ECONNRESET' }), 'network_error'],
    [new Error('provider API error 503: secret'), 'http_error'],
    [new Error('secret timeout in provider body'), 'request_failed'],
    ['secret', 'request_failed'],
  ])('retains only a safe category for %s', (error, category) => {
    const result = describeToolError('Fixture', error);
    expect(result.errorCategory).toBe(category);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('retains HTTP status and safe classification through a sanitized boundary', () => {
    const error = new SafeToolError('Fixture', new Error('HTTP 429: secret'));
    expect(classifyError(error)).toEqual({ errorCategory: 'http_error', httpStatus: 429 });
    expect(error.message).toContain('HTTP 429');
    expect(describeToolError('Outer boundary', error).error).toBe(error.message);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('preserves write uncertainty without recommending an automatic retry', () => {
    const result = describeToolError(
      'Send',
      new DOMException('secret', 'TimeoutError'),
      'Delivery may have completed. Inspect delivery state before retrying.',
    );
    expect(result.error).toContain('timed out');
    expect(result.error).toContain('Delivery may have completed');
    expect(result.error).not.toContain('retry later');
  });

  it('bounds cyclic causes', () => {
    const error = new Error('secret');
    error.cause = error;
    expect(classifyError(error).errorCategory).toBe('request_failed');
  });
});
