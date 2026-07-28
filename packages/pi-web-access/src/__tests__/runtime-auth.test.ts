import { describe, expect, it, vi } from 'vitest';
import { resolveProviderForSession, resolveSearchProviderForSession } from '../runtime-auth.js';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

function registry(apiKey: string, baseUrl: string) {
  const model = { provider: 'amaster', baseUrl };
  return {
    getAll: vi.fn(() => [model]),
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true as const,
      apiKey,
      headers: { 'x-company': apiKey },
    })),
  };
}

const settings: WebToolSettings = {
  search: { provider: 'kimi' },
  providers: {
    kimi: {
      apiKey: 'stale-shared-key',
      baseUrl: 'https://stale.example/v1',
      headers: {
        Authorization: 'Bearer stale-shared-key',
        'x-static': 'kept',
      },
      runtimeAuthProvider: 'amaster',
    },
  },
};

describe('web provider runtime auth', () => {
  it('materializes the provider with session auth and endpoint', async () => {
    const result = await resolveSearchProviderForSession(
      settings,
      registry('company-a-key', 'https://company-a.example/v1'),
    );

    expect(result).toEqual({
      id: 'kimi',
      apiKey: 'company-a-key',
      baseUrl: 'https://company-a.example/v1',
      model: 'kimi-k2.6',
      headers: {
        'x-static': 'kept',
        'x-company': 'company-a-key',
      },
    });
  });

  it('does not fall back to a static key when runtime auth fails', async () => {
    const result = await resolveProviderForSession('kimi', settings, {
      getAll: () => [],
      getApiKeyAndHeaders: vi.fn(),
    });

    expect(result).toEqual({
      error: 'Runtime auth provider "amaster" is not available in this session.',
    });
  });

  it('resolves the same provider independently for concurrent sessions', async () => {
    const [companyA, companyB] = await Promise.all([
      resolveSearchProviderForSession(
        settings,
        registry('company-a-key', 'https://company-a.example/v1'),
      ),
      resolveSearchProviderForSession(
        settings,
        registry('company-b-key', 'https://company-b.example/v1'),
      ),
    ]);

    expect(companyA).toMatchObject({ apiKey: 'company-a-key' });
    expect(companyB).toMatchObject({ apiKey: 'company-b-key' });
  });

  it('auto-selects a provider backed only by session auth', async () => {
    const result = await resolveSearchProviderForSession(
      { providers: settings.providers! },
      registry('company-a-key', 'https://company-a.example/v1'),
    );

    expect(result).toMatchObject({
      id: 'kimi',
      apiKey: 'company-a-key',
    });
  });

  it('uses session auth in the outbound search request', async () => {
    const provider = await resolveSearchProviderForSession(
      settings,
      registry('company-a-key', 'https://company-a.example/v1'),
    );
    if ('error' in provider) throw new Error(provider.error);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    try {
      await search({ query: 'runtime auth' }, settings, provider);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://company-a.example/v1/chat/completions');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer company-a-key',
        'x-company': 'company-a-key',
        'x-static': 'kept',
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
