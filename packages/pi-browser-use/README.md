# @amaster.ai/pi-browser-use

![pi-browser-use preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-browser-use/preview.png)

pi-coding-agent extension that wraps [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp), exposing all browser automation tools with a unified `browser_` prefix.

## Features

- **pi-coding-agent extension** — registers tools via `pi.registerTool()`, managed by the agent lifecycle
- **Dynamic tool discovery** — automatically proxies all upstream chrome-devtools-mcp tools with `browser_` prefix
- **Reproducible MCP runtime** — launches the installed chrome-devtools-mcp entrypoint with the current Node executable instead of downloading `@latest` through ambient `npx`
- **Page-scoped routing** — routes page tools by explicit `pageId` instead of shared selected-page state
- **Connection recovery** — detects closed or unhealthy MCP transports and reconnects before the next call
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

`chrome-devtools-mcp` is a compatible runtime dependency and its installed entrypoint is resolved when the extension module loads. A missing or malformed installation fails extension loading immediately; the extension does not download a replacement at connection time. Connection failures expose only allowlisted system error codes or Chrome startup categories, not raw subprocess stderr.

Hosts where `process.execPath` is not a directly executable Node runtime can set `PI_BROWSER_USE_NODE` to the Node command used for the MCP subprocess.

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

### Categories

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `categoryPerformance` | `boolean` | `false` | Enable performance tools |
| `categoryNetwork` | `boolean` | `true` | Enable network tools |
| `categoryEmulation` | `boolean` | `true` | Enable emulation tools |
| `categoryExtensions` | `boolean` | `false` | Enable extension tools |

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

- `lighthouse_audit` — Filtered out at the proxy level

## License

Apache-2.0
