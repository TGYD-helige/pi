# @amaster.ai/pi-storage

Runtime persistence adapters for pi.

This package owns the storage boundary for sessions, transcripts, memory, runtime events, subagent runs, and artifact metadata. It includes local JSON-file adapters for development and desktop use, plus MySQL/Prisma adapters for platform deployments.

## Entry Points

- `@amaster.ai/pi-storage`: stable contracts and the `createRuntimeStorage` factory.
- `@amaster.ai/pi-storage/json`: JSON-file adapter classes.
- `@amaster.ai/pi-storage/db`: DB adapter factory and migration runner.
- `@amaster.ai/pi-storage/internal`: internal helpers used by this monorepo. These are not part of the stable public API.

## Local JSON Storage

```ts
import { createRuntimeStorage } from "@amaster.ai/pi-storage";

const storage = createRuntimeStorage({
  mode: "json",
  agentDir: ".pi",
  eventLimits: {
    runtimeEvents: 1000,
    toolEvents: 1000,
    llmGenerationEvents: 1000,
  },
});
```

## DB Storage

```ts
import { createRuntimeStorage } from "@amaster.ai/pi-storage";
import { runDbMigrations } from "@amaster.ai/pi-storage/db";

await runDbMigrations({
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
});

const storage = createRuntimeStorage({
  mode: "db",
  agentDir: ".pi",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  eventLimits: {
    runtimeEvents: 1000,
    toolEvents: 1000,
    llmGenerationEvents: 1000,
  },
});
```

Session `metadata` is an optional JSON object preserved across saves and reads by both adapters. DB reads ignore missing or malformed metadata.

## Public API Policy

Types and contracts live in `@amaster.ai/pi-shared` and are re-exported from the root storage entry point. Concrete adapters are exposed through explicit subpath entry points so applications can depend on the smallest stable surface they need.
