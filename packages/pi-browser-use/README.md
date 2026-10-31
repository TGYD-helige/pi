# @amaster.ai/pi-browser-use

![pi-browser-use preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-browser-use/preview.png)

pi-coding-agent extension that wraps [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp), exposing all browser automation tools with a unified `browser_` prefix.

## Features

- **pi-coding-agent extension** — registers tools via `pi.registerTool()`, managed by the agent lifecycle
- **Dynamic tool discovery** — automatically proxies all upstream chrome-devtools-mcp tools with `browser_` prefix
- **Reproducible MCP runtime** — launches the installed chrome-devtools-mcp entrypoint with the current Node executable instead of downloading `@latest` through ambient `npx`
- **Page-scoped routing** — routes page tools by explicit `pageId` instead of shared selected-page state
- **Connection recovery** — detects closed or unhealthy MCP transports and reconnects before the next call
- **Optional live sessions** — retain the original browser across Pi processes only when requested, with bounded expiry and configurable cloud lifecycle adapters
- **Navigation safety** — supports URL allow/block patterns and redacts sensitive network headers by default
- **Tool description augmentation** — adds usage hints for key tools (click, fill, press_key, etc.)
- **Result post-processing** — strips embedded snapshots, detects overlay/stale element issues
- **Optional visual analysis** — `browser_analyze_screenshot` via configurable vision model
- **Standalone mode** — also runnable as an independent MCP server via CLI

## Install

```bash
bun add @amaster.ai/pi-browser-use
```

Requires Node.js `^20.19.0 || ^22.12.0 || >=23`, Chrome (stable or newer), and `@earendil-works/pi-coding-agent >= 0.74.0`.

`chrome-devtools-mcp` uses the compatible `^1.6.0` range and its installed entrypoint is resolved when the extension connects. A missing or malformed installation fails connection; the extension does not download a replacement at connection time. Connection failures expose only allowlisted system error codes or Chrome startup categories, not raw subprocess stderr.

Hosts where `process.execPath` is not a directly executable Node runtime can set `PI_BROWSER_USE_NODE` to the Node command used for the MCP subprocess.

The MCP subprocess receives an allowlisted subset of the extension's environment rather than the MCP SDK's minimal default, so a headful Chrome can attach to the active Linux graphical session (`DISPLAY`, `XAUTHORITY`, ...) and honors settings carried by environment, such as proxy variables. Secrets and unrelated variables are not passed; extend the subset with `envAllowlist` or remove entries with `envBlocklist`, which takes precedence over both the default list and `envAllowlist`.

## Usage

### As pi-coding-agent Extension (Recommended)

Install the package and pi-coding-agent will automatically discover and load the extension. All browser tools are registered on `session_start`.

```bash
bun add @amaster.ai/pi-browser-use
```

Configure via `.pi/settings.json` (project-level) or `~/.pi/agent/settings.json` (user-level) under the `"pi-browser-use"` key:

Project settings are loaded only after project trust is accepted. `${ENV_VAR}` interpolation is supported in user and agent settings, but not in project settings.

```json
{
  "pi-browser-use": {
    "headless": true,
    "channel": "stable",
    "viewport": "1280x720",
    "experimentalVision": true,
    "blockedUrlPattern": ["https://ads.example/*"]
  }
}
```

### As Standalone MCP Server (CLI)

```bash
npx @amaster.ai/pi-browser-use --headless --viewport=1280x720
```

Or with a config file:

```bash
npx @amaster.ai/pi-browser-use --config path/to/config.json
```

Standalone `--config` supports `${ENV_VAR}` references in `wsEndpoint`, `browserUrl`, `wsHeaders` values, enabled `session.provider.apiKey`, and enabled `session.backend` request URLs/header values (`create`, `status`, `retain`, `release`). For example, use `"Authorization": "Bearer ${BROWSER_API_KEY}"` rather than storing the key in JSON. Missing or empty referenced variables stop startup with `BrowserAuthEnvironmentError`; resolved headers are validated to reject newline injection. URL substitutions are literal, so supply a valid, appropriately URL-encoded value. Request bodies, session keys, file paths, executable arguments, bare `$ENV_VAR`, and other settings remain literal. Disabled lifecycle credentials are not resolved. Header JSON spelling and formatting are preserved when no value changes, keeping existing session configuration hashes compatible. Global/agent-dir extension settings retain their existing interpolation rules; project settings never gain environment access. Startup logs report safe error classes/system codes without printing config contents, credentials, or raw exceptions.

The extension and standalone MCP CLI share the same result processing: aggregate text is bounded below 50 KiB / 2,000 lines with a truncation notice, and structured content uses the shared 12 KiB limiter. Screenshot image blocks and tool error status are preserved.

## Configuration

### Session Mode

