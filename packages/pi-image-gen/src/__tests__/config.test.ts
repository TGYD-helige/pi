import { describe, expect, it, vi } from 'vitest';
import { resolveModel } from '../config.js';
import type { ImageGenSettings } from '../types.js';

describe('resolveModel', () => {
  it('routes nano-banana alias to gemini provider', () => {
    process.env.GEMINI_API_KEY = 'gem-test';
    const result = resolveModel('nano-banana', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('gemini');
    expect(result.provider.api).toBe('gemini');
    expect(result.remoteId).toBe('gemini-2.5-flash-image');
    expect(result.provider.apiKey).toBe('gem-test');
  });

  it('routes gpt-image-2 to openai', () => {
    process.env.OPENAI_API_KEY = 'oa-test';
    const result = resolveModel('gpt-image-2', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('openai');
    expect(result.remoteId).toBe('gpt-image-2');
    expect(result.requestedId).toBe('gpt-image-2');
  });

  it('routes qwen-image-2.0 to dashscope', () => {
    process.env.DASHSCOPE_API_KEY = 'ds-test';
    const result = resolveModel('qwen-image-2.0', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('dashscope');
    expect(result.remoteId).toBe('qwen-image-2.0');
    expect(result.provider.baseUrl).toContain('dashscope.aliyuncs.com');
  });

  it('does not interpolate environment variables in resolver input', () => {
    process.env.MY_KEY = 'override-key';
    const settings: ImageGenSettings = {
      providers: {
        // Build the literal `${MY_KEY}` at runtime so the source code itself
        // does not contain a `${...}` sequence inside a single-quoted string,
        // which would trip lint/suspicious/noTemplateCurlyInString.
        openai: { apiKey: `$${'{MY_KEY}'}`, baseUrl: 'https://proxy.example.com/v1' },
      },
    };
    const result = resolveModel('gpt-image-2', settings);
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.apiKey).toBe(`$${'{MY_KEY}'}`);
    expect(result.provider.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('falls back to the provider environment key after an empty override', () => {
    process.env.OPENAI_API_KEY = 'provider-key';
    const result = resolveModel('gpt-image-2', {
      providers: {
        openai: { apiKey: '' },
      },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.apiKey).toBe('provider-key');
  });

  it('matches a custom provider by alias', () => {
    process.env.MY_SD_KEY = 'sd-key';
    const settings: ImageGenSettings = {
      customProviders: {
        'my-sd': {
          api: 'openai',
          baseUrl: 'https://api.my-sd.test/v1',
          apiKey: 'sd-key',
          models: [{ id: 'sd-3-large', alias: 'sd3' }, 'sd-3-medium'],
        },
      },
    };
    const a = resolveModel('sd3', settings);
    if ('error' in a) throw new Error(a.error);
    expect(a.provider.id).toBe('my-sd');
    expect(a.provider.builtIn).toBe(false);
    expect(a.remoteId).toBe('sd-3-large');
    expect(a.provider.apiKey).toBe('sd-key');

    const b = resolveModel('sd-3-medium', settings);
    if ('error' in b) throw new Error(b.error);
    expect(b.remoteId).toBe('sd-3-medium');
  });

  it('falls back to the API default after an empty custom provider base URL', () => {
    const result = resolveModel('custom-image', {
      customProviders: {
        gateway: {
          api: 'openai',
          baseUrl: '',
          apiKey: 'gateway-key',
          models: ['custom-image'],
        },
      },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('supports <provider>/<remote-id> fallback for openrouter', () => {
    process.env.OPENROUTER_API_KEY = 'or-test';
    const result = resolveModel('openrouter/google/gemini-2.5-flash-image', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('openrouter');
    expect(result.remoteId).toBe('google/gemini-2.5-flash-image');
  });

  it('returns an error for an unknown model', () => {
    const result = resolveModel('totally-made-up-model', {});
    expect('error' in result).toBe(true);
  });

  it('error message lists configured customProviders when nothing matched', () => {
    const result = resolveModel('totally-made-up-model', {
      customProviders: {
        narrow: {
          api: 'openai',
          baseUrl: 'https://narrow.example/',
          apiKey: 'k',
          models: [{ id: 'x' }],
        },
      },
    });
    if (!('error' in result)) throw new Error('expected error');
    expect(result.error).toContain('narrow');
    expect(result.error).toContain('catch-all');
  });

  it('routes any model through a customProvider that omits `models` (catch-all)', () => {
    const settings: ImageGenSettings = {
      customProviders: {
        amaster: {
          api: 'openai',
          baseUrl: 'https://credits.amaster.ai/',
          apiKey: 'sk-test',
        },
      },
    };
    const result = resolveModel('any-future-model-id', settings);
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('amaster');
    expect(result.remoteId).toBe('any-future-model-id');
  });

  it('routes a built-in model id through a catch-all when its built-in provider has no api key', () => {
    delete process.env.DASHSCOPE_API_KEY;
    const settings: ImageGenSettings = {
      customProviders: {
        amaster: {
          api: 'openai',
          baseUrl: 'https://credits.amaster.ai/',
          apiKey: 'sk-test',
        },
      },
    };
    const result = resolveModel('qwen-image-2.0', settings);
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('amaster');
    expect(result.remoteId).toBe('qwen-image-2.0');
  });

  it('explicit `models` list still wins over catch-all', () => {
    const settings: ImageGenSettings = {
      customProviders: {
        narrow: {
          api: 'openai',
          baseUrl: 'https://narrow.example/',
          apiKey: 'k1',
          models: [{ id: 'sd-3', alias: 'sd' }],
        },
        wide: {
          api: 'openai',
          baseUrl: 'https://wide.example/',
          apiKey: 'k2',
        },
      },
    };
    const a = resolveModel('sd', settings);
    if ('error' in a) throw new Error(a.error);
    expect(a.provider.id).toBe('narrow');

    const b = resolveModel('something-else', settings);
    if ('error' in b) throw new Error(b.error);
    expect(b.provider.id).toBe('wide');
  });
});

describe('resolveModel — capability attachment', () => {
  it('attaches the registry contract for built-in models', () => {
    process.env.OPENAI_API_KEY = 'oa-test';
    const result = resolveModel('gpt-image-2', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.capabilities?.sizeRange?.allowAuto).toBe(true);
    expect(result.capabilities?.nMax).toBe(10);
  });

  it('a custom model whose id names a built-in inherits the registry contract', () => {
    const settings: ImageGenSettings = {
      customProviders: {
        gateway: {
          api: 'dashscope',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'k',
          models: ['qwen-image-3.0'],
        },
      },
    };
    const result = resolveModel('qwen-image-3.0', settings);
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('gateway');
    expect(result.capabilities?.sizeRange?.separator).toBe('*');
    expect(result.capabilities?.maxReferenceImages).toBe(3);
  });

  it('a catch-all custom provider inherits the registry contract for a built-in model', () => {
    delete process.env.ARK_API_KEY;
    const result = resolveModel('doubao-seedream-5-0-lite-260128', {
      customProviders: {
        amaster: {
          api: 'openai',
          baseUrl: 'https://credits.amaster.ai/',
          apiKey: 'sk-test',
        },
      },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('amaster');
    expect(result.capabilities?.sizeRange?.tiers).toEqual(['2K', '3K', '4K']);
    expect(result.capabilities?.sizeRange?.minArea).toBe(3_686_400);
  });

  it('explicit per-field declarations win over the inherited contract', () => {
    const settings: ImageGenSettings = {
      customProviders: {
        gateway: {
          api: 'dashscope',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'k',
          models: [{ id: 'qwen-image-3.0', capabilities: { nMax: 2 } }],
        },
      },
    };
    const result = resolveModel('qwen-image-3.0', settings);
    if ('error' in result) throw new Error(result.error);
    expect(result.capabilities?.nMax).toBe(2);
    // Untouched fields still come from the registry entry.
    expect(result.capabilities?.sizeRange?.separator).toBe('*');
    expect(result.capabilities?.maxReferenceImages).toBe(3);
  });

  it('explicit capabilities for an unknown custom model merge over the generic contract', () => {
    const settings: ImageGenSettings = {
      customProviders: {
        gateway: {
          api: 'openai',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'k',
          models: [{ id: 'my-finetune', capabilities: { nMax: 4 } }],
        },
      },
    };
    const result = resolveModel('my-finetune', settings);
    if ('error' in result) throw new Error(result.error);
    expect(result.capabilities?.nMax).toBe(4);
    expect(result.capabilities?.maxReferenceImages).toBe(8);
    expect(result.capabilities?.inputMaxBytes).toBe(20 * 1024 * 1024);
  });

  it('drops malformed capability fields instead of letting them reach the schema', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const settings: ImageGenSettings = {
        customProviders: {
          gateway: {
            api: 'openai',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'k',
            models: [
              {
                id: 'my-finetune',
                capabilities: { nMax: 'six', maxReferenceImages: 2 } as never,
              },
            ],
          },
        },
      };
      const result = resolveModel('my-finetune', settings);
      if ('error' in result) throw new Error(result.error);
      // The valid field wins; the malformed one falls back to the generic contract.
      expect(result.capabilities?.maxReferenceImages).toBe(2);
      expect(result.capabilities?.nMax).toBe(8);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('[pi-image-gen]');
      expect(logged).toContain('capabilities.nMax');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('leaves capabilities undefined for unknown custom models and slash routes', () => {
    const custom = resolveModel('sd-3-large', {
      customProviders: {
        'my-sd': {
          api: 'openai',
          baseUrl: 'https://api.my-sd.test/v1',
          apiKey: 'sd-key',
          models: ['sd-3-large'],
        },
      },
    });
    if ('error' in custom) throw new Error(custom.error);
    expect(custom.capabilities).toBeUndefined();

    process.env.OPENROUTER_API_KEY = 'or-test';
    const slash = resolveModel('openrouter/google/gemini-2.5-flash-image', {});
    if ('error' in slash) throw new Error(slash.error);
    expect(slash.capabilities).toBeUndefined();
  });
});
