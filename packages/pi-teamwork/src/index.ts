import { addAbortListener } from 'node:events';
import { boundStructuredContent } from '@amaster.ai/pi-shared';
import { isProjectTrusted, loadPiSettings } from '@amaster.ai/pi-shared/settings';
import { defineTool, type ExtensionAPI, truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { initMulticaProvider } from './adapters/multica.js';
import type { ExecFn, TeamworkConfig, TeamworkProvider } from './types.js';

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
  'teamwork_status',
] as const;
const TEAMWORK_TOOL_NAMES = new Set<string>(TEAMWORK_TOOL_ORDER);

const TEAMWORK_GUIDANCE = [
  '<teamwork-guidance>',
  'Use the shared project tracker when the user requests tracker work or has authorized coordination for the current task. Tool availability alone does not authorize comments, issue creation, or status changes. A read-only review stays read-only.',
  '',
  'For authorized tracker work, before starting non-trivial work, check whether a relevant issue already exists (issue_list / issue_get) — to avoid duplicating work another collaborator has picked up.',
  '',
  'Within the authorized coordination scope, when you reach meaningful progress, hit a blocker, or need input from a collaborator, leave a comment on the relevant issue (issue_comment). Comments are how humans and other agents observe what you are doing.',
  '',
  'When completion is verified and issue updates are authorized, update its status (issue_update). An issue left in an outdated state misleads other collaborators.',
  '',
  'The tracker is for cross-collaborator coordination, not for tracking your own session-local TODOs. Do not file an issue just to remind yourself of something within the current conversation.',
  '</teamwork-guidance>',
].join('\n');

const WORKSPACE_ID_PARAM = Type.Optional(
  Type.String({
    description:
      'Workspace ID from workspace_list. Optional when the account has exactly one workspace.',
  }),
);

const errorSchema = Type.Object({ error: Type.String(), truncated: Type.Boolean() });
const issueSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    truncated: Type.Optional(Type.Literal(false)),
    title: Type.String(),
    status: Type.String(),
    description: Type.Optional(Type.String()),
    priority: Type.Optional(Type.String()),
    assignee: Type.Optional(Type.String()),
    project: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.String()),
  }),
  Type.Object({ id: Type.String(), truncated: Type.Literal(true) }),
]);
const commentSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    truncated: Type.Optional(Type.Literal(false)),
    issueId: Type.String(),
    content: Type.String(),
    author: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String()),
    parentId: Type.Optional(Type.String()),
  }),
  Type.Object({ id: Type.String(), truncated: Type.Literal(true) }),
]);
const projectSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    truncated: Type.Optional(Type.Literal(false)),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    lead: Type.Optional(Type.String()),
  }),
  Type.Object({ id: Type.String(), truncated: Type.Literal(true) }),
]);
const workspaceSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    truncated: Type.Optional(Type.Literal(false)),
    name: Type.String(),
  }),
  Type.Object({ id: Type.String(), truncated: Type.Literal(true) }),
]);
const issueOutputSchema = Type.Union([
  Type.Object({ issue: issueSchema, truncated: Type.Boolean() }),
  errorSchema,
]);

