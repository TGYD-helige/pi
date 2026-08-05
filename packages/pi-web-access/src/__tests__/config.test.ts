import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadWebToolSettings,
  resolveFetchProvider,
  resolveProvider,
  resolveSearchProvider,
} from '../config.js';
import type { WebToolSettings } from '../types.js';

describe('resolveProvider', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves tavily with env var', () => {
    process.env.TAVILY_API_KEY = 'test-tavily-key';
    const result = resolveProvider('tavily', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('tavily');
      expect(result.baseUrl).toBe('https://api.tavily.com');
      expect(result.apiKey).toBe('test-tavily-key');
    }
  });

  it('resolves firecrawl with env var', () => {
    process.env.FIRECRAWL_API_KEY = 'test-fc-key';
    const result = resolveProvider('firecrawl', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('firecrawl');
      expect(result.baseUrl).toBe('https://api.firecrawl.dev');
      expect(result.apiKey).toBe('test-fc-key');
    }
  });

  it('resolves kimi with env var and default model', () => {
    process.env.MOONSHOT_API_KEY = 'test-kimi-key';
    const result = resolveProvider('kimi', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('kimi');
      expect(result.baseUrl).toBe('https://api.moonshot.cn/v1');
      expect(result.apiKey).toBe('test-kimi-key');
      expect(result.model).toBe('kimi-k3');
    }
  });

  it('resolves mimo with env var and default model', () => {
    process.env.MIMO_API_KEY = 'test-mimo-key';
    const result = resolveProvider('mimo', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('mimo');
      expect(result.baseUrl).toBe('https://api.xiaomimimo.com/v1');
      expect(result.apiKey).toBe('test-mimo-key');
      expect(result.model).toBe('mimo-v2.5-pro');
    }
  });

  it('resolves zai with env var', () => {
    process.env.ZAI_API_KEY = 'test-zai-key';
    const result = resolveProvider('zai', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('zai');
      expect(result.baseUrl).toBe('https://api.z.ai');
      expect(result.apiKey).toBe('test-zai-key');
    }
  });

  it('resolves gemini with env var and default model', () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const result = resolveProvider('gemini', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('gemini');
      expect(result.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
      expect(result.apiKey).toBe('test-gemini-key');
      expect(result.model).toBe('gemini-2.5-flash');
    }
  });

  it('resolves perplexity with env var and default model', () => {
    process.env.PERPLEXITY_API_KEY = 'test-pplx-key';
    const result = resolveProvider('perplexity', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('perplexity');
      expect(result.baseUrl).toBe('https://api.perplexity.ai');
      expect(result.apiKey).toBe('test-pplx-key');
      expect(result.model).toBe('openai/gpt-5.5');
    }
  });

  it('resolves deepseek with env var and default model', () => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    const result = resolveProvider('deepseek', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('deepseek');
      expect(result.baseUrl).toBe('https://api.deepseek.com');
      expect(result.apiKey).toBe('test-deepseek-key');
      expect(result.model).toBe('deepseek-v4-flash');
    }
  });

  it('settings apiKey overrides env var', () => {
    process.env.TAVILY_API_KEY = 'env-key';
    const settings: WebToolSettings = {
      providers: { tavily: { apiKey: 'settings-key' } },
    };
    const result = resolveProvider('tavily', settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.apiKey).toBe('settings-key');
    }
  });

  it('settings baseUrl overrides default', () => {
    process.env.MOONSHOT_API_KEY = 'key';
    const settings: WebToolSettings = {
      providers: { kimi: { baseUrl: 'https://my-proxy.com/v1' } },
    };
    const result = resolveProvider('kimi', settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.baseUrl).toBe('https://my-proxy.com/v1');
    }
  });

  it('settings model overrides default', () => {
    process.env.MOONSHOT_API_KEY = 'key';
    const settings: WebToolSettings = {
      providers: { kimi: { model: 'moonshot-v1-128k' } },
    };
    const result = resolveProvider('kimi', settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.model).toBe('moonshot-v1-128k');
    }
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional env var syntax test
  it('does not interpolate ${ENV_VAR} in resolver input', () => {
    process.env.MY_TAVILY_KEY = 'resolved-key';
    const settings: WebToolSettings = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional
      providers: { tavily: { apiKey: '${MY_TAVILY_KEY}' } },
    };
    const result = resolveProvider('tavily', settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.apiKey).toBe(`$${'{MY_TAVILY_KEY}'}`);
    }
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional env var syntax test
  it('does not interpolate ${ENV_VAR} in resolver base URLs', () => {
    process.env.MY_BASE = 'https://custom.example.com';
    const settings: WebToolSettings = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional
      providers: { kimi: { baseUrl: '${MY_BASE}' } },
    };
    const result = resolveProvider('kimi', settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.baseUrl).toBe(`$${'{MY_BASE}'}`);
    }
  });

  it('falls back after empty provider overrides', () => {
    process.env.TAVILY_API_KEY = 'provider-key';
    const result = resolveProvider('tavily', {
      providers: {
        tavily: { apiKey: '', baseUrl: '' },
      },
    });
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.apiKey).toBe('provider-key');
      expect(result.baseUrl).toBe('https://api.tavily.com');
    }
  });

  it('returns error for unknown provider', () => {
    const result = resolveProvider('unknown', {});
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('Unknown provider');
    }
  });

  it('returns error for empty provider name', () => {
    const result = resolveProvider('', {});
    expect(result).toHaveProperty('error');
  });

  it('no apiKey when neither env nor settings configured', () => {
    delete process.env.TAVILY_API_KEY;
    const result = resolveProvider('tavily', {});
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.apiKey).toBeUndefined();
    }
  });

  it('merges headers from settings', () => {
    process.env.TAVILY_API_KEY = 'key';
    const settings: WebToolSettings = {
      providers: { tavily: { headers: { 'X-Custom': 'value' } } },
    };
    const result = resolveProvider('tavily', settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.headers).toEqual({ 'X-Custom': 'value' });
    }
  });
});

