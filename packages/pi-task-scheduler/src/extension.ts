import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describeToolError } from '@amaster.ai/pi-shared';
import { isProjectTrusted, loadPiSettings, resolveHome } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  PersistentTaskScheduler,
  type ScheduledTask,
  type ScheduledTaskRunner,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskScheduler,
} from './index.js';
import { FileSchedulerLock, JsonScheduledTaskStore } from './stores.js';
import { createSchedulerTools } from './tools.js';

const SETTINGS_KEY = 'pi-scheduler';
const STATUS_KEY = 'pi-scheduler';

export type PiSchedulerExtensionConfig = {
  dataDir?: string;
  store?: ScheduledTaskStore;
  lock?: SchedulerLock;
  scheduler?: TaskScheduler;
};

type ResolvedConfig = {
  dataDir: string;
  store?: ScheduledTaskStore;
  lock?: SchedulerLock;
  scheduler?: TaskScheduler;
};

function resolveConfig(raw?: PiSchedulerExtensionConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    dataDir: raw?.dataDir?.trim() || path.join(resolveHome(), 'data'),
  };
  if (raw?.store) resolved.store = raw.store;
  if (raw?.lock) resolved.lock = raw.lock;
  if (raw?.scheduler) resolved.scheduler = raw.scheduler;
  return resolved;
}

function loadSettings(cwd: string, projectTrusted = false): PiSchedulerExtensionConfig | undefined {
  const config = loadPiSettings<Partial<PiSchedulerExtensionConfig>>(SETTINGS_KEY, {
    cwd,
    projectTrusted,
  });
  return Object.keys(config).length > 0 ? (config as PiSchedulerExtensionConfig) : undefined;
}

function sessionStorageKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export default function taskSchedulerExtension(
  pi: ExtensionAPI,
  injectedConfig?: PiSchedulerExtensionConfig,
): void {
  let scheduler: TaskScheduler | undefined;
  let ownsScheduler = false;

  pi.on('session_start', async (_event, ctx) => {
    const fileConfig = loadSettings(ctx.cwd, isProjectTrusted(ctx));
    const config = resolveConfig({ ...fileConfig, ...injectedConfig });

    try {
      if (config.scheduler) {
        scheduler = config.scheduler;
        ownsScheduler = false;
      } else {
        const sessionId = ctx.sessionManager.getSessionId();
        const storageKey = sessionStorageKey(sessionId);
        const sessionStorePath = path.join(config.dataDir, `tasks-${storageKey}.json`);
        const store = config.store ?? new JsonScheduledTaskStore(sessionStorePath);
        if (!config.store && !existsSync(sessionStorePath)) {
          const legacyStorePath = path.join(config.dataDir, 'tasks.json');
          if (existsSync(legacyStorePath)) {
            const legacyStore = new JsonScheduledTaskStore(legacyStorePath);
            for (const task of await legacyStore.list({ sessionId })) {
              await store.create(task);
            }
          }
        }
        const lock =
          config.lock ??
          new FileSchedulerLock(path.join(config.dataDir, `scheduler-${storageKey}.lock`));

        const runner: ScheduledTaskRunner = async (task) => {
          if (ctx.sessionManager.getSessionId() !== task.sessionId) {
            throw new Error('Scheduled task belongs to a different session.');
          }
          pi.sendUserMessage(task.prompt, { deliverAs: 'followUp' });
        };

        const instance = new PersistentTaskScheduler({
          store,
          lock,
          runner,
          scope: { sessionId },
        });
        await instance.start();
        scheduler = instance;
        ownsScheduler = true;
      }

      ctx.ui.setStatus(STATUS_KEY, scheduler.isActive() ? 'scheduler: active' : 'scheduler: idle');

      // Register LLM-callable tools after scheduler is ready
      const tools = createSchedulerTools(scheduler);
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    } catch (error) {
      const failure = describeToolError('Initialize scheduler', error);
      console.error(`[pi-task-scheduler] ${failure.errorCategory}: ${failure.error}`);
      ctx.ui.notify(failure.error, 'error');
      ctx.ui.setStatus(STATUS_KEY, 'scheduler: unavailable');
    }
  });

  pi.on('session_shutdown', async () => {
    if (ownsScheduler) {
      await scheduler?.stop();
    }
    scheduler = undefined;
    ownsScheduler = false;
  });

  pi.registerCommand('cron', {
    description:
      'Manage scheduled tasks. Subcommands: status, list, get, run, enable, disable, delete.',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['status', 'list', 'get', 'run', 'enable', 'disable', 'delete'];
      const matches = subcommands.filter((s) => s.startsWith(prefix.trim().toLowerCase()));
      return matches.map((s) => ({ label: s, value: s }));
    },
    handler: async (args, ctx) => {
      if (!scheduler) {
        ctx.ui.notify('Task scheduler is not running.', 'warning');
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();
      const scope = { sessionId: ctx.sessionManager.getSessionId() };

      switch (subcommand) {
        case 'status': {
          const status = await scheduler.status();
          ctx.ui.notify(formatStatus(status), 'info');
          break;
        }

        case 'list': {
          const tasks = await scheduler.list(scope);
          ctx.ui.notify(formatTaskList(tasks), 'info');
          break;
        }

        case 'get': {
          if (!rest) {
            ctx.ui.notify('Usage: /cron get <task-id>', 'warning');
            break;
          }
          const task = await scheduler.get(rest, scope);
          if (!task) {
            ctx.ui.notify(`Task not found: ${rest}`, 'error');
            break;
          }
          ctx.ui.notify(formatTaskDetail(task), 'info');
          break;
        }

        case 'run': {
          if (!rest) {
            ctx.ui.notify('Usage: /cron run <task-id>', 'warning');
            break;
          }
          const task = await scheduler.runNow(rest, scope);
          if (!task) {
            ctx.ui.notify(`Task not found: ${rest}`, 'error');
            break;
          }
          ctx.ui.notify(`Triggered: ${task.name ?? task.id}`, 'info');
          break;
        }

        case 'enable': {
          if (!rest) {
            ctx.ui.notify('Usage: /cron enable <task-id>', 'warning');
            break;
          }
          const task = await scheduler.update(rest, { enabled: true }, scope);
          if (!task) {
            ctx.ui.notify(`Task not found: ${rest}`, 'error');
            break;
          }
          ctx.ui.notify(`Enabled: ${task.name ?? task.id}`, 'info');
          break;
        }

        case 'disable': {
          if (!rest) {
            ctx.ui.notify('Usage: /cron disable <task-id>', 'warning');
            break;
          }
          const task = await scheduler.update(rest, { enabled: false }, scope);
          if (!task) {
            ctx.ui.notify(`Task not found: ${rest}`, 'error');
            break;
          }
          ctx.ui.notify(`Disabled: ${task.name ?? task.id}`, 'info');
          break;
        }

        case 'delete': {
          if (!rest) {
            ctx.ui.notify('Usage: /cron delete <task-id>', 'warning');
            break;
          }
          const deleted = await scheduler.delete(rest, scope);
          ctx.ui.notify(
            deleted ? `Deleted: ${rest}` : `Task not found: ${rest}`,
            deleted ? 'info' : 'error',
          );
          break;
        }

        default:
          ctx.ui.notify(
            'Unknown subcommand. Available: status, list, get, run, enable, disable, delete.',
            'warning',
          );
      }
    },
  });
}

function formatStatus(status: Awaited<ReturnType<TaskScheduler['status']>>): string {
  const lines = [
    `Active: ${status.active}`,
    `Tasks: ${status.taskCount}`,
    `Timers: ${status.scheduledTimerCount}`,
    `Crons: ${status.scheduledCronCount}`,
  ];
  if (status.runningTaskIds.length > 0) {
    lines.push(`Running: ${status.runningTaskIds.join(', ')}`);
  }
  return lines.join('\n');
}

function formatTaskList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) {
    return 'No scheduled tasks.';
  }
  return tasks
    .map((t) => {
      const name = t.name ?? t.id.slice(0, 8);
      const status = t.enabled ? (t.lastStatus ?? 'pending') : 'disabled';
      const next = t.nextRunAt ? ` next: ${t.nextRunAt}` : '';
      return `${t.id.slice(0, 8)} ${name} [${t.type}] ${status}${next}`;
    })
    .join('\n');
}

function formatTaskDetail(task: ScheduledTask): string {
  const lines = [
    `ID: ${task.id}`,
    `Name: ${task.name ?? '(unnamed)'}`,
    `Type: ${task.type}`,
    `Schedule: ${task.schedule}`,
    `Enabled: ${task.enabled}`,
    `Status: ${task.lastStatus ?? 'pending'}`,
    `Runs: ${task.runCount}`,
  ];
  if (task.nextRunAt) lines.push(`Next run: ${task.nextRunAt}`);
  if (task.description) lines.push(`Description: ${task.description}`);
  lines.push(`Prompt: ${task.prompt}`);
  return lines.join('\n');
}
