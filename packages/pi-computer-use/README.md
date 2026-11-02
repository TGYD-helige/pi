# @amaster.ai/pi-computer-use

![pi-computer-use preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-computer-use/preview.png)

Cross-platform computer-use tools for Pi desktop automation. The extension exposes a native MCP tool surface with a `computer_use_` prefix. The bundled runtime comes from the official [Cua Driver Rust 0.37.0 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.37.0).

## What it provides

- One Rust 0.37.0 driver line across macOS, Linux, and Windows
- 62 version-pinned upstream tools, including sessions, element tokens, accessibility + screenshot state, native input, browser tools, diagnostics, recording, and permission policy support
- Deferred tool activation: only the core toolset is active by default; extra groups are activated on demand via `computer_use_tools` or `/computer-use-tools`
- Full MCP text, image, and `structuredContent` forwarding
- Owned daemon + MCP proxy lifecycle with session-owned reconnect and per-call cancellation
- A non-prompting Linux/Windows permission probe on session start
- Once-per-session app-launch approval and confirmation for high-risk operations
- Bounded text and structured results before they enter Pi's context
- Optional secondary vision analysis through a configured Pi model

`get_window_state` is the primary perception tool. Cua Driver 0.37.0 defaults to a compact Markdown accessibility tree. Request `tree_format:"both"` for structured elements with `element_token`, and `include_screenshot:true` when a screenshot is needed. The standalone `screenshot` tool no longer exists.

The `cursor` group exposes six motion styles through `set_agent_cursor_motion`: `signature_arc`, `spring_settle`, `magnetic`, `comet_swoop`, `adaptive`, and `classic`. Set initial motion with `start_session.cursor_motion`, or save defaults through `set_config` using `cursor.motion.*` keys. The `diagnostics` group includes `parse_visual_regions` for registered captures and `install_extension` for optional Driver-managed extensions; preview the plan first, then request installation with `confirm:true`. With the default `confirmDangerousActions:true`, Pi also requires interactive user approval before installation.

## Install

```bash
bun add @amaster.ai/pi-computer-use
```

The package selects one signed/precompiled platform runtime through npm `optionalDependencies`. Installation downloads the matching Driver package from npm, with no separate Driver installation required. Offline mirrors must include `@amaster.ai/pi-computer-use` and the matching `@amaster.ai/pi-computer-use-cua-driver-*` package. Optional Perception artifacts are downloaded directly from Cua only when needed; they are not npm dependencies.

Upgrading from Cua Driver 0.9 is a deliberate public-tool migration: upstream removed `set_agent_cursor_style` and replaced it with `set_agent_cursor_theme`. The new tool selects an installed `theme_id`; the old custom color/image parameters have no 0.28 equivalent.

Upgrading to Cua Driver 0.34 removes `element_index` and `snapshot_id` from action parameters. Use the current snapshot's `element_token` for accessibility actions; `element_index` remains display metadata. For pixel actions, pass `capture_id` from the source screenshot when available. A fresh snapshot invalidates previous element tokens, so refresh state before acting again.

Cua Driver 0.35 replaces the legacy `set_config({key, value})` form with named properties, for example `set_config({"cursor.motion.timing": "steady"})`. Use the registered schema for the supported properties. The new `automation` group exposes `run_steps` for fixed action sequences and `run_script` for sandboxed JavaScript; both require interactive approval when `confirmDangerousActions:true`. Scripts also require approval when `confirmAppLaunch:true`, because they can launch applications; the approval covers the full script.

Cua Driver 0.37 adds `browser_select` for native HTML `<select>` controls and `get_guide({topic})` for built-in guidance on browsers, dragging, permissions, batching, and menus. Activate the `browser` or `diagnostics` group respectively. On macOS, window-scoped `drag` defaults to `delivery_mode:"background"`; use `"foreground"` only when background delivery had no effect, because it briefly fronts the target and moves the physical pointer. `list_windows({pid})` includes every window layer for that process.

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
| `mode` | `"bundled" \| "path"` | `"bundled"` | Use the packaged 0.37.0 driver or a compatible custom binary |
| `binaryPath` | `string` | — | Custom driver path when `mode` is `"path"` |
| `extraArgs` | `string[]` | — | Additional arguments appended to `cua-driver mcp` |
| `confirmAppLaunch` | `boolean` | `true` | Ask once per app target before `launch_app` |
| `confirmDangerousActions` | `boolean` | `true` | Confirm high-risk tools such as `kill_app`, `replay_trajectory`, and `install_extension` with `confirm:true`; recording always requires confirmation |
| `toolProfile` | `"core" \| "full" \| "lazy"` | `"core"` | `"core"` activates the 14 everyday driver tools at session start; `"full"` activates all 62 driver tools; `"lazy"` defers all driver tools on native hosts and falls back to `"core"` on older hosts |
| `visionModel` | `{ provider, model }` | — | Register `computer_use_analyze_screenshot` |

