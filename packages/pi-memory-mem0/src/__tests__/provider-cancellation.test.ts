import { classifyError } from '@amaster.ai/pi-shared';
import { describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

const search = vi.fn(() => new Promise(() => {}));

vi.mock('mem0ai', () => ({
  MemoryClient: class {
    _fetchWithErrorHandling = vi.fn();
    search = search;
  },
}));

describe('SDK-backed Mem0 provider cancellation', () => {
  it('stops waiting for a platform SDK request when the caller aborts', async () => {
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = provider.search('pets', {
      userId: 'company-1',
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

describe('Self-hosted Mem0 failure categories', () => {
  it.each([
    'request',
    'body',
  ])('keeps transport errors during %s separate from invalid JSON', async (phase) => {
    const original = globalThis.fetch;
    const reason = new TypeError('secret-token', {
      cause: Object.assign(new Error('secret-token'), { code: 'ECONNRESET' }),
    });
    globalThis.fetch = vi.fn(async () => {
      if (phase === 'request') throw reason;
      return Object.assign(new Response('{}'), {
        json: async () => {
          throw reason;
        },
      });
    });
    try {
      const provider = await createMem0Provider({
        config: { mode: 'self-hosted', baseUrl: 'https://fixture.invalid' },
      });
      const error = await provider.search('fixture', { userId: 'fixture' }).catch((error) => error);
      expect(classifyError(error).errorCategory).toBe('network_error');
      expect(error.message).not.toContain('invalid response');
      expect(JSON.stringify(error)).not.toContain('secret-token');
    } finally {
      globalThis.fetch = original;
    }
  });
});
