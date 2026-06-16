import { describe, expect, it, vi } from 'vitest';
import { AmasterAdapter, initAmasterProvider } from './adapters/amaster.js';
import { initMulticaProvider, MulticaAdapter } from './adapters/multica.js';
import { ensureMulticaBinary } from './adapters/multica-installer.js';
import piTeamworkExtension from './index.js';
import type { ExecFn } from './types.js';

type RegisteredTool = {
  name: string;
  execute: (...args: never[]) => Promise<{ content: Array<{ text: string }> }>;
};

function _mockExec(
  responses: Record<string, { stdout: string; stderr: string; code: number }>,
): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(' ');
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

function successExec(stdout = ''): ExecFn {
  return async () => ({ stdout, stderr: '', code: 0 });
}

function failExec(stderr = 'error', code = 1): ExecFn {
  return async () => ({ stdout: '', stderr, code });
}

describe('AmasterAdapter', () => {
  it('uses managed AMaster CLI commands, per-call auth env, and unwraps issue envelopes', async () => {
    const previousApiKey = process.env.AMASTER_BOARD_API_KEY;
    const calls: Array<{
      cmd: string;
      args: string[];
      processEnvApiKey: string | undefined;
      childEnvApiKey: string | undefined;
    }> = [];
    const exec: ExecFn = async (cmd, args, options) => {
      calls.push({
        cmd,
        args,
        processEnvApiKey: process.env.AMASTER_BOARD_API_KEY,
        childEnvApiKey: options?.env?.AMASTER_BOARD_API_KEY,
      });
      if (args[0] === 'issue' && args[1] === 'get') {
        return {
          stdout: JSON.stringify({
            issue: {
              id: 'ISS-1',
              identifier: 'DFD-1',
              title: 'Listed AMaster task',
              status: 'todo',
            },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    };

    const adapter = new AmasterAdapter(
      {
        apiBase: 'http://amaster.test',
        apiKey: 'session-key',
        companyId: 'company-1',
      },
      exec,
    );
    const result = await adapter.getIssue('ISS-1');

    expect(result).toMatchObject({
      id: 'ISS-1',
      title: 'Listed AMaster task',
      status: 'todo',
      metadata: { identifier: 'DFD-1' },
    });
    expect(calls[0]).toMatchObject({
      cmd: 'amaster-employee',
      args: [
        'issue',
        'get',
        'ISS-1',
        '--api-base',
        'http://amaster.test',
        '-C',
        'company-1',
        '--json',
      ],
      processEnvApiKey: previousApiKey,
      childEnvApiKey: 'session-key',
    });
    expect(process.env.AMASTER_BOARD_API_KEY).toBe(previousApiKey);
  });

  it('does not mutate global api-key env while child CLI execution is pending', async () => {
    const previousApiKey = process.env.AMASTER_BOARD_API_KEY;
    let releaseExec!: () => void;
    let issuePromise!: Promise<unknown>;
    let capturedArgs: string[] = [];
    let capturedProcessEnvApiKey: string | undefined;
    let capturedChildEnvApiKey: string | undefined;
    const execStarted = new Promise<void>((resolve) => {
      const adapter = new AmasterAdapter(
        { apiKey: 'session-key', companyId: 'company-1' },
        async (_cmd, args, options) => {
          capturedArgs = args;
          capturedProcessEnvApiKey = process.env.AMASTER_BOARD_API_KEY;
          capturedChildEnvApiKey = options?.env?.AMASTER_BOARD_API_KEY;
          resolve();
          await new Promise<void>((release) => {
            releaseExec = release;
          });
          return {
            stdout: JSON.stringify({ issue: { id: 'ISS-1', title: 'Issue', status: 'todo' } }),
            stderr: '',
            code: 0,
          };
        },
      );

      issuePromise = adapter.getIssue('ISS-1');
    });

    await execStarted;
    expect(capturedArgs).not.toContain('--api-key');
    expect(capturedArgs).not.toContain('session-key');
    expect(capturedProcessEnvApiKey).toBe(previousApiKey);
    expect(capturedChildEnvApiKey).toBe('session-key');
    expect(process.env.AMASTER_BOARD_API_KEY).toBe(previousApiKey);
    releaseExec();
    await expect(issuePromise).resolves.toMatchObject({ id: 'ISS-1' });
  });

  it('passes workspace IDs through to AMaster company-aware CLI commands', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'comment') {
        return {
          stdout: JSON.stringify({ id: 'COMMENT-1', content: 'commented' }),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'project') return { stdout: '[]', stderr: '', code: 0 };
      if (args[0] === 'issue' && args[1] === 'list') return { stdout: '[]', stderr: '', code: 0 };
      return {
        stdout: JSON.stringify({ issue: { id: 'ISS-1', title: 'Issue', status: 'todo' } }),
        stderr: '',
        code: 0,
      };
    };
    const adapter = new AmasterAdapter({}, exec);

    await adapter.listIssues({ workspaceId: 'company-2' });
    await adapter.getIssue('ISS-1', 'company-2');
    await adapter.createIssue({ workspaceId: 'company-2', title: 'Created' });
    await adapter.updateIssue('ISS-1', { status: 'done' }, 'company-2');
    await adapter.addComment('ISS-1', 'commented', undefined, 'company-2');
    await adapter.listProjects('company-2');

    expect(calls).toEqual([
      ['issue', 'list', '-C', 'company-2', '--json'],
      ['issue', 'get', 'ISS-1', '-C', 'company-2', '--json'],
      ['issue', 'create', '--title', 'Created', '-C', 'company-2', '--json'],
      ['issue', 'update', 'ISS-1', '-C', 'company-2', '--status', 'done', '--json'],
      ['issue', 'comment', 'ISS-1', '--content', 'commented', '-C', 'company-2', '--json'],
      ['project', 'list', '-C', 'company-2', '--json'],
    ]);
  });

  it('ignores parent comment IDs for AMaster top-level comments', async () => {
    const calls: string[][] = [];
    const adapter = new AmasterAdapter({}, async (_cmd, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ id: 'COMMENT-2', content: 'reply' }),
        stderr: '',
        code: 0,
      };
    });

    await expect(
      adapter.addComment('ISS-1', 'reply', 'COMMENT-1', 'company-2'),
    ).resolves.toMatchObject({
      id: 'COMMENT-2',
      issueId: 'ISS-1',
    });
    expect(calls).toEqual([
      ['issue', 'comment', 'ISS-1', '--content', 'reply', '-C', 'company-2', '--json'],
    ]);
  });

  it('lists all AMaster companies without probing runtime status', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const adapter = new AmasterAdapter({}, async (cmd, args) => {
      calls.push({ cmd, args });
      return {
        stdout: JSON.stringify([
          { id: 'company-1', name: 'Main', urlKey: 'MAIN' },
          { id: 'company-2', title: 'Second', status: 'active' },
        ]),
        stderr: '',
        code: 0,
      };
    });

    await expect(adapter.listWorkspaces()).resolves.toEqual([
      { id: 'company-1', name: 'Main' },
      { id: 'company-2', name: 'Second' },
    ]);
    expect(calls).toEqual([{ cmd: 'amaster-employee', args: ['company', 'list', '--json'] }]);
  });

  it('uses the canonical workspace id returned by workspace_list for later -C calls', async () => {
    const calls: string[][] = [];
    const adapter = new AmasterAdapter({}, async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'company') {
        return {
          stdout: JSON.stringify([
            { id: 'company-canonical-1', name: 'Display Name', urlKey: 'display-name' },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    });

    const workspaces = await adapter.listWorkspaces();
    await adapter.listIssues({ workspaceId: workspaces[0]!.id });

    expect(workspaces).toEqual([{ id: 'company-canonical-1', name: 'Display Name' }]);
    expect(calls[1]).toEqual(['issue', 'list', '-C', 'company-canonical-1', '--json']);
  });

  it('falls back to the only AMaster company when no workspaceId is provided', async () => {
    const calls: string[][] = [];
    const adapter = new AmasterAdapter({}, async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'company') {
        return {
          stdout: JSON.stringify([{ id: 'company-only', name: 'Only Company' }]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    });

    await adapter.listIssues();

    expect(calls).toEqual([
      ['company', 'list', '--json'],
      ['issue', 'list', '-C', 'company-only', '--json'],
    ]);
  });

  it('requires workspaceId when multiple AMaster companies are available', async () => {
    const adapter = new AmasterAdapter({}, async (_cmd, args) => {
      if (args[0] === 'company') {
        return {
          stdout: JSON.stringify([
            { id: 'company-1', name: 'One' },
            { id: 'company-2', name: 'Two' },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    });

    await expect(adapter.listIssues()).rejects.toThrow(
      'Multiple AMaster workspaces are available; pass workspaceId from workspace_list.',
    );
  });

  it('maps create and update envelope responses', async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[1] === 'create') {
        return {
          stdout: JSON.stringify({ issue: { id: 'ISS-2', title: 'Created', status: 'backlog' } }),
          stderr: '',
          code: 0,
        };
      }
      return {
        stdout: JSON.stringify({ issue: { id: args[2], title: 'Updated', status: 'done' } }),
        stderr: '',
        code: 0,
      };
    };
    const adapter = new AmasterAdapter({}, exec);

    await expect(
      adapter.createIssue({ workspaceId: 'company-1', title: 'Created' }),
    ).resolves.toMatchObject({
      id: 'ISS-2',
      title: 'Created',
      status: 'backlog',
    });
    await expect(
      adapter.updateIssue('ISS-2', { status: 'done' }, 'company-1'),
    ).resolves.toMatchObject({
      id: 'ISS-2',
      title: 'Updated',
      status: 'done',
    });
  });

  it('fails create when AMaster CLI does not return a created issue', async () => {
    const adapter = new AmasterAdapter({}, successExec('not json'));

    await expect(
      adapter.createIssue({ workspaceId: 'company-1', title: 'Created' }),
    ).rejects.toThrow('AMaster issue create did not return valid JSON.');
  });

  it('fails comments when AMaster CLI does not return a comment id', async () => {
    const adapter = new AmasterAdapter({}, successExec(JSON.stringify({ content: 'saved' })));

    await expect(adapter.addComment('ISS-1', 'saved', undefined, 'company-1')).rejects.toThrow(
      'AMaster issue comment did not return a created comment.',
    );
  });

  it('fails list commands on malformed AMaster CLI responses', async () => {
    const adapter = new AmasterAdapter({}, successExec('not json'));

    await expect(adapter.listWorkspaces()).rejects.toThrow(
      'AMaster company list did not return a JSON array.',
    );
    await expect(adapter.listIssues({ workspaceId: 'company-1' })).rejects.toThrow(
      'AMaster issue list did not return a JSON array.',
    );
    await expect(adapter.listProjects('company-1')).rejects.toThrow(
      'AMaster project list did not return a JSON array.',
    );
    await expect(adapter.listAgents('company-1')).rejects.toThrow(
      'AMaster agent list did not return a JSON array.',
    );
    await expect(adapter.listUserDirectory({ workspaceId: 'company-1' })).rejects.toThrow(
      'AMaster user-directory list did not return a JSON array.',
    );
  });

  it('preserves AMaster issue metadata and custom fields while redacting sensitive fields', async () => {
    const adapter = new AmasterAdapter(
      {},
      successExec(
        JSON.stringify({
          issue: {
            id: 'ISS-1',
            identifier: 'AMA-1',
            title: 'With context',
            status: 'todo',
            projectId: 'project-1',
            metadata: {
              executionMode: 'runtime',
              apiKey: 'secret-key',
            },
            customFields: {
              customer: 'ACME',
              dbUrl: 'postgres://secret',
            },
            comments: [{ id: 'COMMENT-1', body: 'context' }],
            agent: { id: 'agent-1', name: 'Codex' },
          },
        }),
      ),
    );

    await expect(adapter.getIssue('ISS-1', 'company-1')).resolves.toMatchObject({
      id: 'ISS-1',
      project: 'project-1',
      metadata: {
        identifier: 'AMA-1',
        projectId: 'project-1',
        metadata: {
          executionMode: 'runtime',
          apiKey: '[redacted]',
        },
        customFields: {
          customer: 'ACME',
          dbUrl: '[redacted]',
        },
        comments: [{ id: 'COMMENT-1', body: 'context' }],
        agent: { id: 'agent-1', name: 'Codex' },
      },
    });
  });

  it('lists comments from both top-level and nested AMaster metadata comment arrays', async () => {
    const adapter = new AmasterAdapter(
      {},
      successExec(
        JSON.stringify({
          issue: {
            id: 'ISS-1',
            title: 'With comments',
            status: 'todo',
            comments: [{ id: 'TOP-1', body: 'top level' }],
            metadata: {
              comments: [{ id: 'META-1', content: 'nested', authorName: 'Alice' }],
            },
          },
        }),
      ),
    );

    await expect(adapter.listComments('ISS-1', 'company-1')).resolves.toEqual([
      { id: 'TOP-1', issueId: 'ISS-1', content: 'top level' },
      {
        id: 'META-1',
        issueId: 'ISS-1',
        content: 'nested',
        author: 'Alice',
      },
    ]);
  });

  it('exposes agent and user-directory read-only lists through the AMaster CLI', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'agent') {
        return {
          stdout: JSON.stringify([
            { id: 'agent-1', name: 'Codex', status: 'active', urlKey: 'codex' },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return {
        stdout: JSON.stringify([
          { id: 'user-1', name: 'Alice', email: 'alice@example.com', role: 'owner' },
        ]),
        stderr: '',
        code: 0,
      };
    };
    const adapter = new AmasterAdapter({}, exec);

    await expect(adapter.listAgents('company-2')).resolves.toEqual([
      {
        id: 'agent-1',
        name: 'Codex',
        status: 'active',
        role: undefined,
        title: undefined,
        urlKey: 'codex',
      },
    ]);
    await expect(
      adapter.listUserDirectory({ workspaceId: 'company-2', q: 'Alice', limit: 5 }),
    ).resolves.toEqual([
      {
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'owner',
        type: undefined,
        status: undefined,
      },
    ]);
    expect(calls).toEqual([
      ['agent', 'list', '-C', 'company-2', '--json'],
      ['user-directory', 'list', '-C', 'company-2', '--q', 'Alice', '--limit', '5', '--json'],
    ]);
  });

  it('separates Employee CLI, auth, and runtime daemon failure messages', async () => {
    const commandMissing = new AmasterAdapter({}, failExec('spawn amaster-employee ENOENT'));
    await expect(commandMissing.listIssues()).rejects.toThrow(
      'AMaster Employee managed CLI wrapper is missing',
    );

    const unauthorized = new AmasterAdapter({}, failExec('HTTP 401 unauthorized'));
    await expect(unauthorized.listIssues()).rejects.toThrow(
      'login/session_start auth was not propagated',
    );

    const runtimeDown = new AmasterAdapter({}, async (_cmd, args) => {
      if (args[0] === 'status') return { stdout: '{"ok":true}', stderr: '', code: 0 };
      return { stdout: '', stderr: 'connect ECONNREFUSED', code: 1 };
    });
    await expect(runtimeDown.status()).resolves.toMatchObject({
      ok: true,
      runtimeOk: false,
      runtimeError: expect.stringContaining('only local executor lease is affected'),
    });
  });

  it('redacts sensitive fields from status output', async () => {
    const adapter = new AmasterAdapter({}, async (_cmd, args) => {
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({
            ok: true,
            apiKey: 'secret-key',
            nested: { authorization: 'Bearer secret-token' },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: 'connector_token=secret-token', stderr: '', code: 1 };
    });

    const status = await adapter.status();
    expect(JSON.stringify(status)).not.toContain('secret-key');
    expect(JSON.stringify(status)).not.toContain('secret-token');
    expect(status).toMatchObject({
      teamwork: {
        apiKey: '[redacted]',
        nested: { authorization: '[redacted]' },
      },
    });
  });

  it('uses managed AMaster command names', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const adapter = new AmasterAdapter({}, async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '{}', stderr: '', code: 0 };
    });

    await adapter.status();

    expect(calls).toEqual([
      { cmd: 'amaster-employee', args: ['status', '--json'] },
      { cmd: 'amaster-runtime', args: ['daemon', 'status'] },
    ]);
  });

  it('initializes through the provider factory', async () => {
    await expect(initAmasterProvider({}, successExec())).resolves.toBeInstanceOf(AmasterAdapter);
  });
});

describe('piTeamworkExtension AMaster provider', () => {
  async function createSettingsDir(config: Record<string, unknown>): Promise<string> {
    return import('node:fs/promises').then(async ({ mkdir, mkdtemp, writeFile }) => {
      const { tmpdir } = await import('node:os');
      const path = await import('node:path');
      const dir = await mkdtemp(path.join(tmpdir(), 'pi-teamwork-amaster-'));
      await mkdir(path.join(dir, '.pi'), { recursive: true });
      await writeFile(path.join(dir, '.pi', 'settings.json'), JSON.stringify(config));
      return dir;
    });
  }

  async function withFakeAmasterEmployeeCli<T>(
    handler: () => Promise<T>,
  ): Promise<{ result: T; calls: Array<{ args: string[]; hasApiKey: boolean }> }> {
    const { chmod, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-teamwork-fake-amaster-'));
    const logPath = path.join(dir, 'calls.jsonl');
    const binPath = path.join(dir, 'amaster-employee');
    await writeFile(
      binPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, hasApiKey: Boolean(process.env.AMASTER_BOARD_API_KEY) }) + '\\n');`,
        "if (args[0] === 'agent') console.log(JSON.stringify([{ id: 'agent-1', name: 'Codex' }]));",
        "else if (args[0] === 'user-directory') console.log(JSON.stringify([{ id: 'user-1', name: 'Alice' }]));",
        "else console.log('[]');",
      ].join('\n'),
    );
    await chmod(binPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const result = await handler();
      const log = await readFile(logPath, 'utf8').catch(() => '');
      const calls = log
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; hasApiKey: boolean });
      return { result, calls };
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('initializes provider=amaster and passes session_start api key only to child env', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'amaster',
        amaster: {
          apiBase: 'http://amaster.test',
        },
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    const tools = new Map<string, RegisteredTool>();
    const statusUpdates: string[] = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      exec: vi.fn(async () => ({ stdout: '[]', stderr: '', code: 0 })),
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];
    expect(sessionStartHandler).toBeTypeOf('function');

    await sessionStartHandler(
      {
        amasterEmployee: { apiKey: 'session-key' },
      },
      {
        cwd: settingsDir,
        ui: {
          setStatus: (_key: string, value: string) => statusUpdates.push(value),
          notify: vi.fn(),
        },
      },
    );

    const { result, calls } = await withFakeAmasterEmployeeCli(async () => {
      const agentResult = await tools
        .get('agent_list')!
        .execute('tool-1' as never, { workspaceId: 'company-2' } as never);
      const userResult = await tools
        .get('user_directory_list')!
        .execute('tool-2' as never, { workspaceId: 'company-2', q: 'Ali' } as never);
      return { agentResult, userResult };
    });

    expect(statusUpdates).toContain('teamwork: amaster');
    expect(result.agentResult.content[0]?.text).toContain('agent-1');
    expect(result.userResult.content[0]?.text).toContain('Alice');
    expect(pi.exec).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        args: ['agent', 'list', '--api-base', 'http://amaster.test', '-C', 'company-2', '--json'],
        hasApiKey: true,
      },
      {
        args: [
          'user-directory',
          'list',
          '--api-base',
          'http://amaster.test',
          '-C',
          'company-2',
          '--q',
          'Ali',
          '--json',
        ],
        hasApiKey: true,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('session-key');

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('registers tools from the active AMaster provider capabilities', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'amaster',
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
        ui: {
          setStatus: vi.fn(),
          notify: vi.fn(),
        },
      },
    );
    await beforeAgentStartHandler({ systemPrompt: '' });

    expect(toolNames).toEqual([
      'workspace_list',
      'issue_list',
      'issue_get',
      'issue_create',
      'issue_update',
      'issue_comment',
      'project_list',
      'agent_list',
      'user_directory_list',
      'teamwork_status',
    ]);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });
});

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

  it('does not register AMaster-only tools for Multica sessions', async () => {
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
        ui: {
          setStatus: vi.fn(),
          notify: vi.fn(),
        },
      },
    );
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
    expect(toolNames).not.toContain('agent_list');
    expect(toolNames).not.toContain('user_directory_list');

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

  it('removes unsupported teamwork tools from the active set after a provider switch', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'amaster',
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    let activeTools = ['read', 'agent_list', 'user_directory_list', 'issue_list'];
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
    const beforeAgentStartHandler = pi.on.mock.calls.find(
      (call) => call[0] === 'before_agent_start',
    )?.[1];
    const ctx = {
      cwd: settingsDir,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    };

    await sessionStartHandler({}, ctx);
    await import('node:fs/promises').then(async ({ writeFile }) => {
      const path = await import('node:path');
      await writeFile(
        path.join(settingsDir, '.pi', 'settings.json'),
        JSON.stringify({
          'pi-teamwork': {
            provider: 'multica',
            multica: { autoInstall: false },
          },
        }),
      );
    });
    await sessionStartHandler({}, ctx);
    await beforeAgentStartHandler({ systemPrompt: '' });

    expect(activeTools).toEqual(['read', 'issue_list']);
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(['read', 'issue_list']);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('restores AMaster-only active tools when switching back to AMaster', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'multica',
        multica: { autoInstall: false },
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    let activeTools = ['read', 'issue_list'];
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
    const beforeAgentStartHandler = pi.on.mock.calls.find(
      (call) => call[0] === 'before_agent_start',
    )?.[1];
    const ctx = {
      cwd: settingsDir,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    };

    await sessionStartHandler({}, ctx);
    await beforeAgentStartHandler({ systemPrompt: '' });
    await import('node:fs/promises').then(async ({ writeFile }) => {
      const path = await import('node:path');
      await writeFile(
        path.join(settingsDir, '.pi', 'settings.json'),
        JSON.stringify({
          'pi-teamwork': {
            provider: 'amaster',
          },
        }),
      );
    });
    await sessionStartHandler({}, ctx);

    expect(activeTools).toEqual(['read', 'issue_list']);
    expect(pi.setActiveTools).not.toHaveBeenLastCalledWith(expect.arrayContaining(['agent_list']));

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('restores only teamwork tools suspended by a previous provider', async () => {
    const previousSettings = process.env.PI_SETTINGS_DIR;
    const settingsDir = await createSettingsDir({
      'pi-teamwork': {
        provider: 'amaster',
      },
    });
    process.env.PI_SETTINGS_DIR = settingsDir;
    let activeTools = ['read', 'agent_list', 'user_directory_list', 'issue_list'];
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
    const beforeAgentStartHandler = pi.on.mock.calls.find(
      (call) => call[0] === 'before_agent_start',
    )?.[1];
    const ctx = {
      cwd: settingsDir,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    };

    await sessionStartHandler({}, ctx);
    await import('node:fs/promises').then(async ({ writeFile }) => {
      const path = await import('node:path');
      await writeFile(
        path.join(settingsDir, '.pi', 'settings.json'),
        JSON.stringify({
          'pi-teamwork': {
            provider: 'multica',
            multica: { autoInstall: false },
          },
        }),
      );
    });
    await sessionStartHandler({}, ctx);
    await beforeAgentStartHandler({ systemPrompt: '' });
    await import('node:fs/promises').then(async ({ writeFile }) => {
      const path = await import('node:path');
      await writeFile(
        path.join(settingsDir, '.pi', 'settings.json'),
        JSON.stringify({
          'pi-teamwork': {
            provider: 'amaster',
          },
        }),
      );
    });
    await sessionStartHandler({}, ctx);

    expect(activeTools).toEqual(['read', 'issue_list', 'agent_list', 'user_directory_list']);

    if (previousSettings === undefined) delete process.env.PI_SETTINGS_DIR;
    else process.env.PI_SETTINGS_DIR = previousSettings;
    await import('node:fs/promises').then(({ rm }) =>
      rm(settingsDir, { recursive: true, force: true }),
    );
  });

  it('ignores stale Multica initialization after switching to AMaster', async () => {
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
      ui: {
        setStatus: (_key: string, value: string) => statusUpdates.push(value),
        notify: vi.fn(),
      },
    };
    piTeamworkExtension(pi as never);
    const sessionStartHandler = pi.on.mock.calls.find((call) => call[0] === 'session_start')?.[1];
    const beforeAgentStartHandler = pi.on.mock.calls.find(
      (call) => call[0] === 'before_agent_start',
    )?.[1];

    const multicaStart = sessionStartHandler({}, ctx);
    await multicaStarted;
    await import('node:fs/promises').then(async ({ writeFile }) => {
      const path = await import('node:path');
      await writeFile(
        path.join(settingsDir, '.pi', 'settings.json'),
        JSON.stringify({
          'pi-teamwork': {
            provider: 'amaster',
          },
        }),
      );
    });
    await sessionStartHandler({}, ctx);
    releaseMultica();
    await multicaStart;
    const prompt = await beforeAgentStartHandler({ systemPrompt: 'base' });
    const agentResult = await tools.get('agent_list')!.execute('tool-1' as never, {} as never);

    expect(statusUpdates.at(-1)).toBe('teamwork: amaster');
    expect(prompt.systemPrompt).toContain('<teamwork-guidance>');
    expect(agentResult.content[0]?.text).toBe('No agents found.');

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
    let activeTools = ['read', 'issue_list', 'agent_list'];
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
    let activeTools = ['read', 'issue_list', 'agent_list'];
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
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['--version']);
    expect(calls[1]).toEqual(['daemon', 'start']);
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

  it('skips install when autoInstall is false', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ autoInstall: false }, exec);
    expect(calls[0]).toEqual(['daemon', 'start']);
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
    const { adapter, installResult } = await initMulticaProvider({}, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(installResult.installed).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
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
    await initMulticaProvider({ serverUrl: 'https://api.example.com', token: 'tk' }, exec);
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

describe('ensureMulticaBinary', () => {
  it('returns alreadyPresent when binary exists', async () => {
    const exec: ExecFn = async () => ({ stdout: 'multica 1.0.0', stderr: '', code: 0 });
    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: true });
  });

  it('attempts brew install on macOS/Linux when brew is available', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/opt/homebrew/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'brew' && c.args.includes('multica-ai/tap/multica'))).toBe(
      true,
    );

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('falls back to curl when brew is not available', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'bash' && c.args[0] === '-c')).toBe(true);
    expect(calls.some((c) => c.cmd === 'brew')).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('falls back to curl when brew install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/opt/homebrew/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') return { stdout: '', stderr: 'brew error', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'bash' && c.args[0] === '-c')).toBe(true);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('uses powershell on Windows', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'powershell') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'powershell' && c.args[0] === '-Command')).toBe(true);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when install fails and binary still not found', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which' && args[0] === 'brew') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: 'network error', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.alreadyPresent).toBe(false);
    expect(result.error).toBeDefined();

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when binary not on PATH after successful install', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/usr/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('multica binary not found on PATH after installation');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('handles exec throwing an exception', async () => {
    let callCount = 0;
    const exec: ExecFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('command not found');
      throw new Error('still not found');
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.alreadyPresent).toBe(false);
  });

  it('uses custom binary name for version check', async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (cmd) => {
      cmds.push(cmd);
      return { stdout: 'multica 2.0', stderr: '', code: 0 };
    };
    await ensureMulticaBinary('/custom/path/multica', exec);
    expect(cmds[0]).toBe('/custom/path/multica');
  });

  it('does not attempt install when binary already exists', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
    };
    await ensureMulticaBinary('multica', exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['--version']);
  });

  it('handles brew exec throwing exception and falls back to curl', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/opt/homebrew/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') throw new Error('brew crashed');
      if (cmd === 'bash') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'bash' && c.args[0] === '-c')).toBe(true);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when curl fallback exec throws', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which' && args[0] === 'brew') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') throw new Error('network timeout');
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('network timeout');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when Windows powershell install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'powershell') return { stdout: '', stderr: 'access denied', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('access denied');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when Windows powershell exec throws', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'powershell') throw new Error('powershell not found');
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('powershell not found');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });
});
