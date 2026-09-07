import { describe, expect, it, vi } from 'vitest';
import { initMulticaProvider, MulticaAdapter } from '../adapters/multica.js';
import piTeamworkExtension from '../index.js';
import type { ExecFn } from '../types.js';

type RegisteredTool = {
  name: string;
  execute: (...args: never[]) => Promise<{ content: Array<{ text: string }> }>;
};

function successExec(stdout = ''): ExecFn {
  return async () => ({ stdout, stderr: '', code: 0 });
}

function failExec(stderr = 'error', code = 1): ExecFn {
  return async () => ({ stdout: '', stderr, code });
}

describe('piTeamworkExtension Multica provider', () => {
  async function createSettingsDir(config: Record<string, unknown>): Promise<string> {
    return import('node:fs/promises').then(async ({ mkdir, mkdtemp, writeFile }) => {
      const { tmpdir } = await import('node:os');
      const path = await import('node:path');
      const dir = await mkdtemp(path.join(tmpdir(), 'pi-teamwork-multica-'));
      await mkdir(path.join(dir, '.pi'), { recursive: true });
      await writeFile(path.join(dir, '.pi', 'settings.json'), JSON.stringify(config));
      return dir;
    });
  }

  it('registers teamwork tools for Multica sessions', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'multica',
        multica: { autoInstall: false },
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    const toolNames: string[] = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => toolNames.push(tool.name)),
      exec: vi.fn(async () => ({ stdout: '[]', stderr: '', code: 0 })),
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];
    const beforeAgentStartHandler = pi.on.mock.calls.find(
      (call) => call[0] === 'before_agent_start',
    )?.[1];

    await sessionStartHandler(
      {},
      {
        cwd: settingsDir,
        isProjectTrusted: () => true,
        ui: {
          setStatus: vi.fn(),
          notify: vi.fn(),
        },
      },
    );
    const guidance = await beforeAgentStartHandler({ systemPrompt: '' });
    expect(guidance.systemPrompt).toContain('A read-only review stays read-only');
    expect(guidance.systemPrompt).toContain('Tool availability alone does not authorize');

    expect(toolNames).toEqual([
      'workspace_list',
      'issue_list',
      'issue_get',
      'issue_create',
      'issue_update',
      'issue_comment',
      'project_list',
      'teamwork_status',
    ]);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('does not register duplicate tools when the same provider starts twice', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'multica',
        multica: { autoInstall: false },
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    const toolNames: string[] = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => toolNames.push(tool.name)),
      exec: vi.fn(async () => ({ stdout: '[]', stderr: '', code: 0 })),
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];
    const beforeAgentStartHandler = pi.on.mock.calls.find(
      (call) => call[0] === 'before_agent_start',
    )?.[1];
    const ctx = {
      cwd: settingsDir,
      isProjectTrusted: () => true,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    };

    await sessionStartHandler({}, ctx);
    await beforeAgentStartHandler({ systemPrompt: '' });
    await sessionStartHandler({}, ctx);
    await beforeAgentStartHandler({ systemPrompt: '' });

    expect(toolNames).toEqual([
      'workspace_list',
      'issue_list',
      'issue_get',
      'issue_create',
      'issue_update',
      'issue_comment',
      'project_list',
      'teamwork_status',
    ]);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('ignores stale Multica initialization after teamwork is disabled', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'multica',
        multica: { autoInstall: true },
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    let releaseMultica!: () => void;
    let markMulticaStarted!: () => void;
    const multicaStarted = new Promise<void>((resolve) => {
      markMulticaStarted = resolve;
    });
    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      getActiveTools: vi.fn(() => ['issue_list']),
      setActiveTools: vi.fn(),
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('--version')) {
          markMulticaStarted();
          await new Promise<void>((resolve) => {
            releaseMultica = resolve;
          });
        }
        return { stdout: '[]', stderr: '', code: 0 };
      }),
    };
    const statusUpdates: string[] = [];
    const ctx = {
      cwd: settingsDir,
      isProjectTrusted: () => true,
      ui: {
        setStatus: (_key: string, value: string) => statusUpdates.push(value),
        notify: vi.fn(),
      },
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];

    const multicaStart = sessionStartHandler({}, ctx);
    await multicaStarted;
    await import('node:fs/promises').then(async ({ writeFile }) => {
      const path = await import('node:path');
      await writeFile(
        path.join(settingsDir, '.pi', 'settings.json'),
        JSON.stringify({
          'pi-teamwork': {
            enabled: false,
          },
        }),
      );
    });
    await sessionStartHandler({}, ctx);
    releaseMultica();
    await multicaStart;

    expect(statusUpdates.at(-1)).toBe('teamwork: disabled');
    expect(tools.size).toBe(0);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('removes teamwork tools from the active set when teamwork is disabled', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        enabled: false,
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    let activeTools = ['read', 'issue_list', 'teamwork_status'];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((next: string[]) => {
        activeTools = next;
      }),
      exec: vi.fn(async () => ({ stdout: '[]', stderr: '', code: 0 })),
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];

    await sessionStartHandler(
      {},
      {
        cwd: settingsDir,
        isProjectTrusted: () => true,
        ui: {
          setStatus: vi.fn(),
          notify: vi.fn(),
        },
      },
    );

    expect(activeTools).toEqual(['read']);
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(['read']);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('removes teamwork tools from the active set for unknown providers', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'amastre',
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    let activeTools = ['read', 'issue_list', 'teamwork_status'];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((next: string[]) => {
        activeTools = next;
      }),
      exec: vi.fn(async () => ({ stdout: '[]', stderr: '', code: 0 })),
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];

    await sessionStartHandler(
      {},
      {
        cwd: settingsDir,
        isProjectTrusted: () => true,
        ui: {
          setStatus: vi.fn(),
          notify: vi.fn(),
        },
      },
    );

    expect(activeTools).toEqual(['read']);
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(['read']);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });
});

