# Pi

![Pi packages preview](./preview.png)

Shared TypeScript packages for Pi runtime applications.

This repository contains the open-source runtime contracts, adapters, and
orchestration helpers that are consumed by Pi Agent and related applications.
The packages are intentionally small and composable: host applications provide
HTTP routing, authentication, model runtime setup, deployment configuration, and
product-specific UI.

## Packages

| Category | Package | Purpose |
| --- | --- | --- |
| Core | `@amaster.ai/pi-shared` | Shared runtime types and contracts: settings loader, session/event/artifact types, turn and subagent types. |
| Core | `@amaster.ai/pi-storage` | JSON-file and MySQL/Prisma persistence adapters for sessions, transcripts, events, memory, artifacts, subagents, and scheduled tasks. |
| Extension | `@amaster.ai/pi-attachments` | Attachment normalization, local/remote upload handling, document parsing, and model-readable attachment prompts. |
| Extension | `@amaster.ai/pi-telemetry` | Runtime telemetry with Langfuse and OpenTelemetry exporters. |
| Extension | `@amaster.ai/pi-task-scheduler` | Cron-based scheduled task management with LLM-callable tools. |
| Extension | `@amaster.ai/pi-goal` | Derives a goal from the conversation and keeps the agent working until the condition is met, with iteration/token backstops. |
| Extension | `@amaster.ai/pi-browser-use` | Browser automation wrapping chrome-devtools-mcp with `browser_`-prefixed tools. |
| Extension | `@amaster.ai/pi-web-access` | Web search, URL content extraction, and image search across configurable providers. |
| Extension | `@amaster.ai/pi-computer-use` | Cross-platform computer-use tools for desktop automation. |
| Extension | `@amaster.ai/pi-channels` | Native messaging channels: Feishu, WeCom, and webhooks. |
| Extension | `@amaster.ai/pi-memory` | Persistent curated memory (`MEMORY.md` + `USER.md`) injected into the system prompt as a refreshed prompt snapshot. |
| Extension | `@amaster.ai/pi-security` | Resource-aware security policy engine and tool authorization. |
| Extension | `@amaster.ai/pi-teamwork` | Team collaboration and issue management via Multica. |
| Extension | `@amaster.ai/pi-image-gen` | Image generation via OpenAI gpt-image, Google Nano Banana, Alibaba Qwen-Image, OpenRouter, and custom providers. |
| Extension | `@amaster.ai/pi-video-gen` | AI video generation plus local composition: lossless clip concat and mixed image/video timelines with overlays, TTS, soft or burned subtitles, source audio, BGM, and bundled LGPL/GPL FFmpeg runtimes. |
| Extension | `@amaster.ai/pi-lark` | Lark/Feishu workspace integration through lark-cli, including calendar, docs, drive, sheets, Base, tasks, mail, wiki, and IM skills. |
| Extension | `@amaster.ai/pi-wecom` | WeCom workspace integration through wecom-cli, including contacts, messages, meetings, schedules, todos, docs, and smart sheets. |
| Extension | `@amaster.ai/pi-dingtalk` | DingTalk workspace integration through dws CLI, including calendar, docs, chat, todos, sheets, AI tables, approvals, mail, wiki, and meeting minutes. |

Core packages provide types and persistence used by every host application.
Extension packages each register Pi runtime extensions via their `./extension`
subpath entry point and are loaded on demand.

Every package is ESM-only and published under the `@amaster.ai` npm scope.

## Extension Previews

