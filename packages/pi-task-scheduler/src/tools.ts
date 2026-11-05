import { boundStructuredContent, describeToolError } from '@amaster.ai/pi-shared';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskType,
  type TaskScheduler,
} from './index.js';

function textResult(text: string, value: object): AgentToolResult<unknown> {
  const data = boundStructuredContent(value);
  return {
    content: [
      { type: 'text', text: truncateHead(text, { maxBytes: 16 * 1024, maxLines: 200 }).content },
    ],
    details: data,
    structuredContent: data,
    ...('error' in data ? { isError: true } : {}),
  };
}

function errorResult(text: string): AgentToolResult<unknown> {
  return textResult(text, { error: text });
}

const taskSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    truncated: Type.Optional(Type.Literal(false)),
    name: Type.Optional(Type.String()),
    type: Type.String(),
    schedule: Type.String(),
    enabled: Type.Boolean(),
    prompt: Type.String(),
    runCount: Type.Number(),
    lastStatus: Type.Optional(Type.String()),
    nextRunAt: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    intervalSeconds: Type.Optional(Type.Number()),
    description: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.String()),
    lastRunAt: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    model: Type.Optional(Type.Object({ provider: Type.String(), model: Type.String() })),
    toolPolicyProfile: Type.Optional(Type.String()),
    tenantId: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    workspaceId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    runHistory: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          status: Type.String(),
          createdAt: Type.String(),
          sessionId: Type.Optional(Type.String()),
        }),
      ),
    ),
  }),
  Type.Object({ id: Type.String(), truncated: Type.Literal(true) }),
]);
const errorSchema = Type.Object({
  error: Type.String(),
  errorCategory: Type.Optional(Type.String()),
  httpStatus: Type.Optional(Type.Integer()),
  truncated: Type.Boolean(),
});
const taskOutputSchema = Type.Union([
  Type.Object({ task: taskSchema, truncated: Type.Boolean() }),
  errorSchema,
]);
const listOutputSchema = Type.Union([
  Type.Object({ tasks: Type.Array(taskSchema), total: Type.Integer(), truncated: Type.Boolean() }),
  errorSchema,
]);
const deleteOutputSchema = Type.Union([
  Type.Object({ taskId: Type.String(), deleted: Type.Boolean(), truncated: Type.Boolean() }),
  errorSchema,
]);

function formatTaskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    schedule: task.schedule,
    enabled: task.enabled,
    lastStatus: task.lastStatus ?? 'pending',
    nextRunAt: task.nextRunAt,
    runCount: task.runCount,
    prompt: task.prompt.length > 100 ? `${task.prompt.slice(0, 100)}…` : task.prompt,
  };
}

function sessionScope(ctx: ExtensionContext) {
  return { sessionId: ctx.sessionManager.getSessionId() };
}

const taskTypeSchema = Type.Union([
  Type.Literal('cron'),
  Type.Literal('once'),
  Type.Literal('interval'),
]);