| Mode | Description |
|------|-------------|
| `persistent` (default) | Reuses a shared browser profile at `~/.pi/browser-profile`. Cookies, logins, and extensions persist across sessions. |
| `isolated` | Launches a fresh ephemeral browser profile each session. No state carried over. |
| `existing` | Connects to an already-running browser instance (via `browserUrl`, `wsEndpoint`, or auto-discovery). |

> **Note:** Do not run the agent (or anything that launches this browser) via `sudo` — the profile would be created with root-owned files, and Chrome then shows a "can't read your preferences" dialog on every launch. On startup the extension detects an inaccessible default profile, moves it aside to `~/.pi/browser-profile.inaccessible-<timestamp>`, and starts fresh; a custom `userDataDir` in this state fails fast with an ownership remediation hint instead.

```json
{
  "pi-browser-use": {
    "sessionMode": "persistent"
  }
}
```

### Browser

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `headless` | `boolean` | `false` | Run browser in headless mode |
| `channel` | `string` | — | Chrome channel: `canary`, `dev`, `beta`, `stable` |
| `browserUrl` | `string` | — | Connect to existing browser via URL |
| `wsEndpoint` | `string` | — | Connect via WebSocket endpoint |
| `executablePath` | `string` | — | Path to Chrome executable |
| `viewport` | `string` | — | Viewport size, e.g. `1280x720` |
| `isolated` | `boolean` | `false` | Use isolated browser profile |
| `userDataDir` | `string` | — | Custom user data directory |
| `autoConnect` | `boolean` | `false` | Auto-connect to running browser |
| `acceptInsecureCerts` | `boolean` | `false` | Ignore invalid or self-signed certificate errors; use with caution |
| `envAllowlist` | `string[]` | — | Extra env var names the MCP subprocess may inherit, on top of the built-in allowlist (`PATH`, `HOME`, `DISPLAY`, `XAUTHORITY`, proxy variables, ...). Everything else is stripped, so secrets in the host environment stay out of the subprocess |
| `envBlocklist` | `string[]` | — | Env var names the MCP subprocess must never receive; wins over the built-in allowlist and `envAllowlist` |

### Live Browser Sessions (Opt-in)

Live sessions are disabled by default. Leave them disabled when attaching to your own running Chrome: Pi can disconnect while you keep Chrome open. Authentication/profile reuse is independent of live-session retention.

To enable cross-process human handoffs, configure **user or agent settings**, not project settings:

```json
{
  "pi-browser-use": {
    "sessionMode": "existing",
    "wsEndpoint": "${BROWSER_CDP_URL}",
    "session": {
      "enabled": true,
      "key": "${BROWSER_CONVERSATION_ID}",
      "retentionMs": 120000
    }
  }
}
```

`key` must identify one logical conversation across Pi processes. The host must supply a different value for unrelated conversations; do not share a constant key across agents or projects. One client owns a session at a time. Keep the resolved configuration unchanged when resuming. For a plugin-launched headless browser, omit `wsEndpoint` and use the usual local launch settings instead.

| Setting | Default | Meaning |
|---------|---------|---------|
| `session.enabled` | `false` | Enables the independent session process and session tool/command; `false` keeps direct connections and hides the controls |
| `session.key` | Required when enabled | Stable host-supplied logical conversation identifier |
| `session.retentionMs` | Required when enabled | Maximum handoff window, 1–86400000 ms; does **not** enable ordinary idle retention |
| `session.provider` | — | Built-in `browserbase`, `browser-use`, `steel`, or `browserless` cloud lifecycle adapter |
| `session.backend` | — | Optional HTTP lifecycle adapter for a created or explicitly delegated existing cloud instance |
| `session.adapterModule` | — | Optional absolute path to a trusted custom adapter module; mutually exclusive with `backend` and `provider` |

The enabled tool is `browser_session({"action":"retain" | "status" | "release"})`; users can invoke `/browser-session retain`, `/browser-session status`, and `/browser-session release`. SDK hosts can call `DevToolsClient.sessionControl(action, signal)` directly, including from an application-defined automatic handoff policy. The model never needs to send periodic renewals.

Disabling sessions on a later Pi session removes the tool from the model's available tools. Pi has no command-unregister API, so a previously registered slash command may remain listed until restart; invoking it while disabled returns a configuration error.

1. Use the browser normally. No cloud instance is created merely by discovering tools.
2. Before waiting for a QR scan, MFA, or another operation needing the original page, call `retain` and check success. A separate process keeps the same MCP/CDP connection alive after Pi exits. This works with local headless Chrome, open-source Browserless, and CDP gateways that reclaim Chrome after disconnect, without requiring a commercial reconnect API.
3. A later Pi process with the same key reconnects to that process. Re-list pages before continuing; do not navigate or refresh the pending login page. Verify the website's actual login result.
4. Call `release` after completion or cancellation. This cancels cross-process retention; the current client may continue using the browser. Once the client disconnects, local resources are cleaned up and an adapter-owned cloud browser is released. A browser reached through a plain external CDP address is only disconnected, never forcibly terminated.

