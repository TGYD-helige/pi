import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

describe('platform Mem0 provider signal propagation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the caller signal into the SDK fetch request', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });
    const controller = new AbortController();
    const pending = provider.search('pets', {
      userId: 'company-1',
      signal: controller.signal,
    });

    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/v3/memories/search/') && init?.signal === controller.signal,
        ),
      ).toBe(true),
    );
    const requestCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/v3/memories/search/') && init?.signal === controller.signal,
    )!;
    expect(requestCall[1]?.signal).toBe(controller.signal);
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
  });
});
