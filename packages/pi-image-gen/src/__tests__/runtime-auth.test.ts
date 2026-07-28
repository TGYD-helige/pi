import { describe, expect, it, vi } from 'vitest';
import { resolveModel } from '../config.js';
import { openaiAdapter } from '../providers/openai.js';
import { materializeImageGenSettings } from '../runtime-auth.js';
import type { ImageGenSettings } from '../types.js';

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

const settings: ImageGenSettings = {
  defaultModel: 'gpt-image-1',
  customProviders: {
    amaster: {
      api: 'openai',
      apiKey: 'stale-shared-key',
      baseUrl: 'https://stale.example/v1',
      headers: {
        authorization: 'Bearer stale-shared-key',
        'x-static': 'kept',
      },
      runtimeAuthProvider: 'amaster',
      models: ['gpt-image-1'],
    },
  },
};

describe('image provider runtime auth', () => {
  it('materializes a session-local provider configuration', async () => {
    const result = await materializeImageGenSettings(
      settings,
      registry('company-a-key', 'https://company-a.example/v1'),
    );

    expect(result.customProviders?.amaster).toEqual({
      api: 'openai',
      apiKey: 'company-a-key',
      baseUrl: 'https://company-a.example/v1',
      headers: {
        'x-static': 'kept',
        'x-company': 'company-a-key',
      },
      runtimeAuthProvider: 'amaster',
      models: ['gpt-image-1'],
    });
    expect(settings.customProviders?.amaster?.apiKey).toBe('stale-shared-key');
  });

  it('removes static credentials when session auth is unavailable', async () => {
    const result = await materializeImageGenSettings(settings, {
      getAll: () => [],
      getApiKeyAndHeaders: vi.fn(),
    });

    expect(result.customProviders?.amaster).toEqual({
      api: 'openai',
      headers: { 'x-static': 'kept' },
      runtimeAuthProvider: 'amaster',
      models: ['gpt-image-1'],
    });
  });

  it('keeps concurrent session configurations isolated', async () => {
    const [companyA, companyB] = await Promise.all([
      materializeImageGenSettings(
        settings,
        registry('company-a-key', 'https://company-a.example/v1'),
      ),
      materializeImageGenSettings(
        settings,
        registry('company-b-key', 'https://company-b.example/v1'),
      ),
    ]);

    expect(companyA.customProviders?.amaster?.apiKey).toBe('company-a-key');
    expect(companyB.customProviders?.amaster?.apiKey).toBe('company-b-key');
  });

  it('uses session auth in the outbound image request', async () => {
    const materialized = await materializeImageGenSettings(
      settings,
      registry('company-a-key', 'https://company-a.example/v1'),
    );
    const resolved = resolveModel('gpt-image-1', materialized);
    if ('error' in resolved) throw new Error(resolved.error);
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }),
    ) as unknown as typeof fetch;

    await openaiAdapter.generate(
      resolved.provider,
      resolved.remoteId,
      { prompt: 'runtime auth' },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchMock).mock.calls[0]!;
    expect(url).toBe('https://company-a.example/v1/images/generations');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer company-a-key',
      'x-company': 'company-a-key',
      'x-static': 'kept',
    });
  });
});