export default function piTeamworkExtension(pi: ExtensionAPI): void {
  let provider: TeamworkProvider | undefined;
  let readyPromise: Promise<void> | undefined;
  let sessionGeneration = 0;
  let sessionAbort: AbortController | undefined;
  let active = false;
  const registeredToolNames = new Set<string>();
  const suspendedToolNames = new Set<string>();

  async function ensureReady(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string | TeamworkProvider> {
    const generation = sessionGeneration;
    const waitSignal = AbortSignal.any([
      AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      ...(signal ? [signal] : []),
      ...(sessionAbort ? [sessionAbort.signal] : []),
    ]);
    waitSignal.throwIfAborted();
    let cleanup: ReturnType<typeof addAbortListener> | undefined;
    try {
      if (readyPromise)
        await Promise.race([
          readyPromise,
          new Promise<never>((_resolve, reject) => {
            cleanup = addAbortListener(waitSignal, () => reject(waitSignal.reason));
          }),
        ]);
    } finally {
      cleanup?.[Symbol.dispose]();
    }
    waitSignal.throwIfAborted();
    if (generation !== sessionGeneration) return 'Teamwork session was replaced.';
    if (!provider) return 'Teamwork provider is not initialized.';
    return provider.withExecution({ ...(signal ? { signal } : {}), deadline });
  }

  const teamworkTools = createTeamworkTools(ensureReady);

  function registerProviderTools(): void {
    for (const tool of teamworkTools) {
      if (registeredToolNames.has(tool.name)) continue;
      pi.registerTool(tool);
      registeredToolNames.add(tool.name);
    }
    alignActiveTeamworkTools(pi, TEAMWORK_TOOL_NAMES, suspendedToolNames);
  }

  function suspendTeamworkTools(): void {
    alignActiveTeamworkTools(pi, new Set(), suspendedToolNames);
  }

  pi.on('session_start', async (_event, ctx) => {
    const generation = ++sessionGeneration;
    sessionAbort?.abort();
    const controller = new AbortController();
    sessionAbort = controller;
    active = false;
    provider = undefined;
    readyPromise = undefined;

    const config = loadConfig(ctx.cwd, isProjectTrusted(ctx));
    if (config.enabled === false) {
      suspendTeamworkTools();
      ctx.ui.setStatus(STATUS_KEY, 'teamwork: disabled');
      return;
    }

    const providerName = config.provider ?? 'multica';
    if (providerName !== 'multica') {
      suspendTeamworkTools();
      ctx.ui.setStatus(STATUS_KEY, `teamwork: unknown provider "${providerName}"`);
      return;
    }

    active = true;
    registerProviderTools();
    let initDeadline: number | undefined = Date.now() + 10_000;
    const startupSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    const exec: ExecFn = async (command, args, execution) => {
      const sessionSignal = initDeadline === undefined ? controller.signal : startupSignal;
      const signal = execution?.signal
        ? AbortSignal.any([sessionSignal, execution.signal])
        : sessionSignal;
      signal.throwIfAborted();
      const deadline = Math.min(
        initDeadline ?? Date.now() + 30_000,
        execution?.deadline ?? Infinity,
      );
      const timeout = deadline - Date.now();
      if (timeout <= 0) throw new Error('Teamwork initialization timed out.');
      const result = await pi.exec(command, args, { cwd: ctx.cwd, signal, timeout });
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('Teamwork operation timed out.');
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    };

    readyPromise = (async () => {
      const { adapter, installResult } = await initMulticaProvider(config.multica ?? {}, exec);
      if (generation !== sessionGeneration || startupSignal.aborted || Date.now() >= initDeadline!)
        return;
      provider = adapter;

      if (!installResult.installed) {
        ctx.ui.notify(
          `multica CLI is unavailable: ${installResult.error ?? 'unknown error'}. Run "multica setup" after installing it.`,
          'warning',
        );
        ctx.ui.setStatus(STATUS_KEY, `teamwork: ${adapter.name} (not installed)`);
        return;
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

      ctx.ui.setStatus(STATUS_KEY, `teamwork: ${adapter.name}`);
    })()
      .catch(() => {
        if (generation !== sessionGeneration) return;
        console.error('[pi-teamwork] initialization failed');
        ctx.ui.setStatus(STATUS_KEY, 'teamwork: multica initialization failed');
      })
      .finally(() => {
        initDeadline = undefined;
      });
  });

  pi.on('session_shutdown', async () => {
    sessionGeneration++;
    sessionAbort?.abort();
    active = false;
    provider = undefined;
    readyPromise = undefined;
  });

  pi.on('before_agent_start', async (event) => {
    if (!active) return;
    return {
      systemPrompt: event.systemPrompt
        ? `${event.systemPrompt}\n\n${TEAMWORK_GUIDANCE}`
        : TEAMWORK_GUIDANCE,
    };
  });

  pi.registerCommand('teamwork-status', {
    description: 'Show teamwork provider status.',
    handler: async (_args, ctx) => {
      try {
        const backend = await ensureReady(ctx.signal, Date.now() + 30_000);
        if (typeof backend === 'string') {
          ctx.ui.notify(backend, 'warning');
          return;
        }
        const s = await backend.status();
        ctx.ui.notify(JSON.stringify(s, null, 2), 'info');
      } catch {
        ctx.ui.notify('Teamwork status request failed or was cancelled.', 'error');
      }
    },
  });
}

type EnsureReadyFn = (
  signal: AbortSignal | undefined,
  deadline: number,
) => Promise<string | TeamworkProvider>;

function createTeamworkTools(ensureReady: EnsureReadyFn) {
  async function runWithProvider<T>(
    signal: AbortSignal | undefined,
    operation: (backend: TeamworkProvider) => Promise<T>,
  ) {
    try {
      const backend = await ensureReady(signal, Date.now() + 30_000);
      if (typeof backend === 'string') return errorResult(backend);
      return await operation(backend);
    } catch {
      return providerErrorResult();
    }
  }

  return [
    defineTool({
      name: 'workspace_list',
      label: 'Teamwork',
      description: 'List all workspaces you belong to. Use this to discover or switch workspaces.',
      promptSnippet: 'List workspaces in the shared project tracker.',
      outputSchema: Type.Union([
        Type.Object({
          workspaces: Type.Array(workspaceSchema),
          total: Type.Integer(),
          truncated: Type.Boolean(),
        }),
        errorSchema,
      ]),
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        return runWithProvider(signal, async (backend) => {
          const workspaces = await backend.listWorkspaces();

          return textResult(
            { workspaces: workspaces, total: workspaces.length },
            workspaces.length ? undefined : 'No workspaces found.',
          );
        });
      },
    }),

    defineTool({
      name: 'issue_list',
      label: 'Teamwork',
      description:
        'List issues from a shared project tracker. Issues are work items that humans or other agents collaborate on. Supports filtering by status, assignee, and project.',
      promptSnippet:
        'List issues from a shared project tracker where humans and agents collaborate.',
      outputSchema: Type.Union([
        Type.Object({
          issues: Type.Array(issueSchema),
          total: Type.Integer(),
          truncated: Type.Boolean(),
        }),
        errorSchema,
      ]),
      parameters: Type.Object({
        workspaceId: WORKSPACE_ID_PARAM,
        status: Type.Optional(
          Type.String({ description: 'Filter by status (e.g. todo, in_progress, done, blocked).' }),
        ),
        assignee: Type.Optional(Type.String({ description: 'Filter by assignee name.' })),
        project: Type.Optional(Type.String({ description: 'Filter by project ID.' })),
        limit: Type.Optional(Type.Number({ description: 'Max number of results.' })),
      }),
      async execute(_toolCallId, params, signal) {
        return runWithProvider(signal, async (backend) => {
          const issues = await backend.listIssues(params);

          return textResult(
            {
              issues: issues.map(({ metadata: _metadata, ...issue }) => issue),
              total: issues.length,
            },
            issues.length ? undefined : 'No issues found.',
          );
        });
      },
    }),

    defineTool({
      name: 'issue_get',
      label: 'Teamwork',
      description:
        'Get detailed information about a specific issue (a work item in the shared project tracker).',
      outputSchema: issueOutputSchema,
      parameters: Type.Object({
        workspaceId: WORKSPACE_ID_PARAM,
        id: Type.String({ description: 'The issue ID.' }),
      }),
      async execute(_toolCallId, params, signal) {
        return runWithProvider(signal, async (backend) => {
          const issue = await backend.getIssue(params.id, params.workspaceId);
          if (!issue) return errorResult(`Issue not found: ${params.id}`);
          const { metadata: _metadata, ...record } = issue;
          return textResult({ issue: record });
        });
      },
    }),

    defineTool({
      name: 'issue_create',
      label: 'Teamwork',
      description:
        'Create a new issue (a work item / ticket) in the shared project tracker. Use this to file work for humans or other agents to pick up.',
      promptSnippet:
        'Create issues / tickets in a shared project tracker for humans or agents to collaborate on.',
      outputSchema: issueOutputSchema,
      parameters: Type.Object({
        workspaceId: WORKSPACE_ID_PARAM,
        title: Type.String({ description: 'Issue title.' }),
        description: Type.Optional(Type.String({ description: 'Issue description.' })),
        priority: Type.Optional(
          Type.String({ description: 'Priority (e.g. low, medium, high, urgent).' }),
        ),
        assignee: Type.Optional(Type.String({ description: 'Assignee name.' })),
        project: Type.Optional(Type.String({ description: 'Project ID to associate with.' })),
      }),
      async execute(_toolCallId, params, signal) {
        return runWithProvider(signal, async (backend) => {
          const issue = await backend.createIssue(params);
          const { metadata: _metadata, ...record } = issue;
          return textResult({ issue: record });
        });
      },
    }),

    defineTool({
      name: 'issue_update',
      label: 'Teamwork',
      description:
        'Update an existing issue in the shared project tracker. Can change title, description, status, priority, or assignee.',
      outputSchema: issueOutputSchema,
      parameters: Type.Object({
        workspaceId: WORKSPACE_ID_PARAM,
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
      async execute(_toolCallId, params, signal) {
        const { id, workspaceId, ...input } = params;
        return runWithProvider(signal, async (backend) => {
          const issue = await backend.updateIssue(id, input, workspaceId);
          if (!issue) return errorResult(`Issue not found: ${id}`);
          const { metadata: _metadata, ...record } = issue;
          return textResult({ issue: record });
        });
      },
    }),

    defineTool({
      name: 'issue_comment',
      label: 'Teamwork',
      description:
        'Add a comment to an issue in the shared project tracker. Use for progress updates, questions, or blockers visible to other collaborators (humans or agents).',
      outputSchema: Type.Union([
        Type.Object({ comment: commentSchema, truncated: Type.Boolean() }),
        errorSchema,
      ]),
      parameters: Type.Object({
        workspaceId: WORKSPACE_ID_PARAM,
        issueId: Type.String({ description: 'The issue ID to comment on.' }),
        content: Type.String({ description: 'Comment content.' }),
        parentId: Type.Optional(
          Type.String({ description: 'Optional parent comment ID for threaded replies.' }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return runWithProvider(signal, async (backend) => {
          const comment = await backend.addComment(
            params.issueId,
            params.content,
            params.parentId,
            params.workspaceId,
          );
          return textResult({ comment });
        });
      },
    }),

    defineTool({
      name: 'project_list',
      label: 'Teamwork',
      description: 'List all projects in a workspace.',
      outputSchema: Type.Union([
        Type.Object({
          projects: Type.Array(projectSchema),
          total: Type.Integer(),
          truncated: Type.Boolean(),
        }),
        errorSchema,
      ]),
      parameters: Type.Object({
        workspaceId: WORKSPACE_ID_PARAM,
      }),
      async execute(_toolCallId, params, signal) {
        return runWithProvider(signal, async (backend) => {
          const projects = await backend.listProjects(params.workspaceId);

          return textResult(
            { projects: projects, total: projects.length },
            projects.length ? undefined : 'No projects found.',
          );
        });
      },
    }),

    defineTool({
      name: 'teamwork_status',
      label: 'Teamwork',
      description:
        'Check the status of the teamwork collaboration provider (daemon status, connected agents, etc.).',
      outputSchema: Type.Union([
        Type.Object({
          provider: Type.String(),
          status: Type.Object({
            running: Type.Optional(Type.Boolean()),
            pid: Type.Optional(Type.Number()),
            status: Type.Optional(Type.String()),
          }),
          truncated: Type.Boolean(),
        }),
        errorSchema,
      ]),
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        return runWithProvider(signal, async (backend) => {
          const s = await backend.status();
          return textResult({
            provider: backend.name,
            status: {
              ...(typeof s.running === 'boolean' ? { running: s.running } : {}),
              ...(typeof s.pid === 'number' ? { pid: s.pid } : {}),
              ...(typeof s.status === 'string' ? { status: s.status } : {}),
            },
          });
        });
      },
    }),
  ];
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

function textResult(value: object, text?: string) {
  const data = boundStructuredContent(value);
  return {
    content: [
      {
        type: 'text' as const,
        text: truncateHead(text ?? JSON.stringify(data, null, 2), {
          maxBytes: 16 * 1024,
          maxLines: 200,
        }).content,
      },
    ],
    details: data,
    structuredContent: data,
    ...('error' in data ? { isError: true } : {}),
  };
}

function providerErrorResult() {
  console.error('[pi-teamwork] provider operation failed');
  return errorResult(
    'Teamwork operation failed. Check provider status and inspect issue state before retrying.',
  );
}

function errorResult(text: string) {
  return textResult({ error: text }, text);
}

function loadConfig(cwd: string, projectTrusted = false): TeamworkConfig {
  try {
    const config = loadPiSettings<Partial<TeamworkConfig>>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
    });
    return Object.keys(config).length > 0 ? (config as TeamworkConfig) : {};
  } catch {
    return {};
  }
}
