import { describe, expect, it, vi } from 'vitest';
import {
  classifyError,
  createModelErrorCapture,
  describeToolError,
  modelResponseError,
  SafeToolError,
} from '../tool-errors.js';

describe('tool errors', () => {
  it('preserves streamed response metadata, consumption, and cloning', async () => {
    const source = new Response('{"ok":true}', {
      status: 201,
      statusText: 'Created',
      headers: { 'x-test': 'value' },
    });
    Object.defineProperties(source, {
      url: { value: 'https://example.com/result' },
      redirected: { value: true },
      type: { value: 'basic' },
    });
    const errors = createModelErrorCapture();
    const response = await errors.fetchOptions('openai-completions', async () => source).fetch!(
      'https://example.com',
    );
    expect(response).toBeInstanceOf(Response);
    expect(response.bodyUsed).toBe(false);
    const clone = response.clone();
    for (const item of [response, clone]) {
      expect(item.url).toBe(source.url);
      expect(item.redirected).toBe(true);
      expect(item.type).toBe('basic');
      expect(item.status).toBe(201);
      expect(item.headers.get('x-test')).toBe('value');
    }
    await expect(Promise.all([response.json(), clone.json()])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(response.bodyUsed).toBe(true);
    expect(() => response.clone()).toThrow();
  });

  it('cancels and unlocks a pending response body read', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const errors = createModelErrorCapture();
    const response = await errors.fetchOptions(
      'openai-completions',
      async () => new Response(source),
    ).fetch!('https://example.com');
    const reader = response.body!.getReader();
    const pending = reader.read();
    await reader.cancel('caller cancelled');
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledWith('caller cancelled');
    expect(source.locked).toBe(false);
    reader.releaseLock();
    expect(errors.error('Model', { stopReason: 'aborted' }).errorCategory).toBe('cancelled');
  });

  it('captures network causes before flattening and clears recovered transport failures', async () => {
    const errors = createModelErrorCapture();
    const raw = new TypeError('fetch failed', {
      cause: Object.assign(new Error('test-token'), { code: 'ECONNRESET' }),
    });
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(raw)
      .mockResolvedValueOnce(new Response('{}'));
    const wrapped = errors.fetchOptions('openai-completions', request).fetch!;
    errors.run(() => {});
    await expect(wrapped('https://example.com')).rejects.toBe(raw);
    expect(
      errors.error('Model', { stopReason: 'error', errorMessage: 'fetch failed' }).errorCategory,
    ).toBe('network_error');
    expect(JSON.stringify(errors.error('Model', { stopReason: 'error' }))).not.toContain(
      'test-token',
    );
    await wrapped('https://example.com');
    expect(errors.error('Model', { stopReason: 'error' }).errorCategory).toBe('request_failed');
    expect(errors.fetchOptions('google-generative-ai', request)).toEqual({});
    expect(errors.fetchOptions('google-vertex', request)).toEqual({});
    expect(errors.fetchOptions('bedrock-converse-stream', request)).toEqual({});
  });

  it('uses a later terminal timeout instead of an earlier retryable HTTP failure', async () => {
    const errors = createModelErrorCapture();
    const request = errors.fetchOptions(
      'openai-completions',
      async () => new Response('', { status: 503 }),
    ).fetch!;
    errors.run(() => {});
    await request('https://example.com');
    expect(
      errors.error('Model', { stopReason: 'error', errorMessage: 'request timed out' })
        .errorCategory,
    ).toBe('timeout');
  });

  it('retains a synchronously thrown model cause without carrying raw error objects', () => {
    const errors = createModelErrorCapture();
    expect(() =>
      errors.run(() => {
        throw new TypeError('test-token', {
          cause: Object.assign(new Error(), { code: 'ECONNRESET' }),
        });
      }),
    ).toThrow();
    const failure = errors.error('Model', { stopReason: 'error', errorMessage: 'fetch failed' });
    expect(failure.errorCategory).toBe('network_error');
    expect(failure.cause).toBeUndefined();
    expect(failure.message).not.toContain('test-token');
    errors.run(() => {});
    expect(errors.error('Model', { stopReason: 'error' }).errorCategory).toBe('request_failed');
  });

  it.each([
    ['TimeoutError: test-token', 'error', 'timeout'],
    ['request timed out: test-token', 'error', 'timeout'],
    ['The operation was aborted due to timeout', 'error', 'timeout'],
    ['AbortError: test-token', 'error', 'cancelled'],
    ['test-token', 'aborted', 'cancelled'],
    ['test-token', 'error', 'request_failed'],
    ['x'.repeat(1024) + 'TimeoutError', 'error', 'request_failed'],
  ])('recovers only surviving model error categories', (errorMessage, stopReason, category) => {
    const failure = modelResponseError('Model', { errorMessage, stopReason });
    expect(classifyError(failure)).toEqual({ errorCategory: category });
    expect(failure.message).not.toContain('test-token');
    expect(failure.cause).toBeUndefined();
  });

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