`retentionMs` is an upper bound, not a minimum paid period. Ordinary disconnects have no retention window. Repeated `retain` calls within one handoff do not renew its deadline. The process detects exited local clients and tracks client liveness independently; heartbeats never extend retention. Provider hard timeouts, explicit termination/revocation, and host/container shutdown still apply. `providerDeadlineKnown: false` means the backend did not supply its hard expiry; the displayed retention expiry is only the local upper bound.

Status includes `resumed: true` after a client attaches to a previously retained session. A retention deadline that has elapsed is reported as `state: "expired"`, including its original `expiresAt`, even before background cleanup runs. While a local handoff has no attached client, the worker probes its marker tab every second with a five-second timeout and stops if identity verification fails.

There is no general provider-capability discovery API in this version. All enabled sessions support bounded local retain/status/release; repeated retain does not renew a handoff. An adapter may additionally implement `describe` (provider liveness/deadline) and `retain` (provider retention), while `release` is required. These operations cannot recover after the holding worker exits or promise an extension beyond provider limits. Capability negotiation remains follow-up work in [#273](https://github.com/TGYD-helige/pi/issues/273).

Holding CDP does not override provider inactivity or WebSocket idle limits. Configure the provider's supported lifetime options when acquiring the browser, and report any shorter effective deadline through the adapter. Use structured browser connection settings; `extraArgs` cannot override them (including short aliases), enable slim mode, or change page ID routing when live sessions are enabled.

Remote sessions use a single-use WebSocket tunnel: losing the original CDP connection cannot silently redial a provider launch URL and allocate a replacement browser. Local launch/discovery uses a small blank marker tab to verify live browser identity; leave that tab open during retention. No website page is refreshed to perform this check. Expired/lost sessions report failure instead of presenting a new browser/profile as restored live state.

The MCP dependency accepts compatible 1.x updates. Marker verification depends on the installed MCP runtime's `new_page` page-list text and `evaluate_script` JSON result format. The lifecycle CI job runs the real local-Chrome E2E against that installed runtime before Cloud checks, covering marker creation, cross-process continuation, and verification. Incompatible output fails retention explicitly instead of treating a fresh browser as recovery. For auto-connected external Chrome, expiry and shutdown remove only the verified helper marker through its original MCP connection before disconnecting; cleanup never reconnects to reuse an old page ID. When cleanup is attempted, a missing connection, a helper that is the last remaining page, or failed marker cleanup is recorded as `cleanup-failed`; known-lost sessions are not reconnected.

Resume credentials are kept in owner-only session directories and 0600 records under `resolveHome()/browser-sessions/`, outside model-visible results. This is same-host, same-runtime-home continuation across Pi/MCP clients, not recovery after the independent session process, container, or machine disappears. Failed or ambiguous provider creation/cleanup retains a protected record and blocks automatic recreation. Inspect the provider and that record before manually resetting an uncertain session. An expired/lost session whose cleanup completed can be reset with `DevToolsClient.sessionControl('release')` or a new logical key.

### Cloud Lifecycle and Custom Backends

An existing cloud CDP endpoint can use the held-connection strategy above, but connecting to a browser does not grant permission to create or terminate it. To delegate instance management to the plugin, configure `backend.release` and either `backend.create` or a host-supplied runtime binding. Configuring release explicitly authorizes termination of that instance during cleanup, including an instance originally created by the host. Plain CDP connections without a backend remain disconnect-only.

| Backend | Integration path |
|---------|------------------|
| Open-source Browserless, custom gateways | Existing CDP endpoint; keep the original connection open only for an explicit handoff. No dependency on Browserless Cloud Session API |
| Browserless Cloud | Built-in `browserless` provider builds an authenticated standard Cloud CDP connection; disconnect releases its connection-owned browser |
| Browser Use Cloud browser infrastructure | Built-in `browser-use` adapter uses API v4 `/browsers` for create/status/stop; hosted-agent tasks are a separate API |
| Browserbase | Built-in `browserbase` adapter creates/inspects the session and sends `REQUEST_RELEASE` on cleanup |
| Steel Cloud | Built-in `steel` adapter creates/inspects/releases sessions and constructs the authenticated cloud CDP URL |
| Hyperbrowser, Anchor, and other CDP clouds | Existing CDP connection or an HTTP/custom lifecycle adapter |
| User-managed local Chrome | Normally leave `session.enabled` false; if enabled, closing the session only disconnects from Chrome |

Browserbase, Browser Use Cloud, and Steel adapters have offline protocol tests against local HTTP fixtures; they have not been validated against real accounts. The underlying Browserless CDP connection and self-hosted runtime were verified live previously; this change covers the named Browserless provider offline. No cloud SDK dependency is required. The HTTP adapter requires `release` and exactly one of `create` or a runtime browser binding, with optional `status` and `retain`, per-request `url`, `method`, `headers`, and JSON `body`, and a `fields` mapping. Response field paths use dotted object keys; they are not JSONPath expressions. `{sessionId}` substitutes the supplied or returned ID (URL-encoded in URLs); `{expiresAt}` substitutes an absolute Unix-millisecond deadline. Request timeouts are bounded, redirects are rejected, and management response bodies are limited to 64 KiB and never exposed in errors.

### Unified browser adapters

`createBrowserAdapter(config, options?)` is the shared SDK entry point for local Chrome launches, existing CDP endpoints (local Chrome, sidecars, or open-source Browserless), built-in cloud providers (including Browserless Cloud), and custom HTTP/module backends. The session worker uses this same factory for every connection. Existing configuration keys and the exported `BrowserLifecycleAdapter`, `createCloudBrowserAdapter`, and `createHttpBrowserAdapter` remain compatible.

```ts
const adapter = await createBrowserAdapter(config);
const browser = await adapter.acquire(config, signal);
// Pass browser.connection to the MCP/CDP transport, which owns its connection/process cleanup.
await adapter.release(browser, signal); // after closing that transport
```

The common `BrowserAdapter` interface provides `acquire`, optional `describe`/`retain`, and `release`. Acquisition returns `{ id, connection, expiresAt? }`: HTTP-managed providers supply their actual ID and explicit CDP connection; connection-owned Browserless and direct adapters generate a private local reference and return the existing connection or local MCP launch configuration. `ownership` is `local` for plugin-launched Chrome, `external` for existing CDP/discovery connections, and defaults to `adapter` for managed/custom backends. A managed backend without an explicit CDP connection fails instead of falling back to local Chrome. SDK hosts can inject an adapter through the factory's `options.adapter`; delegated instances use `options.browser` with a configured management backend.

MCP/CDP transport cleanup closes plugin-launched processes and detaches external connections. The direct adapter has no additional resource to release; managed adapters then stop only the instances they own. The session manager owns cross-process retention, marker verification, deadlines, and cancellation. `session.enabled: false` keeps ordinary direct connections without a holding worker. The named Browserless provider and direct CDP connections share the same connection lifecycle; this does not enable Browserless persistent-profile REST sessions or add a paid idle retention window.

### Built-in cloud providers

Configure exactly one of `session.provider`, `session.backend`, or `session.adapterModule`. The following goes in global/agent settings (management configuration is ignored in project settings):

```json
{
  "pi-browser-use": {
    "sessionMode": "existing",
    "session": {
      "enabled": true,
      "key": "${BROWSER_CONVERSATION_ID}",
      "retentionMs": 120000,
      "provider": {
        "name": "browserbase",
        "apiKey": "${BROWSERBASE_API_KEY}",
        "create": { "projectId": "your-project-id", "timeout": 180 }
      }
    }
  }
}
```

Replace the `provider` object for another service:

| Service | `name` | `apiKey` example | `create` example | Native timeout unit |
|---------|--------|------------------|------------------|---------------------|
| Browserless Cloud | `browserless` | `${BROWSERLESS_TOKEN}` | `{ "timeout": 180000, "launch": { "headless": true } }` | Milliseconds |
| Browserbase | `browserbase` | `${BROWSERBASE_API_KEY}` | `{ "projectId": "your-project-id", "timeout": 180 }` | Seconds |
| Browser Use Cloud | `browser-use` | `${BROWSER_USE_API_KEY}` | `{ "timeout": 3 }` | Minutes |
| Steel Cloud | `steel` | `${STEEL_API_KEY}` | `{ "timeout": 180000 }` | Milliseconds |

Browserless Cloud uses standard CDP at `/chrome`, with `provider.region` set to `sfo` (default), `lon`, or `ams`. `create` values become native connection query parameters; nested values such as `launch` are JSON-encoded. The connection timeout defaults to 60000 ms and supplies a conservative deadline from acquisition time. Its private `id` is a local reference, not a returned REST session ID. No browser is allocated until CDP connects; final transport disconnection releases the standard browser. There is no extra management `describe` or `retain` call: the shared worker checks the original connection. Persistent Session API options (`session`, `ttl`, `processKeepAlive`) are rejected. Existing runtime bindings must refer to connection-owned browsers; persistent-profile sessions need a custom management adapter. See the official [connection URL](https://docs.browserless.io/baas/connection-url-patterns) and [launch parameter](https://docs.browserless.io/overview/launch-parameters) references.

`create` is optional. The three HTTP providers pass native JSON parameters through unchanged and use service defaults when omitted; Browserless uses the query mapping and explicit 60000 ms default above. Browserbase can infer the project from the API key when `projectId` is omitted. Region, profiles, proxy options, and other creation settings follow the provider's API. `provider.timeoutMs` bounds each HTTP management request (default 15000, range 1–60000 ms; not used by connection-owned Browserless), independently of browser lifetime. Standalone CLI `--config` resolves `${ENV_VAR}` in `provider.apiKey`, but leaves the `create` body literal; extension settings follow the shared settings loader's interpolation rules.

The first browser operation acquires one cloud instance lazily (Browserless launches on CDP connection). The independent worker holds its original CDP connection through an explicit handoff, and final cleanup calls the HTTP provider's stop/release API or disconnects the connection-owned Browserless browser. These adapters do not implement live deadline extension, so there is no backend `retain` request or automatic renewal. Browserbase and Browser Use report their absolute deadlines; Steel's deadline is derived from the returned `createdAt` plus `timeout`. Earlier inactivity limits or provider termination still apply. The adapter does not turn on Browserbase `keepAlive` by default; set `create.keepAlive` only if your application needs persistence after the provider CDP connection disconnects. This may require a paid plan and does not allow recovery after this plugin's holding worker exits.

SDK users can call the exported `createCloudBrowserAdapter(provider, browser?)` or use `session.provider` with `DevToolsClient`. To adopt an instance already created by the host, omit `provider.create` and pass the runtime `ManagedBrowser` binding described below; the provider ID stays outside settings and model tools. The supplied binding connection is authoritative, including Steel connections. These built-ins target the public cloud API endpoints; self-hosted services and gateways can use `backend` or `adapterModule`.

### Custom HTTP lifecycle APIs and runtime bindings

If the host already created the instance, settings contain only the static lifecycle configuration and policy:

```json
{
  "pi-browser-use": {
    "sessionMode": "existing",
    "session": {
      "enabled": true,
      "key": "${BROWSER_CONVERSATION_ID}",
      "retentionMs": 120000,
      "backend": {
        "release": {
          "url": "https://browser-api.example/sessions/{sessionId}/stop",
          "method": "POST",
          "headers": { "Authorization": "Bearer ${BROWSER_API_KEY}" }
        }
      }
    }
  }
}
```

The provider instance ID is runtime state, not a settings key; `backend.sessionId` is rejected. SDK hosts pass the exported `ManagedBrowser` as the second argument, scoped to that client:

```ts
const client = new DevToolsClient(config, {
  id: providerSession.id,
  connection: { wsEndpoint: providerSession.cdpUrl },
  // expiresAt: providerSession.expiresAtMs, // optional absolute Unix milliseconds
});
```

For a Pi extension or standalone MCP process, the host can inject `PI_BROWSER_USE_SESSION_BINDING` at process launch instead. Its JSON payload must contain the matching logical conversation key and browser reference:

```json
{
  "key": "conversation-123",
  "browser": {
    "id": "provider-instance-456",
    "connection": { "wsEndpoint": "wss://browser.example/instance-456" }
  }
}
```

The payload's `key` must exactly match the resolved `session.key`; a mismatch fails closed. SDK clients never implicitly read this process-global environment variable, so multiple clients in one host can bind different instances. The ID must be a non-empty string of at most 1024 characters, distinct from Pi's logical key and page IDs. `connection` requires an explicit `wsEndpoint` or `browserUrl`, with optional `wsHeaders`; optional `expiresAt` is an absolute Unix-millisecond number. The host must supply the CDP address of that exact instance, not a generic launch URL that allocates a different instance on every connection. Creation and a runtime binding are mutually exclusive. This mode needs no `fields` unless configuring `status` or `retain`.

The binding is sent to the independent worker and saved only in its owner-only runtime record. A later client using the same logical key and unchanged settings can resume without reinjecting the binding; injecting a different ID or connection is rejected. Once cleanup deletes the record, starting another existing-instance session requires a fresh runtime binding. No provider IDs are inferred from CDP addresses or exposed in model tool parameters/results. Discovery alone does not adopt or release the host's instance; adoption happens on the first actual browser operation. Adapter-managed connection addresses and CDP headers are authoritative and do not inherit static connection fields; supply any CDP authentication headers in the runtime binding or custom adapter's returned `connection.wsHeaders`.

For example, a simple custom management API can use:

```json
{
  "enabled": true,
  "key": "${BROWSER_CONVERSATION_ID}",
  "retentionMs": 120000,
  "backend": {
    "create": {
      "url": "https://browser-api.example/sessions",
      "method": "POST",
      "headers": { "Authorization": "Bearer ${BROWSER_API_KEY}" },
      "body": { "headless": true }
    },
    "release": {
      "url": "https://browser-api.example/sessions/{sessionId}/stop",
      "method": "POST",
      "headers": { "Authorization": "Bearer ${BROWSER_API_KEY}" }
    },
    "fields": { "id": "id", "wsEndpoint": "cdpUrl", "expiresAt": "expiresAt" }
  }
}
```

Place this object at `pi-browser-use.session`. Adapt endpoint paths and response fields to the actual provider. Never map ordinary release to deleting a reusable profile or authentication store. The optional `status` request additionally requires `fields.status` and `fields.liveStatus`; optional `retain` must return the effective expiry through `fields.expiresAt`. Expiries are ISO timestamps or Unix milliseconds. Fixed request bodies can set creation-time provider options; the adapter cannot promise to extend a provider's immutable hard lifetime.

For SDK signing, Unix sockets, RPC, or multi-step flows, set `adapterModule` to a trusted absolute `.mjs` path exporting `createBrowserLifecycleAdapter()`. It returns the exported `BrowserLifecycleAdapter`: `acquire(config, signal)` returns `{id, connection: {wsEndpoint}, expiresAt?}`, optional `describe` returns `{alive, expiresAt?}`, optional `retain` returns `{expiresAt}`, and `release(browser, signal)` ends only the adapter-owned browser. The module runs in the independent process, so cleanup is available after a Pi client exits. Additional module environment variables must be explicitly included in `envAllowlist`. Long-lived SDK hosts may instead inject an adapter into exported `serveBrowserSession(config, token, {adapter})`; `token` must be a random 32-byte hex value. Management adapters are trusted host/user configuration and are never loaded from project settings or model arguments.

Adapters must provide callable acquire/release methods and a valid explicit CDP connection; invalid results fail instead of launching a local browser. Describe results require a boolean `alive`, and all programmatic expiries must be numeric Unix milliseconds within the JavaScript Date range. Acquire/describe/retain waits honor cancellation and the 60-second operation limit even if an SDK ignores its signal. Shutdown waits at most 15 seconds for pending acquisition and separately bounds the provider release wait to 15 seconds. A timeout cannot prove that a provider operation stopped: uncertain outcomes keep protected recovery metadata and block automatic recreation. Adapters should still honor their supplied signal to stop the actual remote work.

#### HTTP Backend Contract

This is pi-browser-use's configurable adapter contract, not an industry-standard browser management API. Browser automation uses CDP; lifecycle operations use your service's HTTP API. Routes, methods, authentication headers, request bodies, and response field names are configurable. An existing provider fits directly only when its API can be expressed by these mappings; otherwise use `adapterModule` or a small gateway. No provider is required to implement the example routes below.

| Operation | Required | Request and response contract |
|-----------|----------|-------------------------------|
| `create` | Unless a runtime binding is supplied | Mutually exclusive with a runtime binding. Called lazily on the first browser operation. Return a non-empty string ID (at most 1024 characters) and the instance's CDP connection address. Map them with `fields.id` and `fields.wsEndpoint`. The address may use `ws:`/`wss:`, or `http:`/`https:` for discovery at `/json/version`. Optional `fields.expiresAt` supplies the provider deadline. |
| `release` | Yes | Stop the instance identified by `{sessionId}` and release its resources. Return a successful status with an empty body or valid JSON; no response fields are required. Do not delete reusable profiles or stored authentication. |
| `status` | No | Inspect the same instance without creating a replacement. Return a status value at `fields.status`; it is alive only when that value exactly equals the configured `fields.liveStatus` string. An optional expiry uses `fields.expiresAt`. |
| `retain` | No | Apply the requested absolute deadline `{expiresAt}` to the same instance. Return the actual effective deadline at `fields.expiresAt`; this mapping is required when configuring `retain`. The plugin uses the earliest of its requested deadline, the returned deadline, and any known provider deadline. |

For example, a new custom service could implement:

```text
POST /sessions
  request:  {"headless":true}
  response: 201 {"id":"b123","cdpUrl":"ws://browser-service:9222/devtools/browser/abc"}

DELETE /sessions/b123
  response: 204 (empty)

GET /sessions/b123                         # optional
  response: 200 {"status":"running"}

POST /sessions/b123/retain                 # optional
  request:  {"expiresAt":1893456000000}
  response: 200 {"expiresAt":1893456000000}
```

The create/release example above already shows the minimum configuration. To map these optional operations, add the following properties inside `session.backend`, including the same authentication headers as your service requires:

```json
{
  "status": {
    "url": "http://browser-service:3000/sessions/{sessionId}",
    "method": "GET"
  },
  "retain": {
    "url": "http://browser-service:3000/sessions/{sessionId}/retain",
    "method": "POST",
    "body": { "expiresAt": "{expiresAt}" }
  },
  "fields": {
    "id": "id",
    "wsEndpoint": "cdpUrl",
    "expiresAt": "expiresAt",
    "status": "status",
    "liveStatus": "running"
  }
}
```

All management requests use HTTP(S), default to `POST`, and support `GET`, `POST`, `PATCH`, `PUT`, and `DELETE`. `GET` must have no body. Request bodies are JSON and headers default to `Content-Type: application/json`; add authentication through `headers`. `{sessionId}` and `{expiresAt}` are substituted in URLs and JSON body values, not headers. IDs are URL-encoded in URLs; a whole JSON value of `"{expiresAt}"` becomes a number. Response field paths are dotted own-property paths such as `data.id`, not JSONPath. Expiries are absolute Unix milliseconds or ISO timestamps, never relative durations.

Every operation requires a 2xx response and an empty body or valid JSON, limited to 64 KiB. Redirects are rejected. `backend.timeoutMs` defaults to 15000 and accepts 1–60000 milliseconds; caller cancellation also applies. Non-2xx responses, malformed responses, and timeouts fail the operation without exposing response bodies or automatically retrying creation. In particular, a release returning 404 is a cleanup failure; services that treat an already-stopped instance as released should return 2xx. Make release idempotent where possible. Ambiguous creation/cleanup keeps a protected record for inspection rather than silently creating another paid instance.

There is no required `resume` HTTP operation: the independent process holds the original CDP connection, and the next Pi client reconnects to that process. Without `status` or `retain`, existing-CDP retention still works, but cannot extend a provider's hard lifetime. The public `browser_session release` cancels the handoff window; the backend `release` runs during final cleanup after the active client disconnects. This contract supports continuation on the same host/runtime home, not migration to another machine or restoration after the holding process disappears.

On the same host, temporary agent homes may symlink `browser-sessions` to the same durable directory. Session record and lock paths are resolved to that directory before worker startup, so deleting the originating home does not invalidate the retained worker’s paths. The shared directory must remain available and pass the existing ownership checks.

### Live-session Verification

```sh
pnpm --filter @amaster.ai/pi-browser-use build
pnpm exec vitest run packages/pi-browser-use/src/__tests__
node tests/browser-session-e2e.mjs
```

The E2E check uses actual headless Chrome and separate Pi client processes. It verifies an in-memory handshake and running polling loop through the public tool, a CDP gateway that closes browsers one second after disconnect, normal cleanup without retention, lost-connection handling without replacement, and expiry. Set `PI_BROWSER_TEST_EXECUTABLE` if Chrome is installed at a custom path. `PI_BROWSER_TEST_GATEWAY_MODULE` can point to a trusted module exporting the MirrorX `createGateway` function to run against that gateway implementation instead of the small test proxy. No cloud credentials or paid provider calls are needed.

The `Extension E2E (pi-browser-use-session)` matrix scenario runs two real Pi CLI processes with the integration model against the named Browserless Cloud provider. The first model run creates a unique blank page, initializes an in-memory marker/polling counter, and calls `browser_session retain`. The second receives a fresh conversation, lists the existing page, reads its marker/counter without rewriting them, and releases the handoff. Assertions inspect actual tool events and results, not assistant claims; provider/tool errors, missing retention/release, replacement pages, and stopped polling fail the job. The cloud connection is capped at 120 seconds and cleanup releases the held connection. It shares the existing integration approval/credentials gate and loads only the browser extension inside the two tested Pi processes. Run it with configured Pi model credentials and `BROWSERLESS_TOKEN`: `node .github/scripts/browser-session-model-e2e.mjs`. The manual `browser_session_only=true` workflow includes this model scenario alongside the dedicated lifecycle job. Before the new workflow is merged, use branch `workflow_dispatch` for authoritative CI evidence: automatic PR runs use the default-branch workflow and omit the new scenario until that workflow supports it.

The dedicated `Browserless Cloud session lifecycle` job in `.github/workflows/integration.yml` runs the same public-tool handshake/polling protocol through `session.provider.name: "browserless"` against `production-sfo.browserless.io/chrome`, using the existing `BROWSERLESS_TOKEN` secret after the shared integration approval gate. It waits for Stage C to finish so its Browserless connections do not overlap with the other browser tests. It requires no LLM or local Chrome installation, fails when the token is missing, and bounds each cloud connection to 60 seconds. Browser package changes and lifecycle test-script changes select this job. To run it manually with a token already in your environment: `node .github/scripts/browserless-session-e2e.mjs`. The offline E2E also exercises this CI script against its local real-Chrome gateway fixture.

Integration uses `pull_request_target`, so GitHub loads its workflow definition from the default branch even when checkout uses PR code. A newly added job therefore does not appear in the automatic PR run before merge. Maintainers can validate the PR branch's workflow with `gh workflow run integration.yml --ref <branch> -f browser_session_only=true` and find the `Browserless Cloud session lifecycle` job in that manual run. This keeps runtime loading and the existing environment approval gate, while skipping unrelated model/platform suites; see [GitHub's event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

### Categories

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `categoryPerformance` | `boolean` | `false` | Enable performance tools |
| `categoryNetwork` | `boolean` | `true` | Enable network tools |
| `categoryEmulation` | `boolean` | `true` | Enable emulation tools |
| `categoryExtensions` | `boolean` | `false` | Enable extension tools |

### Tool Profile

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `toolProfile` | `"core" \| "full"` | `"core"` | `"core"` activates only the everyday toolset at session start; `"full"` activates every discovered tool. Ignored in `slim` mode |

With the default `core` profile, only the core loop is visible to the model: `list_pages`, `new_page`, `navigate_page`, `select_page`, `close_page`, `wait_for`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `fill_form`, `press_key`, `handle_dialog`, `evaluate_script`, and `list_console_messages`. Every other discovered tool stays registered but inactive, grouped by its upstream chrome-devtools-mcp category (`input`, `debugging`, `network`, `emulation`, `memory`, `performance`, ...). The model activates a group itself with the `browser_tools` tool (no argument lists the groups); users can do the same with `/browser-tools <group>`. Activated groups stay active until the end of the session.

Tools that used to be filtered out (`lighthouse_audit`, performance traces, screencast, extension management) are now registered and deferred instead — enabling their categories via the flags above makes them activatable through their group.

Pi hosts with native tool-discovery support also expose upstream tools under the `browser` namespace (alias `browser_use`). Under the `core` profile, optional tools use `deferred` exposure: codemode can find and call them without a manual group activation, and the built-in `tool_search` can discover and activate them for direct calls. On Pi 1.2, enable these built-ins with `pi --tools +codemode,+tool_search`; SDK hosts must load their corresponding built-in extension factories. The existing group tool and command remain available, `full` keeps all tools direct, and older hosts retain manual activation. Tool exposure controls discovery and visibility, not authorization; execution still passes through the host's tool hooks.

### Experimental

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `experimentalVision` | `boolean` | `true` | Enable vision tools (click_at) |
| `experimentalScreencast` | `boolean` | `false` | Enable screencast |
| `experimentalMemory` | `boolean` | `false` | Enable memory snapshots |
| `experimentalPageIdRouting` | `boolean` | `true` | Add a required `pageId` to page-scoped tools and route directly to that page |

### Privacy

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `usageStatistics` | `boolean` | `false` | Send usage statistics |
| `performanceCrux` | `boolean` | `false` | Enable CrUX performance data |
| `redactNetworkHeaders` | `boolean` | `true` | Redact sensitive headers in network tool results |
| `allowedUrlPattern` | `string[]` | — | Allow only matching URLPattern values; requires Chrome 149+ |
| `blockedUrlPattern` | `string[]` | — | Block matching navigation and subresource URLPattern values |

`allowedUrlPattern` and `blockedUrlPattern` are mutually exclusive. Page ID routing is disabled automatically in `slim` mode because upstream slim tools do not expose `pageId`.

### Page-scoped Tool Calls

With the default page ID routing enabled, call `browser_list_pages` first and pass the returned numeric page ID to subsequent page-scoped tools:

```text
browser_list_pages({})
browser_take_snapshot({ "pageId": 2 })
browser_click({ "pageId": 2, "uid": "12_4" })
browser_take_screenshot({ "pageId": 2 })
```

This avoids relying on `browser_select_page` when multiple browser calls or tabs are active. A single chrome-devtools-mcp process still serializes tool execution; page ID routing provides isolation rather than parallel throughput.

### Vision Model (Optional)

Enable `browser_analyze_screenshot` by referencing a model already configured in Pi's model registry (`models.json`):

```json
{
  "pi-browser-use": {
    "visionModel": {
      "provider": "openai",
      "model": "gpt-4o"
    }
  }
}
```

The extension resolves API key, base URL, and headers from the model registry automatically — no need to duplicate credentials here.

Screenshot-analysis failures report the failing phase, HTTP status when available, and a bounded explanation in both stderr and the tool result. Credentials, image data, raw provider responses, and stack traces are omitted. For example, HTTP 429 identifies a service rate limit or quota problem instead of a generic `Error`.

With the default page ID routing enabled, visual analysis also targets a page explicitly:

```text
browser_analyze_screenshot({ "pageId": 2, "instruction": "Find the blue submit button" })
```

## Tool Augmentation

Key tools receive additional usage hints in their descriptions:

| Tool | Hint |
|------|------|
| `browser_click` | Use element uid from snapshot; UIDs invalidated after action |
| `browser_fill` | Does not work on canvas/custom widgets |
| `browser_press_key` | Accepts single key name only |
| `browser_take_snapshot` | Call first to get uids, and after every state-changing action |
| `browser_navigate_page` | Call take_snapshot after navigation |

## Result Post-Processing

- **Snapshot stripping** — Removes embedded accessibility tree snapshots from non-snapshot tool responses to prevent token bloat
- **Overlay detection** — When a click is blocked by an overlay/popup, appends a hint to dismiss it first
- **Stale element detection** — When element references are stale, appends a hint to refresh the snapshot

## Excluded Tools

None. Previously excluded upstream tools (`lighthouse_audit`, performance traces, screencast, extension management) are registered but inactive under the default `core` tool profile — see [Tool Profile](#tool-profile).

## License

Apache-2.0

When native `tool_search` is active, the plugin hides its group-activation tool declaration and guidance from the model. Disabling `tool_search` restores that fallback. Group-activation tools are model-only management tools on native runtimes, so codemode scripts use native discovery instead. The corresponding slash command remains available in both cases; older runtimes keep the existing activation behavior.
