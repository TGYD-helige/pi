# @amaster.ai/pi-task-scheduler

![pi-task-scheduler preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-task-scheduler/preview.png)

Scheduled task domain types, execution scheduler, and pi agent extension.

The package owns schedule parsing, task lifecycle state, process-local timers, runner callbacks, scheduler hooks, and LLM-callable tools for autonomous task management.

## Storage

The package ships with a built-in file-based storage (default, zero external dependencies):

- `JsonScheduledTaskStore` — persists tasks to a JSON file with atomic writes
- `FileSchedulerLock` — PID-based file lock for single-owner execution

For database-backed storage (multi-tenant, Prisma), use `@amaster.ai/pi-storage/scheduler` which implements the same interfaces with `DbScheduledTaskStore` and `RedisSchedulerLock`.

### Default (file storage)

```ts
import {
  PersistentTaskScheduler,
  JsonScheduledTaskStore,
  FileSchedulerLock,
} from "@amaster.ai/pi-task-scheduler";

const scheduler = new PersistentTaskScheduler({
  store: new JsonScheduledTaskStore("/var/lib/pi/tasks.json"),
  lock: new FileSchedulerLock("/var/lib/pi/tasks.lock"),
  runner: async (task, run) => {
    await runPrompt(task.prompt, { sessionId: run.sessionId });
  },
});

await scheduler.start();
```

### Custom storage

Implement `ScheduledTaskStore` and `SchedulerLock` interfaces for any backend (database, Redis, etc.):

```ts
import { PersistentTaskScheduler } from "@amaster.ai/pi-task-scheduler";

const scheduler = new PersistentTaskScheduler({
  store: myCustomStore,   // implements ScheduledTaskStore
  lock: myCustomLock,     // implements SchedulerLock
  runner: async (task, run) => {
    await runPrompt(task.prompt, { sessionId: run.sessionId });
  },
});

await scheduler.start();
```

## Integration Modes

The package provides two integration paths depending on who controls the scheduler lifecycle.

### Mode 1: Extension auto-discovery (standalone / CLI)

When installed as an npm dependency with the `pi.extensions` field in `package.json`, the runtime auto-discovers and loads the extension. The extension creates its own `PersistentTaskScheduler` with file-based storage (`JsonScheduledTaskStore` + `FileSchedulerLock`) — fully self-contained, no external infrastructure needed.

```
pi.extensions → session_start → creates file-based scheduler → registers tools + commands
```

- **Storage**: per-session `tasks-<session-hash>.json` and `scheduler-<session-hash>.lock`
  files under `<agentDir>/data` (base directory configurable via `dataDir`)
- **Upgrade**: matching tasks from the legacy `tasks.json` are copied on first use; the
  legacy file is retained
- **Lifecycle**: scheduler starts on `session_start`, stops on `session_shutdown`
- **Commands**: `/pi-scheduler-status`, `/pi-scheduler-list`, `/pi-scheduler-run-now`
- **LLM Tools**: `scheduler_create`, `scheduler_list`, `scheduler_get`, `scheduler_update`, `scheduler_delete`, `scheduler_run_now`

Configuration via settings key `pi-scheduler`:

Project `.pi/settings.json` values are loaded only after project trust is accepted and are not environment-interpolated. User and agent settings retain environment interpolation.

```json
{
  "pi-scheduler": {
    "dataDir": "/custom/path"
  }
}
```

### Mode 2: Dependency import (host-controlled)

When the host process owns the scheduler instance (e.g. backed by a database), it bypasses the extension and registers tools directly using `createSchedulerTools`:

```ts
import { createSchedulerTools } from "@amaster.ai/pi-task-scheduler/tools";
import { PersistentTaskScheduler } from "@amaster.ai/pi-task-scheduler";

const scheduler = new PersistentTaskScheduler({
  store: myStore,
  lock: myLock,
  runner,
});
await scheduler.start();

// Returns ToolDefinition[] — register via your tool injection mechanism
const tools = createSchedulerTools(scheduler);
```

In this mode the auto-discovered extension should be filtered out to prevent double tool registration. The host manages scheduler start/stop independently.

```
host creates scheduler → createSchedulerTools(scheduler) → tools injected into runtime
                       → extension filtered from auto-discovery
```

### Choosing a mode

| | Extension (Mode 1) | Dependency (Mode 2) |
|---|---|---|
| Storage | File-based (JSON) | Host-controlled |
| Scheduler lifecycle | Extension manages | Host manages |
| Tool registration | Extension registers | Host registers |
| Multi-tenant | No | Yes |
| Use case | CLI / standalone agent | Server / custom host |

## Scheduling

Tasks support three schedule types:

- `interval`: duration strings such as `30s`, `10m`, `1h`, or `1d`
- `once`: ISO timestamps or relative values such as `+5m`
- `cron`: 5/6-field cron expressions and a small RRULE subset

The scheduler does not catch up missed runs after process downtime. When it starts, it registers future timers for enabled tasks.

## Hooks

Hooks are best-effort observability callbacks. If a hook throws, the scheduler swallows the error and keeps task state authoritative.