In non-interactive modes, confirmation-required tools return an error unless the corresponding confirmation setting is explicitly disabled.

### Tool groups

With the default `core` profile, only everyday tools are visible to the model (`list_apps`, `launch_app`, `get_window_state`, `verify_state`, the click/type/scroll family, and `zoom`). The remaining driver tools stay registered but inactive, so they cost no prompt context. The model activates a group itself by calling `computer_use_tools` (without arguments it lists the groups); users can do the same with `/computer-use-tools <group>`:

| Group | Tools |
| --- | --- |
| `browser` | CDP browser automation: `browser_prepare`, `browser_navigate`, `browser_click`, `browser_type`, `browser_select`, `browser_dialog`, `browser_set_input_files`, `browser_download`, `browser_pointer`, `get_browser_state`, `page` |
| `automation` | `run_steps`, `run_script` |
| `recording` | `start_recording`, `stop_recording`, `get_recording_state`, `replay_trajectory`, `install_ffmpeg` |
| `session` | `start_session`, `escalate_session`, `get_session`, `get_session_state`, `list_sessions`, `end_session` |
| `cursor` | `move_cursor`, `set_agent_cursor_enabled`, `set_agent_cursor_motion`, `set_agent_cursor_theme`, `get_agent_cursor_state` |
| `window` | `list_windows`, `bring_to_front`, `set_window_frame`, `invoke_menu`, `kill_app` |
| `clipboard` | `clipboard_read`, `clipboard_write` |
| `diagnostics` | `get_guide`, `check_permissions`, `health_report`, `get_config`, `set_config`, `check_for_update`, `get_desktop_state`, `get_screen_size`, `get_cursor_position`, `get_accessibility_tree`, `parse_visual_regions`, `install_extension` |

Activated groups stay active for the rest of the session; each new session starts from the configured profile again.

Pi hosts with native tool-discovery support expose driver tools under the `computer_use` namespace (alias `desktop`). Optional tools use `deferred` exposure under the `core` profile, so codemode can discover and call them and the built-in `tool_search` can activate them for direct use. On Pi 1.2, enable these built-ins with `pi --tools +codemode,+tool_search`; SDK hosts must load their corresponding built-in extension factories. Existing group activation, the `full` profile, and older-host behavior remain available. Deferred calls retain the same driver permissions, high-risk confirmations, cancellation, and host tool hooks as direct calls.

To load even the 14 core driver tool schemas only when needed, explicitly set `"toolProfile": "lazy"`. On hosts with native discovery, all driver tools then use deferred exposure; enable `tool_search` to discover and activate them on demand, or use codemode discovery. On older hosts without native discovery, this profile behaves like `core`, with the everyday tools active and additional groups available through `computer_use_tools` or `/computer-use-tools`. The default remains `core`; `full` is unchanged. This profile only affects driver tools, not the group-management tool or the optional screenshot-analysis tool.

After `get_browser_state({ pid, window_id })` binds a browser window, its bounded model-visible text includes `target_id` and tab records with `tab_id`, shortened title and URL, and active state. Active tabs appear first. Use the returned `target_id` and `tab_id` for subsequent browser calls; these IDs remain available in structured details as well.

### Model-visible structured results

The extension includes bounded structured results in model-visible text for these tools, so their data is available for the next action:

| Tools | Model-visible data |
| --- | --- |
| `get_browser_state` | Bind IDs; snapshot action/content refs, semantic outline, snapshot continuation, frame limitations, and screenshot coordinate metadata |
| `browser_prepare`, `browser_dialog` | Newly launched browser PID and attachment state; current dialog ID required for accept/dismiss |
| `parse_visual_regions` | Capture identity, action-coordinate transform, region text/labels/bounds, and warnings |
| `get_session`, `get_session_state`, `list_sessions` | Session state and records, including pagination cursor |
| `get_config`, `get_agent_cursor_state` | Current configuration and cursor state |
| `verify_state` | Stability and individual predicate outcomes, including unknown reasons |

