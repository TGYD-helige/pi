import { spawn } from 'node:child_process';
import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { initAmasterProvider } from './adapters/amaster.js';
import { initMulticaProvider } from './adapters/multica.js';
import type { AmasterAdapterConfig, ExecFn, TeamworkConfig, TeamworkProvider } from './types.js';

const SETTINGS_KEY = 'pi-teamwork';
const STATUS_KEY = 'pi-teamwork';
const TEAMWORK_TOOL_ORDER = [
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
] as const;
const TEAMWORK_TOOL_NAMES = new Set<string>(TEAMWORK_TOOL_ORDER);

const TEAMWORK_GUIDANCE = [
  '<teamwork-guidance>',
  'You are working in a shared project tracker (teamwork) where humans and other agents collaborate. Use the issue_* and project_* tools to keep that shared space in sync.',
  '',
  'Before starting non-trivial work, check whether a relevant issue already exists (issue_list / issue_get) — to avoid duplicating work another collaborator has picked up.',
  '',
  'When you reach meaningful progress, hit a blocker, or need input from a collaborator, leave a comment on the relevant issue (issue_comment). Comments are how humans and other agents observe what you are doing.',
  '',
  'When you finish work that an issue describes, update its status (issue_update). An issue left in an outdated state misleads other collaborators.',
  '',
  'The tracker is for cross-collaborator coordination, not for tracking your own session-local TODOs. Do not file an issue just to remind yourself of something within the current conversation.',
  '</teamwork-guidance>',
].join('\n');