describe('MulticaAdapter', () => {
  describe('listIssues', () => {
    it('returns parsed issues from JSON output', async () => {
      const issues = [
        { id: 'ISS-1', title: 'Bug fix', status: 'todo', priority: 'high' },
        { id: 'ISS-2', title: 'Feature', status: 'in_progress' },
      ];
      const adapter = new MulticaAdapter({}, successExec(JSON.stringify(issues)));
      const result = await adapter.listIssues();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'ISS-1',
        title: 'Bug fix',
        status: 'todo',
        priority: 'high',
      });
      expect(result[1]).toMatchObject({ id: 'ISS-2', title: 'Feature', status: 'in_progress' });
    });

    it('passes filter flags to CLI', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return { stdout: '[]', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({}, exec);
      await adapter.listIssues({
        workspaceId: 'ws-1',
        status: 'todo',
        assignee: 'alice',
        project: 'P1',
        limit: 5,
      });
      expect(calls[0]).toContain('--status');
      expect(calls[0]).toContain('todo');
      expect(calls[0]).toContain('--assignee');
      expect(calls[0]).toContain('alice');
      expect(calls[0]).toContain('--project');
      expect(calls[0]).toContain('P1');
      expect(calls[0]).toContain('--limit');
      expect(calls[0]).toContain('5');
    });

    it('returns empty array on non-array JSON', async () => {
      const adapter = new MulticaAdapter({}, successExec('{"not": "array"}'));
      expect(await adapter.listIssues()).toEqual([]);
    });

    it('returns empty array on invalid JSON', async () => {
      const adapter = new MulticaAdapter({}, successExec('not json'));
      expect(await adapter.listIssues()).toEqual([]);
    });

    it('throws on non-zero exit code', async () => {
      const adapter = new MulticaAdapter({}, failExec('command failed'));
      await expect(adapter.listIssues()).rejects.toThrow('multica issue failed: command failed');
    });
  });

  describe('getIssue', () => {
    it('returns a single issue', async () => {
      const issue = { id: 'ISS-1', title: 'Test', status: 'done', created_at: '2025-01-01' };
      const adapter = new MulticaAdapter({}, successExec(JSON.stringify(issue)));
      const result = await adapter.getIssue('ISS-1');
      expect(result).toMatchObject({
        id: 'ISS-1',
        title: 'Test',
        status: 'done',
        createdAt: '2025-01-01',
      });
    });

    it('returns undefined on null response', async () => {
      const adapter = new MulticaAdapter({}, successExec('null'));
      expect(await adapter.getIssue('ISS-X')).toBeUndefined();
    });
  });

  describe('createIssue', () => {
    it('passes title and optional fields', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ id: 'ISS-NEW', title: 'New', status: 'todo' }),
          stderr: '',
          code: 0,
        };
      };
      const adapter = new MulticaAdapter({}, exec);
      const result = await adapter.createIssue({
        workspaceId: 'ws-1',
        title: 'New',
        priority: 'high',
        assignee: 'bob',
      });
      expect(result).toMatchObject({ id: 'ISS-NEW', title: 'New' });
      expect(calls[0]).toContain('--title');
      expect(calls[0]).toContain('New');
      expect(calls[0]).toContain('--priority');
      expect(calls[0]).toContain('high');
      expect(calls[0]).toContain('--assignee');
      expect(calls[0]).toContain('bob');
    });

    it('returns fallback issue on invalid JSON response', async () => {
      const adapter = new MulticaAdapter({}, successExec('ok'));
      const result = await adapter.createIssue({ workspaceId: 'ws-1', title: 'Fallback' });
      expect(result).toMatchObject({ id: 'unknown', title: 'Fallback', status: 'todo' });
    });
  });

  describe('updateIssue', () => {
    it('calls status command separately from update', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        if (args.includes('get')) {
          return {
            stdout: JSON.stringify({ id: 'ISS-1', title: 'Updated', status: 'done' }),
            stderr: '',
            code: 0,
          };
        }
        return { stdout: '', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({}, exec);
      await adapter.updateIssue('ISS-1', { status: 'done', title: 'Updated' });
      expect(calls[0]).toContain('status');
      expect(calls[0]).toContain('done');
      expect(calls[1]).toContain('update');
      expect(calls[1]).toContain('--title');
      expect(calls[1]).toContain('Updated');
    });
  });

  describe('addComment', () => {
    it('sends comment content and returns parsed result', async () => {
      const exec: ExecFn = async () => ({
        stdout: JSON.stringify({ id: 'C-1', author: 'alice', created_at: '2025-01-01' }),
        stderr: '',
        code: 0,
      });
      const adapter = new MulticaAdapter({}, exec);
      const result = await adapter.addComment('ISS-1', 'hello');
      expect(result).toMatchObject({
        id: 'C-1',
        issueId: 'ISS-1',
        content: 'hello',
        author: 'alice',
      });
    });

    it('includes parentId when provided', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return { stdout: '{}', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({}, exec);
      await adapter.addComment('ISS-1', 'reply', 'C-0');
      expect(calls[0]).toContain('--parent');
      expect(calls[0]).toContain('C-0');
    });
  });

  describe('listProjects', () => {
    it('maps project fields correctly', async () => {
      const projects = [{ id: 'P1', name: 'Alpha', description: 'desc', lead: 'bob' }];
      const adapter = new MulticaAdapter({}, successExec(JSON.stringify(projects)));
      const result = await adapter.listProjects();
      expect(result[0]).toMatchObject({
        id: 'P1',
        title: 'Alpha',
        description: 'desc',
        lead: 'bob',
      });
    });
  });

  describe('status', () => {
    it('returns parsed daemon status', async () => {
      const adapter = new MulticaAdapter(
        {},
        successExec(JSON.stringify({ running: true, agents: 3 })),
      );
      const result = await adapter.status();
      expect(result).toEqual({ running: true, agents: 3 });
    });

    it('wraps non-object output in raw field', async () => {
      const adapter = new MulticaAdapter({}, successExec('just text'));
      const result = await adapter.status();
      expect(result).toEqual({ raw: 'just text' });
    });
  });

  describe('workspace args', () => {
    it('adds --workspace-id when configured', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return { stdout: '[]', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({ workspace: 'ws-123' }, exec);
      await adapter.listIssues();
      expect(calls[0]).toContain('--workspace-id');
      expect(calls[0]).toContain('ws-123');
    });
  });

  describe('custom binary', () => {
    it('uses configured binary name', async () => {
      const cmds: string[] = [];
      const exec: ExecFn = async (cmd) => {
        cmds.push(cmd);
        return { stdout: '[]', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({ binary: '/usr/local/bin/multica-dev' }, exec);
      await adapter.listIssues();
      expect(cmds[0]).toBe('/usr/local/bin/multica-dev');
    });
  });
});

