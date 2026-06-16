# @amaster.ai/pi-teamwork

![pi-teamwork preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-teamwork/preview.png)

Pi extension for team collaboration and project management. Provides LLM-callable tools to interact with issue trackers and project management systems.

## Supported Providers

- **Multica** — CLI-based adapter via [multica](https://github.com/multica-ai/multica)
- **AMaster Employee** — CLI-based adapter via managed `amaster-employee` and optional `amaster-runtime`

## Configuration

### Auto-Install

When the extension starts and `multica` is not found on `$PATH`, it will automatically install the CLI:

- **macOS / Linux**: Homebrew (`brew install multica-ai/tap/multica`) with a fallback to the install script (`curl -fsSL ... | bash`)
- **Windows**: PowerShell install script (`irm ... | iex`)

Set `autoInstall: false` to disable this behavior.

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

### Mode 4 — AMaster Employee managed CLI

For Pi Agent / AMaster Employee integration, configure the provider explicitly. The extension shells out to the stable managed command names; do not point settings at a local `cli/dist/amaster.js` build artifact.

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "amaster",
    "amaster": {
      "apiBase": "https://amaster.example.com"
    }
  }
}
```

Pi Agent may pass a browser-session board credential through `session_start.amasterEmployee.apiKey`. The extension uses it only in memory for child CLI execution and does not save it to settings.

For the AMaster provider, the LUI-facing `workspaceId` parameter maps to an AMaster company id. The adapter passes that value to the AMaster Employee CLI as `-C <companyId>`. `workspace_list` is a discovery/switch helper, not a hard prerequisite for every tool call: when the account has exactly one company, the adapter falls back to that company automatically; when multiple companies are available and no `workspaceId` is provided, the tool fails clearly and asks the caller to pass a canonical id from `workspace_list`. The adapter does not keep a global "active company" state.

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable the extension |
| `provider` | Provider name (`multica` or `amaster`) |
| `multica.binary` | Path to multica binary (default: `multica`) |
| `multica.workspace` | Workspace ID override; leave empty to use multica's default |
| `multica.token` | Headless-login token. Omit when multica is already logged in on the machine |
| `multica.serverUrl` | Self-hosted server API URL. Triggers `multica setup self-host --server-url` on start |
| `multica.appUrl` | Self-hosted server frontend URL. Required when `serverUrl` is a remote address |
| `multica.autoInstall` | Auto-install multica CLI if missing (default: `true`) |
| `amaster.apiBase` | AMaster Employee API base passed to the CLI as `--api-base` |
| `amaster.companyId` | Optional AMaster canonical company id override passed to the CLI as `-C` |
| `amaster.context` / `profile` / `authStore` | Optional CLI context/profile/auth-store overrides |

## Tools

| Tool | Description |
|------|-------------|
| `issue_list` | List issues with optional filters (status, assignee, project, limit) |
| `issue_get` | Get detailed info about a specific issue |
| `issue_create` | Create a new issue |
| `issue_update` | Update an existing issue (title, description, status, priority, assignee) |
| `issue_comment` | Add a comment to an issue |
| `project_list` | List all projects in the workspace |
| `agent_list` | List current AMaster agents (AMaster provider only) |
| `user_directory_list` | List assignable AMaster users or members (AMaster provider only) |
| `teamwork_status` | Check provider/daemon status |

## Commands

- `/teamwork-status` — Show current provider status

## Architecture

```
src/
├── index.ts              # Generic tool layer (provider-agnostic)
├── types.ts              # TeamworkProvider interface + shared types
└── adapters/
    ├── multica.ts        # Multica CLI adapter + initialization
    ├── multica-installer.ts  # Auto-detect & install multica CLI
    └── amaster.ts        # AMaster Employee CLI adapter
```

The extension uses a provider pattern — `index.ts` registers tools that delegate to a `TeamworkProvider` interface. Adding a new provider (Linear, Jira, etc.) only requires implementing the interface and adding a factory branch in `session_start`.