Upstream recovery `hint` and `next_call` fields are also included in bounded model-visible text for failed or unconfirmed actions. A `screen_locked` snapshot requires waking and unlocking the Mac before retrying; do not send foreground input to the lock screen.

Action results also expose the Driver's `effect`, `delivery`, `evidence`, and `escalation` fields in bounded model-visible text when present. A dispatched action or an unconfirmed effect does not prove completion or non-delivery. If an MCP response is lost, the outcome is unknown: read the target's current state before repeating clicks, typing or submissions. The extension does not automatically replay failed tool calls.

Long descriptive text and large lists are shortened with a truncation notice; opaque IDs and continuation tokens are never shortened. Narrow browser reads with `query` or `scope_ref` in `semantic_v2` when needed. If session records are omitted locally, repeat `list_sessions` with a smaller `limit` before using `next_cursor` to avoid skipping unseen records. Original structured results remain available in bounded details.

Before typed browser actions such as navigation, clicks, typing, pointer input, file assignment, and downloads, the extension automatically inspects the exact tab's JavaScript dialog state. This establishes the driver's CDP dialog-event subscription before the action can open a modal, so callers do not need to manually inspect first. If a dialog is already open, the action is not dispatched and its current `dialog_id` is returned for `browser_dialog` to resolve. If a dialog opened before this driver ever subscribed and inspection times out, dismiss it manually once before retrying; the extension cannot recover that existing modal through the affected driver path.

### Optional local perception

`parse_visual_regions` uses the separately installed `cua-perception` worker to return OCR text and icon regions from a registered screenshot. It runs locally without Python or a provider API key. It is not bundled, downloaded, or installed by `pi-computer-use`. Accessibility, browser tools, and screenshot reasoning remain usable without it. On `not_installed`, continue with those tools unless local OCR/icon parsing is needed. The tool descriptions guide agents through direct upstream installation on demand.

