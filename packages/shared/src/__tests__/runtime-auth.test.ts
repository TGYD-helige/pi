import { describe, expect, it, vi } from 'vitest';
import { resolveRuntimeProviderAuth } from '../runtime-auth.js';

function registry(apiKey: string, baseUrl: string) {
  const model = {
    provider: 'amaster',
    baseUrl,
    headers: { 'x-model-header': 'model' },
  };
  return {
    getAll: vi.fn(() => [model]),
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true as const,
      apiKey,
      headers: { 'x-runtime-header': 'runtime' },
    })),
  };
}

describe('resolveRuntimeProviderAuth', () => {
  it('resolves credentials from the current session registry', async () => {
    const result = await resolveRuntimeProviderAuth(
      'amaster',
      registry('company-a-key', 'https://company-a.example/v1'),
    );

    expect(result).toEqual({
      ok: true,
      apiKey: 'company-a-key',
      baseUrl: 'https://company-a.example/v1',
      headers: {
        'x-model-header': 'model',
        'x-runtime-header': 'runtime',
      },
    });
  });

  it('keeps concurrent session credentials isolated', async () => {
    const [companyA, companyB] = await Promise.all([
      resolveRuntimeProviderAuth(
        'amaster',
        registry('company-a-key', 'https://company-a.example/v1'),
      ),
      resolveRuntimeProviderAuth(
        'amaster',
        registry('company-b-key', 'https://company-b.example/v1'),
      ),
    ]);

    expect(companyA).toMatchObject({ ok: true, apiKey: 'company-a-key' });
    expect(companyB).toMatchObject({ ok: true, apiKey: 'company-b-key' });
  });

  it('fails closed when the provider has no model in the session registry', async () => {
    const result = await resolveRuntimeProviderAuth('amaster', {
      getAll: () => [],
      getApiKeyAndHeaders: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      error: 'Runtime auth provider "amaster" is not available in this session.',
    });
  });
});