export default function piTeamworkExtension(pi: ExtensionAPI): void {
  let provider: TeamworkProvider | undefined;
  let readyPromise: Promise<void> | undefined;
  let sessionGeneration = 0;
  const registeredToolNames = new Set<string>();
  const suspendedToolNames = new Set<string>();

  async function ensureReady(): Promise<string | undefined> {
    if (readyPromise) await readyPromise;
    if (!provider) return 'Teamwork provider is not initialized.';
    return undefined;
  }

  function getProvider(): TeamworkProvider {
    if (!provider) throw new Error('Teamwork provider is not initialized.');
    return provider;
  }

  const teamworkTools = createTeamworkTools(ensureReady, getProvider);

  function registerProviderTools(adapter: TeamworkProvider): void {
    const supportedToolNames = supportedToolNamesForProvider(adapter);
    for (const tool of teamworkTools) {
      if (!supportedToolNames.has(tool.name) || registeredToolNames.has(tool.name)) {
        continue;
      }
      pi.registerTool(tool);
      registeredToolNames.add(tool.name);
    }
    alignActiveTeamworkTools(pi, supportedToolNames, suspendedToolNames);
  }

  function suspendTeamworkTools(): void {
    alignActiveTeamworkTools(pi, new Set(), suspendedToolNames);
  }

  pi.on('session_start', async (_event, ctx) => {
    const generation = ++sessionGeneration;
    provider = undefined;
    readyPromise = undefined;

    const config = loadConfig(ctx.cwd);
    if (config.enabled === false) {
      suspendTeamworkTools();
      ctx.ui.setStatus(STATUS_KEY, 'teamwork: disabled');
      return;
    }

    const exec: ExecFn = async (command, args, options) => {
      if (options?.env && Object.keys(options.env).length > 0) {
        return execWithEnv(command, args, options.env, ctx.cwd);
      }
      const result = await pi.exec(command, args);
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    };

    const providerName = config.provider ?? 'multica';
    if (providerName === 'amaster') {
      const amasterConfig: AmasterAdapterConfig = { ...(config.amaster ?? {}) };
      const apiKey = amasterApiKeyFromSessionStart(_event);
      if (apiKey) amasterConfig.apiKey = apiKey;
      const adapter = await initAmasterProvider(amasterConfig, exec);
      if (generation !== sessionGeneration) return;
      provider = adapter;
      registerProviderTools(adapter);
      ctx.ui.setStatus(STATUS_KEY, 'teamwork: amaster');
      return;
    }

    if (providerName !== 'multica') {
      suspendTeamworkTools();
      ctx.ui.setStatus(STATUS_KEY, `teamwork: unknown provider "${providerName}"`);
      return;
    }

    readyPromise = (async () => {
      const { adapter, installResult } = await initMulticaProvider(config.multica ?? {}, exec);
      if (generation !== sessionGeneration) return;
      provider = adapter;
      registerProviderTools(adapter);

      if (!installResult.installed) {
        ctx.ui.notify(
          `multica CLI could not be installed: ${installResult.error ?? 'unknown error'}. Run "multica setup" manually.`,
          'warning',
        );
        ctx.ui.setStatus(STATUS_KEY, 'teamwork: multica (not installed)');
        return;
      }

      if (!installResult.alreadyPresent) {
        ctx.ui.notify('multica CLI was auto-installed successfully.', 'info');
      }

      if (!config.multica?.token && !config.multica?.serverUrl) {
        ctx.ui.notify(
          'No multica token or serverUrl configured. Run "multica setup" to authenticate.',
          'warning',
        );
      }

      if (config.multica?.serverUrl && !config.multica?.appUrl) {
        ctx.ui.notify(
          'multica serverUrl is set but appUrl is missing. Remote servers require both.',
          'warning',
        );
      }

      ctx.ui.setStatus(STATUS_KEY, 'teamwork: multica');
    })().catch((err) => {
      if (generation !== sessionGeneration) return;
      ctx.ui.setStatus(
        STATUS_KEY,
        `teamwork: multica (error: ${err instanceof Error ? err.message : String(err)})`,
      );
    });
  });

  pi.on('session_shutdown', async () => {
    sessionGeneration++;
    provider = undefined;
    readyPromise = undefined;
  });

  pi.on('before_agent_start', async (event) => {
    if (readyPromise) await readyPromise;
    if (!provider) return;
    return {
      systemPrompt: event.systemPrompt
        ? `${event.systemPrompt}\n\n${TEAMWORK_GUIDANCE}`
        : TEAMWORK_GUIDANCE,
    };
  });

  pi.registerCommand('teamwork-status', {
    description: 'Show teamwork provider status.',
    handler: async (_args, ctx) => {
      if (readyPromise) await readyPromise;
      if (!provider) {
        ctx.ui.notify('Teamwork provider is not initialized.', 'warning');
        return;
      }
      try {
        const s = await provider.status();
        ctx.ui.notify(JSON.stringify(s, null, 2), 'info');
      } catch (error) {
        ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}

type EnsureReadyFn = () => Promise<string | undefined>;
type GetProviderFn = () => TeamworkProvider;

function createTeamworkTools(ensureReady: EnsureReadyFn, getProvider: GetProviderFn) {
  return [
    defineTool({
      name: 'workspace_list',
      label: 'Teamwork',
      description:
        'List all workspaces you belong to. Use this to discover or switch workspaces. For the AMaster provider, workspaceId is the canonical AMaster companyId passed to the CLI as -C.',
      promptSnippet: 'List workspaces in the shared project tracker.',
      parameters: Type.Object({}),
      async execute() {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const workspaces = await getProvider().listWorkspaces();
          if (workspaces.length === 0) return textResult('No workspaces found.');
          return textResult(JSON.stringify(workspaces, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'issue_list',
      label: 'Teamwork',
      description:
        'List issues from a shared project tracker. Issues are work items that humans or other agents collaborate on. Supports filtering by status, assignee, and project.',
      promptSnippet:
        'List issues from a shared project tracker where humans and agents collaborate.',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
        status: Type.Optional(
          Type.String({ description: 'Filter by status (e.g. todo, in_progress, done, blocked).' }),
        ),
        assignee: Type.Optional(Type.String({ description: 'Filter by assignee name.' })),
        project: Type.Optional(Type.String({ description: 'Filter by project ID.' })),
        limit: Type.Optional(Type.Number({ description: 'Max number of results.' })),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const issues = await getProvider().listIssues(params);
          if (issues.length === 0) return textResult('No issues found.');
          return textResult(JSON.stringify(issues, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'issue_get',
      label: 'Teamwork',
      description:
        'Get detailed information about a specific issue (a work item in the shared project tracker).',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
        id: Type.String({ description: 'The issue ID.' }),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const issue = await getProvider().getIssue(params.id, params.workspaceId);
          if (!issue) return textResult(`Issue not found: ${params.id}`);
          return textResult(JSON.stringify(issue, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'issue_create',
      label: 'Teamwork',
      description:
        'Create a new issue (a work item / ticket) in the shared project tracker. Use this to file work for humans or other agents to pick up.',
      promptSnippet:
        'Create issues / tickets in a shared project tracker for humans or agents to collaborate on.',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
        title: Type.String({ description: 'Issue title.' }),
        description: Type.Optional(Type.String({ description: 'Issue description.' })),
        priority: Type.Optional(
          Type.String({ description: 'Priority (e.g. low, medium, high, urgent).' }),
        ),
        assignee: Type.Optional(Type.String({ description: 'Assignee name.' })),
        project: Type.Optional(Type.String({ description: 'Project ID to associate with.' })),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const issue = await getProvider().createIssue(params);
          return textResult(JSON.stringify(issue, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'issue_update',
      label: 'Teamwork',
      description:
        'Update an existing issue in the shared project tracker. Can change title, description, status, priority, or assignee.',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
        id: Type.String({ description: 'The issue ID to update.' }),
        title: Type.Optional(Type.String({ description: 'New title.' })),
        description: Type.Optional(Type.String({ description: 'New description.' })),
        status: Type.Optional(
          Type.String({
            description:
              'New status (e.g. todo, in_progress, in_review, done, blocked, cancelled).',
          }),
        ),
        priority: Type.Optional(Type.String({ description: 'New priority.' })),
        assignee: Type.Optional(Type.String({ description: 'New assignee name.' })),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        const { id, workspaceId, ...input } = params;
        try {
          const issue = await getProvider().updateIssue(id, input, workspaceId);
          if (!issue) return textResult(`Issue not found: ${id}`);
          return textResult(JSON.stringify(issue, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'issue_comment',
      label: 'Teamwork',
      description:
        'Add a comment to an issue in the shared project tracker. Use for progress updates, questions, or blockers visible to other collaborators (humans or agents).',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
        issueId: Type.String({ description: 'The issue ID to comment on.' }),
        content: Type.String({ description: 'Comment content.' }),
        parentId: Type.Optional(
          Type.String({
            description:
              'Optional provider-specific parent comment ID. The AMaster provider currently creates top-level comments.',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const comment = await getProvider().addComment(
            params.issueId,
            params.content,
            params.parentId,
            params.workspaceId,
          );
          return textResult(JSON.stringify(comment, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'project_list',
      label: 'Teamwork',
      description: 'List all projects in a workspace.',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const projects = await getProvider().listProjects(params.workspaceId);
          if (projects.length === 0) return textResult('No projects found.');
          return textResult(JSON.stringify(projects, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'agent_list',
      label: 'Teamwork',
      description:
        'List AMaster agents available in the current teamwork workspace. This is read-only and helps choose assignable agents.',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        const activeProvider = getProvider();
        if (!activeProvider.listAgents)
          return textResult('The current teamwork provider does not support agent_list.');
        try {
          const agents = await activeProvider.listAgents(params.workspaceId);
          if (agents.length === 0) return textResult('No agents found.');
          return textResult(JSON.stringify(agents, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'user_directory_list',
      label: 'Teamwork',
      description:
        'List assignable AMaster users or members in the current teamwork workspace. This is read-only and helps choose assignees.',
      parameters: Type.Object({
        workspaceId: Type.Optional(
          Type.String({
            description:
              'Workspace ID. For AMaster provider this is the canonical companyId from workspace_list and is passed to the CLI as -C. Optional when the account has exactly one workspace.',
          }),
        ),
        q: Type.Optional(Type.String({ description: 'Optional search text.' })),
        limit: Type.Optional(Type.Number({ description: 'Max number of results.' })),
      }),
      async execute(_toolCallId, params) {
        const err = await ensureReady();
        if (err) return textResult(err);
        const activeProvider = getProvider();
        if (!activeProvider.listUserDirectory) {
          return textResult('The current teamwork provider does not support user_directory_list.');
        }
        try {
          const users = await activeProvider.listUserDirectory(params);
          if (users.length === 0) return textResult('No assignable users found.');
          return textResult(JSON.stringify(users, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),

    defineTool({
      name: 'teamwork_status',
      label: 'Teamwork',
      description:
        'Check the status of the teamwork collaboration provider (daemon status, connected agents, etc.).',
      parameters: Type.Object({}),
      async execute() {
        const err = await ensureReady();
        if (err) return textResult(err);
        try {
          const s = await getProvider().status();
          return textResult(JSON.stringify(s, null, 2));
        } catch (error) {
          return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
  ];
}

function supportedToolNamesForProvider(provider: TeamworkProvider): Set<string> {
  const supportedToolNames = new Set<string>(TEAMWORK_TOOL_ORDER);
  if (!provider.listAgents) supportedToolNames.delete('agent_list');
  if (!provider.listUserDirectory) supportedToolNames.delete('user_directory_list');
  return supportedToolNames;
}

function alignActiveTeamworkTools(
  pi: ExtensionAPI,
  supportedToolNames: Set<string>,
  suspendedToolNames: Set<string>,
): void {
  try {
    const activeToolNames = pi.getActiveTools();
    const nextActiveToolNames: string[] = [];
    for (const toolName of activeToolNames) {
      if (!TEAMWORK_TOOL_NAMES.has(toolName) || supportedToolNames.has(toolName)) {
        nextActiveToolNames.push(toolName);
        if (supportedToolNames.has(toolName)) suspendedToolNames.delete(toolName);
        continue;
      }
      suspendedToolNames.add(toolName);
    }
    for (const toolName of TEAMWORK_TOOL_ORDER) {
      if (
        supportedToolNames.has(toolName) &&
        suspendedToolNames.has(toolName) &&
        !nextActiveToolNames.includes(toolName)
      ) {
        nextActiveToolNames.push(toolName);
        suspendedToolNames.delete(toolName);
      }
    }
    if (nextActiveToolNames.join('\0') !== activeToolNames.join('\0')) {
      pi.setActiveTools(nextActiveToolNames);
    }
  } catch {
    // Older test harnesses and pre-session runtimes may not expose active tool controls.
  }
}

function amasterApiKeyFromSessionStart(event: unknown): string | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const amasterEmployee = (event as Record<string, unknown>).amasterEmployee;
  if (!amasterEmployee || typeof amasterEmployee !== 'object' || Array.isArray(amasterEmployee)) {
    return undefined;
  }
  const apiKey = (amasterEmployee as Record<string, unknown>).apiKey;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function execWithEnv(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish({ stdout, stderr: error.message, code: 1 });
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, code: code ?? 0 });
    });
  });
}

function loadConfig(cwd: string): TeamworkConfig {
  try {
    const config = loadPiSettings<Partial<TeamworkConfig>>(SETTINGS_KEY, {
      cwd,
    });
    return Object.keys(config).length > 0 ? (config as TeamworkConfig) : {};
  } catch {
    return {};
  }
}
