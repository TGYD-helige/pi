# @amaster.ai/pi-computer-use

![pi-computer-use preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-computer-use/preview.png)

Cross-platform computer-use tools for Pi desktop automation. The extension exposes a native MCP tool surface with a `computer_use_` prefix. The bundled runtime comes from the official [Cua Driver Rust 0.28.2 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2).

## What it provides

- One Rust 0.28.2 driver line across macOS, Linux, and Windows
- 56 version-pinned upstream tools, including sessions, element tokens, accessibility + screenshot state, native input, browser tools, diagnostics, recording, and permission policy support
- Deferred tool activation: only the core toolset is active by default; extra groups are activated on demand via `computer_use_tools` or `/computer-use-tools`
- Full MCP text, image, and `structuredContent` forwarding
- Owned daemon + MCP proxy lifecycle with session-owned reconnect and per-call cancellation
- A non-prompting Linux/Windows permission probe on session start
- Once-per-session app-launch approval and confirmation for high-risk operations
- Bounded text and structured results before they enter Pi's context
- Optional secondary vision analysis through a configured Pi model

`get_window_state` is the primary perception tool. Cua Driver 0.28 returns the accessibility tree, structured elements with `element_token`, and a screenshot in one response. The standalone `screenshot` tool no longer exists.

## Install

```bash
bun add @amaster.ai/pi-computer-use
```

The package selects one signed/precompiled platform runtime through npm `optionalDependencies`. Installation does not download from GitHub, and no separate Cua Driver installation is required. Offline mirrors must include `@amaster.ai/pi-computer-use` and the matching `@amaster.ai/pi-computer-use-cua-driver-*` package.

Upgrading from Cua Driver 0.9 is a deliberate public-tool migration: upstream removed `set_agent_cursor_style` and replaced it with `set_agent_cursor_theme`. The new tool selects an installed `theme_id`; the old custom color/image parameters have no 0.28 equivalent.

## Configuration

Configure `.pi/settings.json` or `~/.pi/agent/settings.json`:

Project settings are loaded only after project trust is accepted. `${ENV_VAR}` interpolation is supported in user and agent settings, but not in project settings.

```json
{
  "pi-computer-use": {
    "mode": "bundled",
    "confirmAppLaunch": true,
    "confirmDangerousActions": true,
    "toolProfile": "core"
  }
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"bundled" \| "path"` | `"bundled"` | Use the packaged 0.28.2 driver or a compatible custom binary |
| `binaryPath` | `string` | — | Custom driver path when `mode` is `"path"` |
| `extraArgs` | `string[]` | — | Additional arguments appended to `cua-driver mcp` |
| `confirmAppLaunch` | `boolean` | `true` | Ask once per app target before `launch_app` |
| `confirmDangerousActions` | `boolean` | `true` | Confirm high-risk tools such as `kill_app` and `replay_trajectory`; recording always requires confirmation |
| `toolProfile` | `"core" \| "full"` | `"core"` | `"core"` activates only the everyday toolset at session start; `"full"` activates all 56 driver tools |
| `visionModel` | `{ provider, model }` | — | Register `computer_use_analyze_screenshot` |

In non-interactive modes, confirmation-required tools return an error unless the corresponding confirmation setting is explicitly disabled.

### Tool groups

With the default `core` profile, only everyday tools are visible to the model (`list_apps`, `launch_app`, `get_window_state`, `verify_state`, the click/type/scroll family, and `zoom`). The remaining driver tools stay registered but inactive, so they cost no prompt context. The model activates a group itself by calling `computer_use_tools` (without arguments it lists the groups); users can do the same with `/computer-use-tools <group>`:

