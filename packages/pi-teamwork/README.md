# @amaster.ai/pi-teamwork

![pi-teamwork preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-teamwork/preview.png)

Pi extension for team collaboration and project management. Provides LLM-callable tools to interact with issue trackers and project management systems.

## Supported Providers

- **Multica** — CLI-based adapter via [multica](https://github.com/multica-ai/multica)

## Configuration

### Auto-Install

Runtime auto-installation is disabled because mutable package-manager taps and download scripts cannot provide the pinned artifact verification required in a credential-bearing agent process. Install a pinned Multica release separately and put the verified binary on `$PATH`, or configure `multica.binary`.

The deprecated `autoInstall: true` setting no longer executes an installer. It only reports a clear error when the binary is missing.

Configuration may live in user/agent settings or in a trusted project's `.pi/settings.json`. Project settings are ignored when trust is declined and do not expand `${ENV_VAR}`; keep environment-backed credentials in user or agent settings.

### Mode 1 — Self-hosted server

For teams running their own Multica server. The extension runs `multica setup self-host` with the provided URLs, then authenticates with the token:

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "multica",
    "multica": {
      "serverUrl": "https://api.your-server.com",
      "appUrl": "https://your-server.com",
      "token": "<token-from-multica-server>"
    }
  }
}
```

### Mode 2 — Pre-configured environment

Run `multica setup` once on the machine and finish login through multica's normal flow. The extension will reuse that state:

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "multica",
    "multica": {
      "workspace": ""
    }
  }
}
```

### Mode 3 — Headless token (Multica Cloud)

For CI or non-interactive environments where you can't run `multica setup`. The extension will run `multica login --token <token>` on every `session_start`:

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "multica",
    "multica": {
      "token": "<token-from-multica-server>"
    }
  }
}
```

> ⚠️ `token` is a credential. Keep it out of version control — put it in a local-only settings file or inject via env-substituted config.

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable the extension |
| `provider` | Provider name (`multica`) |
| `multica.binary` | Path to multica binary (default: `multica`) |
| `multica.workspace` | Workspace ID override; leave empty to use multica's default |
| `multica.token` | Headless-login token. Omit when multica is already logged in on the machine |
| `multica.serverUrl` | Self-hosted server API URL. Triggers `multica setup self-host --server-url` on start |
| `multica.appUrl` | Self-hosted server frontend URL. Required when `serverUrl` is a remote address |
| `multica.autoInstall` | Deprecated compatibility flag; no installer is executed (default: `false`) |

## Tools

| Tool | Description |
|------|-------------|
| `issue_list` | List issues with optional filters (status, assignee, project, limit) |
| `issue_get` | Get detailed info about a specific issue |
| `issue_create` | Create a new issue |
| `issue_update` | Update an existing issue (title, description, status, priority, assignee) |
| `issue_comment` | Add a comment to an issue |
| `project_list` | List all projects in the workspace |
| `teamwork_status` | Check provider/daemon status |

## Commands

- `/teamwork-status` — Show current provider status

## Architecture

```
src/
├── index.ts              # Generic tool layer (provider-agnostic)
├── types.ts              # TeamworkProvider interface + shared types
└── adapters/
    └── multica.ts        # Multica CLI adapter + initialization
```

The extension uses a provider pattern — `index.ts` registers tools that delegate to a `TeamworkProvider` interface. Adding a new provider (Linear, Jira, etc.) only requires implementing the interface and adding a factory branch in `session_start`.

## Structured results (Pi 0.99+)

Teamwork tools declare `outputSchema`: workspace_list/issue_list/project_list return `{ workspaces | issues | projects, total, truncated }`; issue_get/create/update return `{ issue, truncated }`; issue_comment returns `{ comment, truncated }`. Issue objects retain their existing IDs/statuses and public fields; arbitrary provider metadata is excluded. teamwork_status exposes the provider and available running/pid/status fields, excluding raw CLI output. Failures return `{ error, truncated }` with `isError: true`, without CLI diagnostics or credentials. Tracker writes still require user authorization.

```javascript
const result = await tools.issue_list({ status: "todo" });
if (result.error) throw new Error(result.error);
text(result.issues.map(issue => ({ id: issue.id, title: issue.title, status: issue.status })));
// Once the user has authorized this issue's status update:
// await tools.issue_update({ id: result.issues[0].id, status: "in_progress" });
```

Structured output is limited to 12 KiB and top-level lists to 100 complete records. `truncated: true` indicates omitted records; `total` retains the original count where available. Oversized records with an `id` retain that complete ID and small scalar metadata, omit large fields, and carry `truncated: true` both on the record and envelope; callers must check that flag before reusing content for an update. Oversized results without a record ID return a typed output-limit error instead of clipped paths or content. A write may already have completed when that happens: inspect saved state before retrying. Readable text and renderer details are independently bounded.

Multica initialization runs in the background with one 10-second budget across CLI checks, setup, daemon startup, and login. Ordinary prompts do not wait for it; teamwork tools wait for initialization. Each later tool or status-command invocation has one 30-second deadline covering initialization waits and all CLI steps. Caller cancellation reaches the running CLI and prevents subsequent commands (including the remaining update/get steps); session shutdown cancels outstanding CLI work.