describe('initMulticaProvider', () => {
  it('reports a missing CLI without requiring the deprecated autoInstall flag', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: args[0] === '--version' ? 127 : 0 };
    };

    const { installResult } = await initMulticaProvider({}, exec);

    expect(installResult).toMatchObject({ installed: false, alreadyPresent: false });
    expect(calls).toEqual([['--version']]);
  });

  it('calls login when token is provided', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ token: 'my-token' }, exec);
    expect(calls[0]).toEqual(['--version']);
    expect(calls[1]).toEqual(['daemon', 'start']);
    expect(calls[2]).toEqual(['login', '--token', 'my-token']);
  });

  it('skips login when no token', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({}, exec);
    expect(calls).toEqual([['--version'], ['daemon', 'start']]);
  });

  it('continues even if login fails', async () => {
    let daemonStarted = false;
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('login')) throw new Error('login failed');
      if (args.includes('start')) daemonStarted = true;
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter } = await initMulticaProvider({ token: 'bad-token' }, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(daemonStarted).toBe(true);
  });

  it('continues even if daemon start fails', async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('start')) throw new Error('already running');
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter } = await initMulticaProvider({}, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
  });

  it('returns a MulticaAdapter instance', async () => {
    const { adapter } = await initMulticaProvider({}, successExec());
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(adapter.name).toBe('multica');
  });

  it('probes without installing when autoInstall is false', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ autoInstall: false }, exec);
    expect(calls).toEqual([['--version'], ['daemon', 'start']]);
  });

  it('never installs Multica during provider initialization', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '', code: 0 };
    };

    await initMulticaProvider({}, exec);

    expect(calls).toEqual([
      { cmd: 'multica', args: ['--version'] },
      { cmd: 'multica', args: ['daemon', 'start'] },
    ]);
  });

  it('sets server_url and app_url via config when serverUrl and appUrl are configured', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider(
      { serverUrl: 'https://api.example.com', appUrl: 'https://example.com' },
      exec,
    );
    expect(calls).toContainEqual(['config', 'set', 'server_url', 'https://api.example.com']);
    expect(calls).toContainEqual(['config', 'set', 'app_url', 'https://example.com']);
  });

  it('sets only server_url when appUrl is not configured', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ serverUrl: 'https://api.example.com' }, exec);
    expect(calls).toContainEqual(['config', 'set', 'server_url', 'https://api.example.com']);
    expect(calls.some((a) => a.includes('app_url'))).toBe(false);
  });

  it('sets config before login when both serverUrl and token are configured', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ serverUrl: 'https://api.example.com', token: 'my-token' }, exec);
    const configIdx = calls.findIndex((a) => a[0] === 'config');
    const daemonIdx = calls.findIndex((a) => a.includes('start'));
    const loginIdx = calls.findIndex((a) => a[0] === 'login');
    expect(configIdx).toBeGreaterThan(-1);
    expect(daemonIdx).toBeGreaterThan(configIdx);
    expect(loginIdx).toBeGreaterThan(daemonIdx);
  });

  it('continues even if setup self-host fails', async () => {
    let daemonStarted = false;
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === 'setup') throw new Error('setup failed');
      if (args.includes('start')) daemonStarted = true;
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter } = await initMulticaProvider(
      { serverUrl: 'https://api.example.com', token: 'tk' },
      exec,
    );
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(daemonStarted).toBe(true);
  });

  it('returns adapter even when install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: 'fail', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter, installResult } = await initMulticaProvider({ autoInstall: true }, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(installResult.installed).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('reports the CLI as unavailable when the version check throws', async () => {
    const exec: ExecFn = async () => {
      throw new Error('command not found');
    };

    const { installResult } = await initMulticaProvider({ autoInstall: true }, exec);

    expect(installResult).toMatchObject({ installed: false, alreadyPresent: false });
  });

  it('does not run setup or login when install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: 'fail', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider(
      { serverUrl: 'https://api.example.com', token: 'tk', autoInstall: true },
      exec,
    );
    expect(calls.some((c) => c.args[0] === 'setup')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'login')).toBe(false);
    expect(calls.some((c) => c.args.includes('start'))).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('uses custom binary path for version check and all commands', async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (cmd, _args) => {
      cmds.push(cmd);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ binary: '/opt/multica', token: 'tk', autoInstall: false }, exec);
    expect(cmds.every((c) => c === '/opt/multica')).toBe(true);
  });
});
