import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockedHome: string | undefined;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockedHome ?? actual.homedir(),
  };
});

// Helper to build env-var placeholder strings without triggering biome's noTemplateCurlyInString
function envRef(expr: string): string {
  // biome-ignore lint/style/useTemplate: intentional concatenation to avoid noTemplateCurlyInString
  return '$' + `{${expr}}`;
}

describe('isProjectTrusted', () => {
  it('grants project access only for an explicit true result', async () => {
    const { isProjectTrusted } = await import('../../src/settings.js');

    expect(isProjectTrusted({ isProjectTrusted: () => true })).toBe(true);
    expect(isProjectTrusted({ isProjectTrusted: () => false })).toBe(false);
    expect(isProjectTrusted({})).toBe(false);
    expect(isProjectTrusted(undefined)).toBe(false);
  });
});

describe('loadPiSettings env var resolution', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-settings-test-${Date.now()}`);
    mkdirSync(join(tempDir, '.pi', 'agent'), { recursive: true });
    settingsPath = join(tempDir, '.pi', 'agent', 'settings.json');
    mockedHome = tempDir;
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    mockedHome = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadSettings<T>(key: string): Promise<T> {
    const mod = await import('../../src/settings.js');
    return mod.loadPiSettings<T>(key);
  }

  it('resolves env ref to env value', async () => {
    process.env.TEST_MODEL = 'claude-opus';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: envRef('TEST_MODEL') },
      }),
    );
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('claude-opus');
  });

  it('resolves bare env refs by default', async () => {
    process.env.TEST_MODEL = 'claude-opus';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: '$TEST_MODEL' },
      }),
    );
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('claude-opus');
  });

  it('keeps bare env refs literal when explicitly disabled', async () => {
    process.env.TEST_MODEL = 'claude-opus';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: '$TEST_MODEL' },
      }),
    );
    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ name: string }>('myExt', {
      expandBareEnvVars: false,
    });
    expect(result.name).toBe('$TEST_MODEL');
  });

  it('resolves env ref with default to default when env is unset', async () => {
    delete process.env.UNSET_VAR;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: envRef('UNSET_VAR:-fallback-model') },
      }),
    );
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('fallback-model');
  });

  it('resolves env ref with default to env value when set', async () => {
    process.env.SET_VAR = 'actual-value';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: envRef('SET_VAR:-fallback') },
      }),
    );
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('actual-value');
  });

  it('resolves env ref with empty default when env is unset', async () => {
    delete process.env.EMPTY_VAR;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: envRef('EMPTY_VAR:-') },
      }),
    );
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('');
  });

  it('resolves env ref with empty default when env is empty', async () => {
    process.env.EMPTY_VAR = '';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { name: envRef('EMPTY_VAR:-') },
      }),
    );
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('');
  });

  it('resolves env vars in nested objects', async () => {
    process.env.NESTED_VAL = 'deep';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { outer: { inner: envRef('NESTED_VAL') } },
      }),
    );
    const result = await loadSettings<{ outer: { inner: string } }>('myExt');
    expect(result.outer.inner).toBe('deep');
  });

  it('resolves env vars in arrays', async () => {
    process.env.ARR_VAL = 'item1';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { items: [envRef('ARR_VAL'), 'literal'] },
      }),
    );
    const result = await loadSettings<{ items: string[] }>('myExt');
    expect(result.items).toEqual(['item1', 'literal']);
  });

  it('resolves multiple env vars in one string', async () => {
    process.env.HOST = 'localhost';
    process.env.PORT = '8080';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { url: `http://${envRef('HOST')}:${envRef('PORT')}/api` },
      }),
    );
    const result = await loadSettings<{ url: string }>('myExt');
    expect(result.url).toBe('http://localhost:8080/api');
  });

  it('leaves non-string values untouched', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { count: 42, enabled: true, empty: null },
      }),
    );
    const result = await loadSettings<{ count: number; enabled: boolean; empty: null }>('myExt');
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
    expect(result.empty).toBeNull();
  });

  it('handles default value containing :-', async () => {
    delete process.env.TRICKY_VAR;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        myExt: { val: envRef('TRICKY_VAR:-a:-b') },
      }),
    );
    const result = await loadSettings<{ val: string }>('myExt');
    expect(result.val).toBe('a:-b');
  });
});