| Group | Tools |
| --- | --- |
| `browser` | CDP browser automation: `browser_prepare`, `browser_navigate`, `browser_click`, `browser_type`, `browser_dialog`, `browser_set_input_files`, `browser_download`, `browser_pointer`, `get_browser_state`, `page` |
| `recording` | `start_recording`, `stop_recording`, `get_recording_state`, `replay_trajectory`, `install_ffmpeg` |
| `session` | `start_session`, `escalate_session`, `get_session`, `get_session_state`, `list_sessions`, `end_session` |
| `cursor` | `move_cursor`, `set_agent_cursor_enabled`, `set_agent_cursor_motion`, `set_agent_cursor_theme`, `get_agent_cursor_state` |
| `window` | `list_windows`, `bring_to_front`, `set_window_frame`, `invoke_menu`, `kill_app` |
| `clipboard` | `clipboard_read`, `clipboard_write` |
| `diagnostics` | `check_permissions`, `health_report`, `get_config`, `set_config`, `check_for_update`, `get_desktop_state`, `get_screen_size`, `get_cursor_position`, `get_accessibility_tree` |

Activated groups stay active for the rest of the session; each new session starts from the configured profile again.

### Optional vision model

```json
{
  "pi-computer-use": {
    "visionModel": {
      "provider": "openai",
      "model": "gpt-4o"
    }
  }
}
```

`computer_use_analyze_screenshot` requires both `pid` and `window_id`. It calls `get_window_state`, reuses the returned image, and invokes the configured model. Use it only when the primary model cannot resolve visual ambiguity.

## Runtime and permissions

On macOS, `session_start` registers the generated 0.28.2 manifest without starting the driver. The signed app and MCP proxy start lazily on the first computer-use tool call, which requests any missing permissions through `check_permissions({ prompt: true })`. Existing grants do not raise another system dialog. The requested tool still runs and reports its own capability or permission error. Linux and Windows keep eager startup: they discover the exact live `tools/list` surface and call `check_permissions({ prompt: false })`. If discovery fails, the extension registers `computer_use_connect` (and `/computer-use-connect`) so a later retry can install the exact live platform contract without advertising another OS's schemas.

Driver startup, reconnect, and the first macOS permission probe are session-owned. Cancelling a tool stops only that caller's wait or MCP request; session shutdown aborts the shared work. macOS and Linux also use a transient pipe-backed lease to stop the owned daemon after an abrupt host exit; no persistent service or system scheduler is installed.

- **Bundled macOS:** launches the signed `CuaDriver.app` through LaunchServices,
  so Accessibility and Screen Recording grants belong to `com.trycua.driver`.
- **Custom macOS binary:** uses Cua Driver embedded mode and inherits the host
  application's TCC responsibility chain.
- **Linux/Windows:** starts an extension-owned daemon in the interactive user
  session and tears it down on session shutdown.

## Supported targets

| Platform | Runtime package |
| --- | --- |
| macOS ARM64 / x64 | `@amaster.ai/pi-computer-use-cua-driver-darwin-universal` |
| Linux x64 | `@amaster.ai/pi-computer-use-cua-driver-linux-x64` |
| Linux ARM64 | `@amaster.ai/pi-computer-use-cua-driver-linux-arm64` |
| Windows x64 | `@amaster.ai/pi-computer-use-cua-driver-win32-x64` |
| Windows ARM64 | `@amaster.ai/pi-computer-use-cua-driver-win32-arm64` |

## Canonical workflow

1. `computer_use_launch_app` or `computer_use_list_apps`
2. `computer_use_get_window_state`
3. Act using `element_token`/`element_index`, falling back to pixels for
   custom-drawn surfaces
4. Re-run `computer_use_get_window_state` and verify the change
5. When the task needs more than the core toolset (browser automation,
   recording, escalated sessions, ...), call `computer_use_tools` with the
   matching group first

Linux and Windows tool descriptions and schemas come from the exact live driver. macOS uses the generated manifest for the bundled driver release.

## License

Apache-2.0 for this extension package. Bundled Cua Driver assets retain the upstream MIT license and release metadata in each platform package.