export function createSchedulerTools(scheduler: TaskScheduler): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'scheduler_create',
      label: 'Scheduler',
      description:
        'Schedule a prompt to be executed automatically at a future time or on a recurring basis. Supports cron expressions, one-time (ISO timestamp or relative like "+10m"), and interval (e.g. "30s", "5m", "1h"). Use this when the user wants something to run later, repeatedly, or on a timer.',
      promptSnippet:
        'Schedule prompts to run automatically via cron, one-time delay, or fixed interval.',
      outputSchema: taskOutputSchema,
      parameters: Type.Object({
        type: taskTypeSchema,
        schedule: Type.String({
          description:
            'Schedule expression. Cron: "0 9 * * 1-5"; Once: ISO timestamp or "+10m"; Interval: "30s", "5m", "1h".',
        }),
        prompt: Type.String({ description: 'The prompt to execute when triggered.' }),
        name: Type.Optional(
          Type.String({ description: 'Human-readable name for this scheduled prompt.' }),
        ),
        description: Type.Optional(
          Type.String({ description: 'Description of this scheduled prompt.' }),
        ),
        enabled: Type.Optional(
          Type.Boolean({ description: 'Whether this scheduled prompt is enabled. Default true.' }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            description: 'Maximum execution time in milliseconds. Defaults to 30 minutes.',
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback | undefined,
        ctx: ExtensionContext,
      ): Promise<AgentToolResult<unknown>> {
        let definition: ReturnType<typeof resolveScheduledTaskDefinition>;
        try {
          definition = resolveScheduledTaskDefinition({
            type: params.type as ScheduledTaskType,
            schedule: params.schedule as string,
          });
        } catch {
          return errorResult(
            'Invalid schedule. Use a valid cron, ISO timestamp, relative delay or interval.',
          );
        }
        const input: ScheduledTaskCreateInput = {
          ...definition,
          prompt: params.prompt as string,
          sessionId: ctx.sessionManager?.getSessionId?.() ?? 'unknown',
          model: {
            provider: ctx.model?.provider ?? 'anthropic',
            model: ctx.model?.id ?? 'unknown',
          },
          toolPolicyProfile: 'workspace-write',
          enabled: params.enabled !== false,
          ...(params.name ? { name: params.name as string } : {}),
          ...(params.description ? { description: params.description as string } : {}),
          ...(typeof params.timeoutMs === 'number'
            ? { timeoutMs: params.timeoutMs as number }
            : {}),
        };
        const task = await scheduler.create(input);
        return textResult(JSON.stringify(formatTaskSummary(task), null, 2), {
          task: { ...formatTaskSummary(task), prompt: task.prompt },
        });
      },
    },
    {
      name: 'scheduler_list',
      label: 'Scheduler',
      description: 'List all scheduled prompts with their status and next run time.',
      promptSnippet: 'List all scheduled prompts.',
      outputSchema: listOutputSchema,
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
        const tasks = await scheduler.list(sessionScope(ctx));
        if (tasks.length === 0) {
          return textResult('No scheduled tasks.', { tasks: [], total: 0 });
        }
        const summary = tasks.map(formatTaskSummary);
        return textResult(JSON.stringify(summary, null, 2), {
          tasks: tasks.map((task) => ({ ...formatTaskSummary(task), prompt: task.prompt })),
          total: tasks.length,
        });
      },
    },
    {
      name: 'scheduler_get',
      label: 'Scheduler',
      description:
        'Get detailed information about a scheduled prompt, including its schedule and run history.',
      outputSchema: taskOutputSchema,
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to query.' }),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<unknown>> {
        const task = await scheduler.get(params.taskId as string, sessionScope(ctx));
        if (!task) {
          return errorResult(`Task not found: ${params.taskId}`);
        }
        const { lastError: _lastError, runHistory, ...safeTask } = task;
        const record = {
          ...safeTask,
          ...(runHistory
            ? { runHistory: runHistory.map(({ message: _message, ...entry }) => entry) }
            : {}),
        };
        return textResult(JSON.stringify(record, null, 2), { task: record });
      },
    },
    {
      name: 'scheduler_update',
      label: 'Scheduler',
      description:
        'Update a scheduled prompt. Can change schedule, prompt text, name, or enable/disable.',
      outputSchema: taskOutputSchema,
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to update.' }),
        type: Type.Optional(taskTypeSchema),
        schedule: Type.Optional(Type.String({ description: 'New schedule expression.' })),
        prompt: Type.Optional(Type.String({ description: 'New prompt.' })),
        name: Type.Optional(Type.String({ description: 'New name.' })),
        description: Type.Optional(Type.String({ description: 'New description.' })),
        enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable.' })),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<unknown>> {
        const { taskId, type, schedule, prompt, name, description, enabled } = params as {
          taskId: string;
          type?: string;
          schedule?: string;
          prompt?: string;
          name?: string;
          description?: string;
          enabled?: boolean;
        };
        const update: Record<string, unknown> = {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        };
        if (type !== undefined || schedule !== undefined) {
          const existing = await scheduler.get(taskId, sessionScope(ctx));
          if (!existing) return errorResult(`Task not found: ${taskId}`);
          try {
            const definition = resolveScheduledTaskDefinition({
              type: (type ?? existing.type) as ScheduledTaskType,
              schedule: schedule ?? existing.schedule,
            });
            Object.assign(update, definition);
          } catch {
            return errorResult(
              'Invalid schedule. Use a valid cron, ISO timestamp, relative delay or interval.',
            );
          }
        }
        const task = await scheduler.update(taskId, update, sessionScope(ctx));
        if (!task) {
          return errorResult(`Task not found: ${taskId}`);
        }
        return textResult(JSON.stringify(formatTaskSummary(task), null, 2), {
          task: { ...formatTaskSummary(task), prompt: task.prompt },
        });
      },
    },
    {
      name: 'scheduler_delete',
      label: 'Scheduler',
      description: 'Delete a scheduled prompt.',
      outputSchema: deleteOutputSchema,
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to delete.' }),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<unknown>> {
        const taskId = params.taskId as string;
        const deleted = await scheduler.delete(taskId, sessionScope(ctx));
        return deleted
          ? textResult(`Deleted task: ${taskId}`, { taskId, deleted: true })
          : errorResult(`Task not found: ${taskId}`);
      },
    },
    {
      name: 'scheduler_run_now',
      label: 'Scheduler',
      description: 'Trigger immediate execution of a scheduled prompt, ignoring its schedule.',
      outputSchema: taskOutputSchema,
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to run immediately.' }),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<unknown>> {
        const taskId = params.taskId as string;
        const task = await scheduler.runNow(taskId, sessionScope(ctx));
        if (!task) {
          return errorResult(`Task not found: ${taskId}`);
        }
        return textResult(`Triggered: ${task.name ?? task.id}`, {
          task: { ...formatTaskSummary(task), prompt: task.prompt },
        });
      },
    },
  ];
  return tools.map((tool) => ({
    ...tool,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      try {
        return await tool.execute(...args);
      } catch (error) {
        if (args[2]?.aborted) throw error;
        const failure = describeToolError(
          tool.name,
          error,
          'The operation may have completed. Inspect task state before retrying.',
        );
        console.error(
          `[pi-task-scheduler] ${tool.name} failed (category=${failure.errorCategory})`,
        );
        return textResult(failure.error, failure);
      }
    },
  }));
}