Perception has its own release and platform support. [Cua Perception 0.2.1](https://github.com/trycua/cua/releases/tag/cua-perception-v0.2.1) publishes these targets:

| OS / CPU | Release target |
| --- | --- |
| macOS ARM64 (Apple Silicon) | `aarch64-apple-darwin` |
| Linux x64 (glibc) | `x86_64-unknown-linux-gnu` |
| Windows x64 | `x86_64-pc-windows-msvc` |

There are no published 0.2.1 artifacts for macOS Intel, Linux ARM64, or Windows ARM64. The universal macOS Driver does not imply universal perception support. Select the native target; do not install another architecture's archive.

The approximately 421–426 MB compressed bundle contains the native worker, ONNX Runtime, OmniParser icon detector, PP-OCR text detector/English recognizer, dictionary, notices, and corresponding-source materials. The release identifies the OmniParser detector as AGPL-3.0-only and the PP-OCR artifacts as Apache-2.0; other bundled components retain their own licenses. Read the release's SBOM and [third-party notices](https://github.com/trycua/cua/blob/cua-driver-rs-v0.37.0/libs/cua-driver/docs/perception-third-party-notices.md) before redistribution. These artifacts are not included in this extension's Apache-2.0 package or the default MIT Driver package.

To install on demand, the agent or user downloads the signed catalog and matching archive from the [official Perception release](https://github.com/trycua/cua/releases/tag/cua-perception-v0.2.1) into the same directory. For 0.2.1, select `cua-perception-0.2.1-<target>.catalog.json` and `cua-perception-0.2.1-<target>.tar.gz` using the target above. Do not use the repository-wide Latest release: Driver and Perception have separate release tags. Keep the complete upstream archive and signature verification intact. Expired catalogs require a newer Perception release.

Use the configured Driver binary, or resolve the bundled binary from the installation containing `pi-computer-use`:

```bash
node --input-type=module -e "import { resolveDriverLayout } from '@amaster.ai/pi-computer-use'; console.log(resolveDriverLayout({mode:'bundled'}).binaryPath)"
```

With the same user and `CUA_DRIVER_RS_HOME` as Pi, run these commands using that binary:

```bash
cua-driver extension inspect cua-perception --catalog /absolute/path/to/catalog.json
# Review publisher, target, size, licenses and source before installing within user authorization.
cua-driver extension install cua-perception --catalog /absolute/path/to/catalog.json
cua-driver extension status cua-perception --self-test
```

The Driver verifies the signed catalog and archive before installing into its own extension store. A running Driver detects the installation on the next parse without restarting. The `computer_use_install_extension` MCP tool does not download files: it requires `CUA_DRIVER_PERCEPTION_CATALOG` to point to the local catalog at daemon launch. Prefer the CLI above for an existing session; explicit catalog/store environment variables are still forwarded to the daemon and MCP proxy.

Activate `/computer-use-tools diagnostics`, then ask Pi to capture the exact window with `computer_use_get_window_state({pid, window_id, include_screenshot:true})` and pass its returned `capture_id` to `computer_use_parse_visual_regions({capture_id, options:{max_regions:3}})`. Keep both calls on the same Pi connection and repeat the same `session` label if one is used. `snapshot_id` is not a capture ID. The installation plan and parse results are exposed in bounded model-visible text. Parse results include region text/labels/bounds and the capture's action-coordinate transform. A missing extension returns `not_installed`; stale or expired captures require another capture. Do not remove `capture_id` to bypass a rejected pixel action.

Use `extension inspect` before `extension update cua-perception --catalog ...` to change versions. To remove only the Driver-managed installation, run the same binary with `extension remove cua-perception`. See the [upstream lifecycle documentation](https://github.com/trycua/cua/blob/cua-driver-rs-v0.37.0/libs/cua-driver/docs/perception-extension.md) for the complete contract.

For maintainers, the platform integration job downloads pinned upstream artifacts into the runner's temporary directory, verifies their hashes, and checks signed installation, self-test and real OCR. Release metadata lives under `.github/scripts/fixtures/`. The CI-only `scripts/fetch-perception.mjs <target> [destination]` keeps its stable entry point for base-branch PR workflows and defaults to `$RUNNER_TEMP/cua-perception` (or the system temporary directory outside CI). It is not shipped in the npm package. Perception has no platform npm package or publish workflow in this repository.

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

Windows daemon status probes allow up to 10 seconds per process invocation, so slow driver initialization is not interrupted after 250 ms. Session cancellation still aborts the probe.

On macOS, `session_start` registers the generated 0.37.0 manifest without starting the driver. The signed app and MCP proxy start lazily on the first computer-use tool call, which requests any missing permissions through `check_permissions({ prompt: true })`. Existing grants do not raise another system dialog. The requested tool still runs and reports its own capability or permission error. Linux and Windows keep eager startup: they discover the exact live `tools/list` surface and call `check_permissions({})` (the optional `prompt` parameter is not needed for this probe). If discovery fails, the extension registers `computer_use_connect` (and `/computer-use-connect`) so a later retry can install the exact live platform contract without advertising another OS's schemas.

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

The package ships a [computer-use skill](skills/computer-use/SKILL.md) for selecting existing tools, narrowing observations, checking desired state, batching known sequences and recovering uncertain actions. Pi discovers it through `pi.skills`; invoke `/skill:computer-use <task>` to load it explicitly. It adds guidance rather than another tool surface or secondary decision model.

1. `computer_use_launch_app` or `computer_use_list_apps`
2. `computer_use_get_window_state`
3. Act using `element_token`, falling back to pixels for custom-drawn surfaces
4. Re-run `computer_use_get_window_state` and verify the change
5. When the task needs more than the core toolset (browser automation,
   recording, escalated sessions, ...), call `computer_use_tools` with the
   matching group first

Linux and Windows tool descriptions and schemas come from the exact live driver. macOS uses the generated manifest for the bundled driver release.

## License

Apache-2.0 for this extension package. Bundled Cua Driver assets retain the upstream MIT license and release metadata in each platform package.

When native `tool_search` is active, the plugin hides its group-activation tool declaration and guidance from the model. Disabling `tool_search` restores that fallback. Group-activation tools are model-only management tools on native runtimes, so codemode scripts use native discovery instead. The corresponding slash command remains available in both cases; older runtimes keep the existing activation behavior.