describe('3-layer settings resolution', () => {
  let base: string;
  let globalDir: string;
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    base = join(tmpdir(), `pi-3layer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    globalDir = join(base, 'home', '.pi', 'agent');
    configDir = join(base, 'agent-config');
    projectDir = join(base, 'project');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(projectDir, '.pi'), { recursive: true });
    mockedHome = join(base, 'home');
  });

  afterEach(() => {
    mockedHome = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    'global',
    'agent',
    'project',
  ])('reports malformed %s settings instead of using defaults', async (layer) => {
    const dir =
      layer === 'global' ? globalDir : layer === 'agent' ? configDir : join(projectDir, '.pi');
    writeFileSync(join(dir, 'settings.json'), '{secret-provider-body');
    const { loadPiSettings } = await import('../../src/settings.js');
    expect(() =>
      loadPiSettings('ext', { configDir, cwd: projectDir, projectTrusted: true }),
    ).toThrow(/settings/i);
  });

  it('rejects an explicit null section instead of using defaults', async () => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ ext: null }));
    const { loadPiSettings } = await import('../../src/settings.js');
    expect(() => loadPiSettings('ext', { configDir })).toThrow(/settings/i);
  });

  it('configDir settings override global settings', async () => {
    writeFileSync(
      join(globalDir, 'settings.json'),
      JSON.stringify({ ext: { a: 'global', b: 'global' } }),
    );
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ ext: { a: 'agent' } }));

    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ a: string; b: string }>('ext', {
      configDir,
      cwd: projectDir,
    });
    expect(result.a).toBe('agent');
    expect(result.b).toBe('global');
  });

  it('ignores project settings when trust is not explicitly granted', async () => {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ ext: { a: 'agent', b: 'agent' } }),
    );
    writeFileSync(
      join(projectDir, '.pi', 'settings.json'),
      JSON.stringify({ ext: { a: 'project' } }),
    );

    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ a: string; b: string }>('ext', {
      configDir,
      cwd: projectDir,
    });
    expect(result.a).toBe('agent');
    expect(result.b).toBe('agent');
  });

  it('project settings override configDir settings when project is trusted', async () => {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ ext: { a: 'agent', b: 'agent' } }),
    );
    writeFileSync(
      join(projectDir, '.pi', 'settings.json'),
      JSON.stringify({ ext: { a: 'project' } }),
    );

    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ a: string; b: string }>('ext', {
      configDir,
      cwd: projectDir,
      projectTrusted: true,
    });
    expect(result.a).toBe('project');
    expect(result.b).toBe('agent');
  });

  it('can fail closed on malformed trusted project settings', async () => {
    writeFileSync(join(projectDir, '.pi', 'settings.json'), '{broken');

    const { loadPiSettings } = await import('../../src/settings.js');
    expect(() =>
      loadPiSettings('ext', {
        configDir,
        cwd: projectDir,
        projectTrusted: true,
        strictProjectSettings: true,
      }),
    ).toThrow(/project settings/i);
  });

  it('does not interpolate env vars from trusted project settings', async () => {
    const originalSecret = process.env.PROJECT_SECRET;
    process.env.PROJECT_SECRET = 'must-not-expand';
    writeFileSync(
      join(projectDir, '.pi', 'settings.json'),
      JSON.stringify({
        ext: {
          value: envRef('PROJECT_SECRET'),
          bare: '$PROJECT_SECRET',
        },
      }),
    );

    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ value: string; bare: string }>('ext', {
      configDir,
      cwd: projectDir,
      projectTrusted: true,
      expandBareEnvVars: true,
    });
    expect(result.value).toBe(envRef('PROJECT_SECRET'));
    expect(result.bare).toBe('$PROJECT_SECRET');

    if (originalSecret === undefined) delete process.env.PROJECT_SECRET;
    else process.env.PROJECT_SECRET = originalSecret;
  });

  it('env var interpolation works in configDir layer', async () => {
    const origEndpoint = process.env.MY_ENDPOINT;
    process.env.MY_ENDPOINT = 'https://api.example.com';
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ ext: { url: envRef('MY_ENDPOINT') } }),
    );

    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ url: string }>('ext', { configDir, cwd: projectDir });
    expect(result.url).toBe('https://api.example.com');
    if (origEndpoint === undefined) delete process.env.MY_ENDPOINT;
    else process.env.MY_ENDPOINT = origEndpoint;
  });

  it('skips configDir layer when it equals global dir', async () => {
    writeFileSync(join(globalDir, 'settings.json'), JSON.stringify({ ext: { a: 'global' } }));
    writeFileSync(
      join(projectDir, '.pi', 'settings.json'),
      JSON.stringify({ ext: { b: 'project' } }),
    );

    const { loadPiSettings } = await import('../../src/settings.js');
    const result = loadPiSettings<{ a: string; b: string }>('ext', {
      cwd: projectDir,
      projectTrusted: true,
    });
    expect(result.a).toBe('global');
    expect(result.b).toBe('project');
  });
});

describe('loadPiPolicyProfiles', () => {
  let base: string;
  let globalPolicyDir: string;
  let configDir: string;
  let configPolicyDir: string;
  let projectDir: string;
  let projectPolicyDir: string;

  beforeEach(() => {
    base = join(tmpdir(), `pi-policy-3layer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    globalPolicyDir = join(base, 'home', '.pi', 'agent', 'policy');
    configDir = join(base, 'agent-config');
    configPolicyDir = join(configDir, 'policy');
    projectDir = join(base, 'project');
    projectPolicyDir = join(projectDir, '.pi', 'policy');
    mkdirSync(globalPolicyDir, { recursive: true });
    mkdirSync(configPolicyDir, { recursive: true });
    mkdirSync(projectPolicyDir, { recursive: true });
    mockedHome = join(base, 'home');
  });

  afterEach(() => {
    mockedHome = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  it('configDir policy is readable', async () => {
    writeFileSync(
      join(configPolicyDir, 'sandbox-exec.json'),
      JSON.stringify({ extends: 'sandbox-exec', capabilities: { allow: ['browser_*'] } }),
    );

    const { loadPiPolicyProfiles } = await import('../../src/settings.js');
    const result = loadPiPolicyProfiles<{ extends?: string; capabilities?: { allow?: string[] } }>({
      configDir,
      cwd: projectDir,
    });
    expect(result['sandbox-exec']).toEqual({
      extends: 'sandbox-exec',
      capabilities: { allow: ['browser_*'] },
    });
  });

  it('project policy overrides configDir policy with same name', async () => {
    writeFileSync(
      join(configPolicyDir, 'custom.json'),
      JSON.stringify({ extends: 'chat', capabilities: { allow: ['read_file'] } }),
    );
    writeFileSync(
      join(projectPolicyDir, 'custom.json'),
      JSON.stringify({ extends: 'copilot', capabilities: { allow: ['*'] } }),
    );

    const { loadPiPolicyProfiles } = await import('../../src/settings.js');
    const result = loadPiPolicyProfiles<{ extends?: string; capabilities?: { allow?: string[] } }>({
      configDir,
      cwd: projectDir,
      projectTrusted: true,
    });
    expect(result.custom).toEqual({ extends: 'copilot', capabilities: { allow: ['*'] } });
  });

  it('ignores project policies when trust is not explicitly granted', async () => {
    writeFileSync(
      join(configPolicyDir, 'custom.json'),
      JSON.stringify({ extends: 'chat', capabilities: { allow: ['read_file'] } }),
    );
    writeFileSync(
      join(projectPolicyDir, 'custom.json'),
      JSON.stringify({ extends: 'copilot', capabilities: { allow: ['*'] } }),
    );

    const { loadPiPolicyProfiles } = await import('../../src/settings.js');
    const result = loadPiPolicyProfiles<{ extends?: string; capabilities?: { allow?: string[] } }>({
      configDir,
      cwd: projectDir,
    });
    expect(result.custom).toEqual({ extends: 'chat', capabilities: { allow: ['read_file'] } });
  });

  it('merges profiles from all three directories', async () => {
    writeFileSync(join(globalPolicyDir, 'global-only.json'), JSON.stringify({ extends: 'chat' }));
    writeFileSync(join(configPolicyDir, 'agent-only.json'), JSON.stringify({ extends: 'admin' }));
    writeFileSync(
      join(projectPolicyDir, 'project-only.json'),
      JSON.stringify({ extends: 'copilot' }),
    );

    const { loadPiPolicyProfiles } = await import('../../src/settings.js');
    const result = loadPiPolicyProfiles<{ extends?: string }>({
      configDir,
      cwd: projectDir,
      projectTrusted: true,
    });
    expect(result['global-only']).toEqual({ extends: 'chat' });
    expect(result['agent-only']).toEqual({ extends: 'admin' });
    expect(result['project-only']).toEqual({ extends: 'copilot' });
  });

  it('works when directories do not exist', async () => {
    rmSync(globalPolicyDir, { recursive: true });
    rmSync(configPolicyDir, { recursive: true });
    rmSync(projectPolicyDir, { recursive: true });

    const { loadPiPolicyProfiles } = await import('../../src/settings.js');
    const result = loadPiPolicyProfiles({ configDir, cwd: projectDir });
    expect(result).toEqual({});
  });
});

describe('loadJsonProfileDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `pi-profile-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads all .json files and returns Record keyed by filename', async () => {
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify({ value: 1 }));
    writeFileSync(join(dir, 'beta.json'), JSON.stringify({ value: 2 }));

    const { loadJsonProfileDir } = await import('../../src/settings.js');
    const result = loadJsonProfileDir<{ value: number }>(dir);
    expect(result).toEqual({ alpha: { value: 1 }, beta: { value: 2 } });
  });

  it('returns empty for non-existent directory', async () => {
    const { loadJsonProfileDir } = await import('../../src/settings.js');
    expect(loadJsonProfileDir('/non/existent/path')).toEqual({});
  });

  it('skips malformed JSON', async () => {
    writeFileSync(join(dir, 'bad.json'), '{ invalid !!!');
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ ok: true }));

    const { loadJsonProfileDir } = await import('../../src/settings.js');
    const result = loadJsonProfileDir<{ ok?: boolean }>(dir);
    expect(result).toEqual({ good: { ok: true } });
  });

  it('skips non-JSON files', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'not json');
    writeFileSync(join(dir, 'valid.json'), JSON.stringify({ x: 1 }));

    const { loadJsonProfileDir } = await import('../../src/settings.js');
    const result = loadJsonProfileDir<{ x: number }>(dir);
    expect(Object.keys(result)).toEqual(['valid']);
  });

  it('skips non-object JSON values', async () => {
    writeFileSync(join(dir, 'array.json'), JSON.stringify([1, 2]));
    writeFileSync(join(dir, 'str.json'), JSON.stringify('hello'));
    writeFileSync(join(dir, 'obj.json'), JSON.stringify({ ok: true }));

    const { loadJsonProfileDir } = await import('../../src/settings.js');
    const result = loadJsonProfileDir<{ ok?: boolean }>(dir);
    expect(Object.keys(result)).toEqual(['obj']);
  });
});

describe('resolveAgentDir', () => {
  it('uses explicit override when provided', async () => {
    const { resolveAgentDir } = await import('../../src/settings.js');
    const result = resolveAgentDir('/explicit/path');
    expect(result).toBe('/explicit/path');
  });

  it('defaults to ~/.pi/agent when no override', async () => {
    const { resolveAgentDir } = await import('../../src/settings.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const result = resolveAgentDir();
    expect(result).toBe(path.resolve(path.join(os.homedir(), '.pi', 'agent')));
  });
});