<table>
  <tr>
    <td><strong>@amaster.ai/pi-attachments</strong><br><img src="./packages/pi-attachments/preview.png" alt="pi-attachments preview" width="260"></td>
    <td><strong>@amaster.ai/pi-telemetry</strong><br><img src="./packages/pi-telemetry/preview.png" alt="pi-telemetry preview" width="260"></td>
    <td><strong>@amaster.ai/pi-task-scheduler</strong><br><img src="./packages/pi-task-scheduler/preview.png" alt="pi-task-scheduler preview" width="260"></td>
  </tr>
  <tr>
    <td><strong>@amaster.ai/pi-browser-use</strong><br><img src="./packages/pi-browser-use/preview.png" alt="pi-browser-use preview" width="260"></td>
    <td><strong>@amaster.ai/pi-computer-use</strong><br><img src="./packages/pi-computer-use/preview.png" alt="pi-computer-use preview" width="260"></td>
    <td><strong>@amaster.ai/pi-channels</strong><br><img src="./packages/pi-channels/preview.png" alt="pi-channels preview" width="260"></td>
  </tr>
  <tr>
    <td><strong>@amaster.ai/pi-memory</strong><br><img src="./packages/pi-memory/preview.png" alt="pi-memory preview" width="260"></td>
    <td><strong>@amaster.ai/pi-security</strong><br><img src="./packages/pi-security/preview.png" alt="pi-security preview" width="260"></td>
    <td><strong>@amaster.ai/pi-teamwork</strong><br><img src="./packages/pi-teamwork/preview.png" alt="pi-teamwork preview" width="260"></td>
  </tr>
  <tr>
    <td><strong>@amaster.ai/pi-image-gen</strong><br><img src="./packages/pi-image-gen/preview.png" alt="pi-image-gen preview" width="260"></td>
    <td><strong>@amaster.ai/pi-web-access</strong><br><img src="./packages/pi-web-access/preview.png" alt="pi-web-access preview" width="260"></td>
    <td><strong>@amaster.ai/pi-memory-mem0</strong><br><img src="./packages/pi-memory-mem0/preview.png" alt="pi-memory-mem0 preview" width="260"></td>
  </tr>
  <tr>
    <td><strong>@amaster.ai/pi-lark</strong><br><img src="./packages/pi-lark/preview.png" alt="pi-lark preview" width="260"></td>
    <td><strong>@amaster.ai/pi-wecom</strong><br><img src="./packages/pi-wecom/preview.png" alt="pi-wecom preview" width="260"></td>
    <td><strong>@amaster.ai/pi-dingtalk</strong><br><img src="./packages/pi-dingtalk/preview.png" alt="pi-dingtalk preview" width="260"></td>
  </tr>
  <tr>
    <td><strong>@amaster.ai/pi-goal</strong><br><img src="./packages/pi-goal/preview.png" alt="pi-goal preview" width="260"></td>
    <td><strong>@amaster.ai/pi-video-gen</strong><br><img src="./packages/pi-video-gen/preview.png" alt="pi-video-gen preview" width="260"></td>
  </tr>
</table>

## Requirements

- Node.js `>=24`
- pnpm `10.18.3`

Use Corepack when possible:

```sh
corepack enable
corepack install -g pnpm@10.18.3
```

## Development

Install dependencies:

```sh
pnpm install
```

Run the full local check:

```sh
pnpm run pr-check
```

Common commands:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @amaster.ai/pi-storage prisma:generate
```

`@amaster.ai/pi-storage` includes a Prisma schema at
`packages/storage/prisma/schema.prisma`. The root `build` and `typecheck`
scripts generate the Prisma client before compiling project references.

## Consuming Packages

Install only the packages your application needs:

```sh
pnpm add @amaster.ai/pi-shared @amaster.ai/pi-storage
```

Most packages expose a root entry point. Some packages also expose focused
subpath entry points:

```ts
import { createRuntimeStorage } from "@amaster.ai/pi-storage";
import { JsonRuntimeStorage } from "@amaster.ai/pi-storage/json";
import { loadPiSettings } from "@amaster.ai/pi-shared/settings";
import { createLangfuseExporter } from "@amaster.ai/pi-telemetry/langfuse";
import { createOtelExporter } from "@amaster.ai/pi-telemetry/otel";
import memoryExtension from "@amaster.ai/pi-memory/extension";
```

Extension packages register themselves through their `./extension` subpath
entry point. Host applications import these and pass them to the Pi runtime
during setup.

See each package README for package-specific examples and public API notes.

## DeepSeek Harness

Compatibility depends on the host, DSH, Pi, and extension versions. Follow the selected host's documentation for installation and current support.

| Host | Loading model |
| --- | --- |
| [pi2dsh](https://github.com/weijiafu14/pi2dsh) | Discovers explicitly installed Pi packages in a DSH profile. |
| [dsh-pi-host](https://github.com/TGYD-helige/dsh-pi) | Loads package names configured in its `extensions` list. |

## License

Apache-2.0
