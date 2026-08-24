# Pi Security

![pi-security preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-security/preview.png)

`@amaster.ai/pi-security` provides a sandbox-aware security policy engine and a Pi extension entry point.

The core engine classifies tool calls into resources (files, shell commands, network access), assesses risk, and applies profile rules to decide whether a call is allowed, denied, or requires human approval. Profiles are built from two orthogonal axes — **sandbox** (what tools are exposed) and **approval** (when to ask the user) — inspired by Codex.

## Pi extension

Install the extension entry point `@amaster.ai/pi-security/extension` and load the `pi-security` settings key through Pi `SettingsManager`:

```json
{
  "pi-security": {
    "enabled": true,
    "profile": "default",
    "approvals": {
      "allowSessionGrants": true
    }
  }
}
```

The extension listens to Pi `tool_call` and `user_bash` events. It does not register an LLM-callable tool that can bypass policy. Human approvals are requested through Pi UI primitives when UI is available; non-interactive contexts fail closed when a rule requires approval.

## Built-in profiles

Profiles are derived from a `sandbox` × `approval` matrix. Pick one as a starting point and override either axis in your own profiles.

| Profile        | Sandbox            | Approval     | Use case                                                |
|----------------|--------------------|--------------|---------------------------------------------------------|
| `read-only`    | `read-only`        | `never`      | Read-only inspection, no modifications                  |
| `default`      | `workspace-write`  | `on-request` | Workspace edits with approval for writes (recommended)  |
| `auto`         | `workspace-write`  | `on-failure` | Autonomous edits, only ask when risk is high            |
| `full-access`  | `full-access`      | `never`      | Trusted automation, no gating (use with care)           |

### Sandbox modes

| Mode               | Allowed tools                                  | Denied tools          |
|--------------------|------------------------------------------------|-----------------------|
| `read-only`        | `read`, `ls`, `find`, `grep`                   | `write`, `edit`, `bash` |
| `workspace-write`  | `read`, `ls`, `find`, `grep`, `write`, `edit`, `bash` | —                     |
| `full-access`      | `*` (all tools)                                | —                     |

Tool names align with the pi-coding-agent built-in tools: `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`.

### Approval modes

| Mode          | Behavior                                                                  |
|---------------|---------------------------------------------------------------------------|
| `never`       | No approval prompts (deny rules still apply, e.g. for secrets).           |
| `on-failure`  | Ask only on high/critical risk operations.                                |
| `on-request`  | Ask on workspace writes/deletes (in addition to high-risk ops).           |
| `untrusted`   | Ask on workspace writes plus high-risk ops; default decision is also ask. |

Baseline secret protection (denying `.ssh/`, `.env`, `*.pem`, `*.key`, etc.) is always enabled, regardless of profile.

## Custom profiles

Profiles can be defined in three places. Higher-priority sources override lower-priority ones with the same name:

1. **Trusted project**: `<cwd>/.pi/policy/<name>.json` (highest priority when project trust is accepted)
2. **Agent**: `<agentDir>/policy/<name>.json`
3. **User**: `~/.pi/agent/policy/<name>.json`
4. **Settings**: under `pi-security.security.profiles` in `pi.json`

Each JSON file defines a single profile; the filename (without `.json`) is the profile name. Project policies are ignored when project trust is declined or unavailable.

### JSON config examples

Ready-to-copy samples live under [`examples/`](./examples) and are exercised by the test suite:

- [`examples/reviewer.json`](./examples/reviewer.json) — a project-level file policy. For a trusted project, drop it into `<project>/.pi/policy/reviewer.json`. Starts from `read-only`, opens to `workspace-write`, asks on `bash`, denies external network.
- [`examples/auto-review.settings.json`](./examples/auto-review.settings.json) — a `pi.json` snippet that defines a custom `auto-review` profile inline. Extends `default` and asks before package-manager installs (`npm/pnpm/yarn/pip install|add`) via `argsRegex`.

### Profile schema

```ts
type SecurityProfileConfig = {
  extends?: string;                   // built-in profile name or another custom profile
  sandbox?: 'read-only' | 'workspace-write' | 'full-access';
  approval?: 'never' | 'on-failure' | 'on-request' | 'untrusted';
  rules?: SecurityRule[];             // appended after parent rules
  defaultDecision?: SecurityDecision; // overrides parent default for unmatched tools
};
```

### Rule schema

Rules are evaluated in priority order (descending); the first match wins.

```ts
type SecurityRule = {
  id: string;
  priority?: number;                  // default 300 for user rules
  tools?: string[];                   // tool name patterns ('*', 'mcp_*', 'bash')
  sources?: ToolSource[];             // 'builtin' | 'mcp' | 'runtime'
  triggers?: Array<'user' | 'agent' | 'scheduler'>;
  senderTrusts?: Array<'owner' | 'trusted' | 'untrusted'>;
  args?: Record<string, string>;      // exact/glob match against args
  argsRegex?: Record<string, string>; // regex match against args
  resources?: ('file' | 'shell' | 'network')[];
  operations?: ('read' | 'write' | 'execute' | 'delete' | 'connect' | 'search')[];
  scopes?: ('workspace' | 'home' | 'system' | 'external' | 'unknown')[];
  sensitivity?: ('normal' | 'source' | 'config' | 'secret' | 'credential')[];
  risk?: ('low' | 'medium' | 'high' | 'critical')[];
  decision: { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason: string; prompt?: string };
};
```

## Commands

- `/pi-security-status` shows the active profile, audit count, and in-session grants.
- `/pi-security-audit [limit]` shows recent authorization decisions without raw sensitive output.
- `/pi-security-reset` clears in-session approval grants.

## Trust model

This module is an execution gate, not a filesystem sandbox by itself. Deny and approval decisions are enforceable because they run before Pi tool execution; sandbox enforcement still depends on the runtime that executes the tool.

Sensitive paths such as SSH keys, `.env`, credentials, tokens, private keys, and `secrets/` directories are denied by baseline policy across all profiles. Audit entries include tool names, resource summaries, risk level, and decision metadata, but they should not include plaintext secrets.