describe('resolveSearchProvider', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses search.provider when set', () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'key' } },
    };
    const result = resolveSearchProvider(settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('kimi');
    }
  });

  it('auto-selects first provider with key when search.provider not set', () => {
    const settings: WebToolSettings = {
      providers: { mimo: { apiKey: 'mimo-key' } },
    };
    const result = resolveSearchProvider(settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('mimo');
    }
  });

  it('returns error when no provider has key', () => {
    const result = resolveSearchProvider({});
    expect(result).toHaveProperty('error');
  });

  it('returns error when search.provider is set but has no key', () => {
    const settings: WebToolSettings = {
      search: { provider: 'tavily' },
    };
    const result = resolveSearchProvider(settings);
    // resolveProvider returns the provider without apiKey, resolveSearchProvider still returns it
    // (the search function will fail later when trying to call the API)
    expect(result).not.toHaveProperty('error');
  });

  it('skips providers without key during auto-selection', () => {
    const settings: WebToolSettings = {
      providers: {
        tavily: {},
        kimi: {},
        zai: { apiKey: 'zai-key' },
      },
    };
    const result = resolveSearchProvider(settings);
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.id).toBe('zai');
    }
  });
});

describe('resolveFetchProvider', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses fetch.provider when set and has key', () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'zai' },
      providers: { zai: { apiKey: 'key' } },
    };
    const result = resolveFetchProvider(settings);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('zai');
  });

  it('returns null when fetch.provider not set', () => {
    const settings: WebToolSettings = {
      providers: { zai: { apiKey: 'key' } },
    };
    const result = resolveFetchProvider(settings);
    expect(result).toBeNull();
  });

  it('returns null when fetch.provider has no key', () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'zai' },
      providers: { zai: {} },
    };
    const result = resolveFetchProvider(settings);
    expect(result).toBeNull();
  });

  it('returns null for empty settings', () => {
    const result = resolveFetchProvider({});
    expect(result).toBeNull();
  });

  it('supports perplexity as fetch provider', () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'perplexity' },
      providers: { perplexity: { apiKey: 'pplx-key' } },
    };
    const result = resolveFetchProvider(settings);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('perplexity');
  });

  it('supports tavily as fetch provider', () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'tvly-key' } },
    };
    const result = resolveFetchProvider(settings);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('tavily');
  });

  it('supports firecrawl as fetch provider', () => {
    const settings: WebToolSettings = {
      fetch: { provider: 'firecrawl' },
      providers: { firecrawl: { apiKey: 'fc-key' } },
    };
    const result = resolveFetchProvider(settings);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('firecrawl');
  });
});

describe('loadWebToolSettings', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let root: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'pi-web-access-config-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('locks local_only mode after trusted project settings are merged', () => {
    const configDir = join(root, 'agent');
    const cwd = join(root, 'project');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        'pi-web-access': {
          fetch: {
            mode: 'local_only',
            observation: { runId: 'run-1', retention: 'source_summary_only_v1' },
          },
        },
      }),
    );
    writeFileSync(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({
        'pi-web-access': {
          fetch: { mode: 'provider_jina_or_local', provider: 'zai' },
          providers: { zai: { apiKey: 'project-key' } },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = configDir;
    process.env.PI_WEB_ACCESS_RUNTIME_FETCH_MODE = 'local_only';
    process.env.PI_WEB_ACCESS_RUNTIME_OBSERVATION = 'required';

    expect(loadWebToolSettings(cwd, true).fetch).toMatchObject({
      mode: 'local_only',
      observation: { runId: 'run-1', retention: 'source_summary_only_v1' },
    });
    expect(loadWebToolSettings(cwd, true).fetch?.provider).toBeUndefined();
  });
});
