import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { type ComputerUseConfig, loadConfigFromFile, resolveConfig } from './config.js';
import toolManifest from './generated/cua-driver-tools.js';
import { CuaDriverClient, waitForPromise } from './mcp-client.js';
import { CORE_TOOLS, TOOL_GROUP_NAMES, TOOL_GROUPS } from './tool-groups.js';
import { type McpToolResult, toPiToolResult } from './tool-result.js';
import { createPiVisionCaller } from './vision.js';

export {
  type ConnectionState,
  CuaDriverClient,
  type DriverLayout,
  resolveBundledTarget,
  resolveDriverLayout,
  resolveUnixSocketPath,
} from './mcp-client.js';
export type { ComputerUseConfig };
export { loadConfigFromFile, resolveConfig };

const TOOL_PREFIX = 'computer_use_';

const HIGH_RISK_TOOLS = new Set([
  'browser_download',
  'browser_prepare',
  'browser_set_input_files',
  'clipboard_read',
  'clipboard_write',
  'install_ffmpeg',
  'kill_app',
  'replay_trajectory',
  'start_recording',
]);

function isInside(relativePath: string): boolean {
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

async function approvedRecordingDir(value: unknown, cwd: string): Promise<string | undefined> {
  const root = path.resolve(cwd);
  const outputDir = path.resolve(cwd, String(value ?? ''));
  const lexicalRelative = path.relative(root, outputDir);
  if (!isInside(lexicalRelative)) return undefined;

  try {
    const canonicalRoot = await realpath(root);
    let existing = outputDir;
    const suffix: string[] = [];
    for (;;) {
      const info = await lstat(existing).catch(() => undefined);
      if (info) {
        if (!info.isDirectory() && !info.isSymbolicLink()) return undefined;
        if (existing === outputDir && info.isSymbolicLink()) return undefined;
        const canonical = path.resolve(await realpath(existing), ...suffix);
        const canonicalRelative = path.relative(canonicalRoot, canonical);
        return isInside(canonicalRelative) ? canonical : undefined;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  } catch {
    return undefined;
  }
}

function permissionHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Check that Accessibility and Screen Recording permissions are granted in System Settings → Privacy & Security.';
    case 'win32':
      return 'Try running the application as Administrator, or check that UI Automation access is not blocked by security software.';
    default:
      return 'Check that the process has access to the display server (X11/Wayland) and required input permissions are configured.';
  }
}

function accessibilityHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Accessibility permission not granted. The user needs to enable it in System Settings → Privacy & Security → Accessibility, then restart the app.';
    case 'win32':
      return 'UI Automation access denied. Try running the application as Administrator.';
    default:
      return 'Input automation access denied. Check that AT-SPI or equivalent accessibility service is available.';
  }
}

function screenRecordingHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Screen Recording permission not granted. The user needs to enable it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.';
    case 'win32':
      return 'Screen capture failed. Try running the application as Administrator, or check that screen capture is not blocked by DRM or security policy.';
    default:
      return 'Screen capture failed. Check that the compositor allows screen capture (PipeWire portal or X11 access).';
  }
}

export default function computerUseExtension(pi: ExtensionAPI): void {
  let config: ComputerUseConfig | undefined;
  let client: CuaDriverClient | undefined;
  let sessionAbortController: AbortController | undefined;
  let macPermissionPromise: Promise<void> | undefined;
  const approvedLaunchApprovalKeys = new Set<string>();
  const driverToolNames = new Set<string>();

  const TOOLS_META_TOOL = `${TOOL_PREFIX}tools`;

  async function ensureConnected(
    signal?: AbortSignal,
    requestMacPermissions = true,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!client) {
      if (!config) throw new Error('pi-computer-use: session not started');
      client = new CuaDriverClient(config);
    }
    const sessionClient = client;
    const sessionSignal = sessionAbortController?.signal;
    if (!sessionSignal) throw new Error('pi-computer-use: session not started');
    sessionSignal.throwIfAborted();
    await sessionClient.ensureReady(signal);
    if (process.platform !== 'darwin' || !requestMacPermissions) return;

    sessionSignal.throwIfAborted();
    if (!macPermissionPromise) {
      const permissionPromise = sessionClient
        .callTool('check_permissions', { prompt: true }, sessionSignal)
        .then(
          () => undefined,
          () => {
            if (!sessionSignal.aborted) {
              console.error(
                '[pi-computer-use] macOS permission probe failed; requested tool will continue',
              );
            }
          },
        );
      macPermissionPromise = permissionPromise;
    }
    await waitForPromise(macPermissionPromise, signal);
    sessionSignal.throwIfAborted();
  }

  async function confirmToolCall(
    toolName: string,
    params: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    const requestedRecordingDir = params.output_dir;
    if (toolName === 'launch_app' && config?.confirmAppLaunch !== false) {
      const target = String(
        params.bundle_id ??
          params.aumid ??
          params.name ??
          params.app_name ??
          params.path ??
          params.command ??
          'unknown app',
      );
      const approvalKey = JSON.stringify(
        Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
      );
      if (approvedLaunchApprovalKeys.has(approvalKey)) return true;
      if (!ctx.hasUI) return false;
      const approved = await ctx.ui.confirm(
        'Allow computer use?',
        `Allow pi-computer-use to launch and control ${target} for this session?`,
      );
      if (approved) approvedLaunchApprovalKeys.add(approvalKey);
      return approved;
    }

    if (toolName === 'start_recording') {
      const outputDir = await approvedRecordingDir(requestedRecordingDir, ctx.cwd);
      if (!outputDir) return false;
      params.output_dir = outputDir;
    }

    if (
      toolName === 'start_recording' ||
      (HIGH_RISK_TOOLS.has(toolName) && config?.confirmDangerousActions !== false)
    ) {
      if (!ctx.hasUI) return false;
      const approved = await ctx.ui.confirm(
        'Confirm high-risk computer action',
        `Allow ${toolName} with arguments ${JSON.stringify(params)}?`,
      );
      if (!approved) return false;
      if (toolName === 'start_recording') {
        const outputDir = await approvedRecordingDir(requestedRecordingDir, ctx.cwd);
        if (!outputDir || outputDir !== params.output_dir) return false;
        params.output_dir = outputDir;
      }
      return true;
    }

    return true;
  }

  function formatGroupList(): string {
    const active = new Set(pi.getActiveTools());
    const lines = ['Computer-use tool groups:'];
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      const registered = group.tools.filter((tool) => driverToolNames.has(`${TOOL_PREFIX}${tool}`));
      const activeCount = registered.filter((tool) => active.has(`${TOOL_PREFIX}${tool}`)).length;
      const suffix =
        registered.length === 0
          ? 'unavailable until the driver is registered'
          : activeCount === 0
            ? 'inactive'
            : activeCount === registered.length
              ? 'active'
              : `${activeCount}/${registered.length} active`;
      lines.push(`- ${name} (${group.tools.length} tools, ${suffix}): ${group.summary}`);
    }
    lines.push(
      `Activate a group with ${TOOLS_META_TOOL} group=<name> or /computer-use-tools <name>.`,
    );
    return lines.join('\n');
  }

  function activateGroup(group: string): {
    activated: string[];
    total: number;
    alreadyActive: boolean;
  } {
    const definition = TOOL_GROUPS[group];
    const active = pi.getActiveTools();
    const wanted = (definition?.tools ?? [])
      .map((tool) => `${TOOL_PREFIX}${tool}`)
      .filter((name) => driverToolNames.has(name));
    const toAdd = wanted.filter((name) => !active.includes(name));
    if (toAdd.length > 0) pi.setActiveTools([...active, ...toAdd]);
    return {
      activated: wanted,
      total: definition?.tools.length ?? 0,
      alreadyActive: toAdd.length === 0 && wanted.length > 0,
    };
  }

  function applyToolProfile(): void {
    if (config?.toolProfile !== 'core') return;
    const core = new Set(CORE_TOOLS);
    pi.setActiveTools(
      pi
        .getActiveTools()
        .filter((name) => !driverToolNames.has(name) || core.has(name.slice(TOOL_PREFIX.length))),
    );
  }

  function registerToolGroupSurface(): void {
    const groupSummary = Object.entries(TOOL_GROUPS)
      .map(([name, group]) => `${name} (${group.summary})`)
      .join(', ');
    pi.registerTool({
      name: TOOLS_META_TOOL,
      label: TOOLS_META_TOOL,
      description: `List and activate additional computer-use tool groups: ${groupSummary}. Call without arguments to list groups and their activation status.`,
      parameters: Type.Object({
        group: Type.Optional(
          StringEnum(TOOL_GROUP_NAMES, {
            description: 'Tool group to activate. Omit to list available groups.',
          }),
        ),
      }),
      promptSnippet:
        'List or activate extra computer-use tool groups when the core tools are insufficient',
      promptGuidelines: [
        `Only the core computer-use tools are active by default. When a task needs browser automation, recording, escalated sessions, cursor overlay, window management, clipboard, or diagnostics capabilities, call ${TOOLS_META_TOOL} with the matching group first — the group's tools become available on the next turn.`,
      ],
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const group = typeof params.group === 'string' ? params.group : undefined;
        if (!group) {
          return {
            content: [{ type: 'text' as const, text: formatGroupList() }],
            details: undefined,
          };
        }
        if (driverToolNames.size === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Driver tools are not registered yet — connect the driver first with ${TOOL_PREFIX}connect, then activate the "${group}" group again.`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        const { activated, total, alreadyActive } = activateGroup(group);
        if (activated.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Group "${group}" has no tools registered on this platform's driver.`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `${alreadyActive ? 'Already active' : 'Activated'} group "${group}" (${activated.length}/${total} tools): ${activated.join(', ')}. These tools are available from the next turn.`,
            },
          ],
          details: undefined,
        };
      },
    });

    pi.registerCommand('computer-use-tools', {
      description: 'List or activate computer-use tool groups',
      getArgumentCompletions: (argumentPrefix) => {
        const prefix = argumentPrefix.trim().toLowerCase();
        return Object.entries(TOOL_GROUPS)
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, group]) => ({ value: name, label: name, description: group.summary }));
      },
      async handler(args, ctx) {
        const group = String(args ?? '')
          .trim()
          .toLowerCase();
        if (!group) {
          ctx.ui.notify(formatGroupList(), 'info');
          return;
        }
        if (!TOOL_GROUP_NAMES.includes(group)) {
          ctx.ui.notify(
            `pi-computer-use: unknown group "${group}". Available: ${TOOL_GROUP_NAMES.join(', ')}`,
            'warning',
          );
          return;
        }
        const { activated, alreadyActive } = activateGroup(group);
        ctx.ui.notify(
          activated.length === 0
            ? `pi-computer-use: group "${group}" has no registered tools (driver not connected?).`
            : `pi-computer-use: ${alreadyActive ? 'already active' : 'activated'} "${group}" (${activated.length} tools).`,
          'info',
        );
      },
    });
  }

  function registerTools(
    tools: ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: unknown }>,
  ): void {
    for (const tool of tools) {
      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      const originalName = tool.name;
      driverToolNames.add(prefixedName);

      pi.registerTool({
        name: prefixedName,
        label: prefixedName,
        description: tool.description ?? '',
        parameters: Type.Unsafe(tool.inputSchema as object),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          _onUpdate: unknown,
          ctx: ExtensionContext,
        ) {
          if (!(await confirmToolCall(originalName, params, ctx))) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${originalName} requires interactive user confirmation.`,
                },
              ],
              details: undefined,
              isError: true,
            };
          }

          try {
            await ensureConnected(signal, originalName !== 'check_permissions');
            const result = await client!.callTool(originalName, params, signal);

            if (result.isError) {
              const errorText = result.content?.map((c) => c.text ?? '').join('') ?? '';
              const friendlyError = formatToolError(originalName, errorText, params);
              if (friendlyError) {
                return {
                  content: [{ type: 'text' as const, text: friendlyError }],
                  details: undefined,
                  isError: true,
                };
              }
            }

            return toPiToolResult(result);
          } catch (connErr) {
            if (signal?.aborted) throw connErr;
            const msg = connErr instanceof Error ? connErr.message : String(connErr);
            ctx.ui.notify(`pi-computer-use: cannot connect to cua-driver — ${msg}`, 'warning');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to connect to cua-driver: ${msg}. ${permissionHint()}`,
                },
              ],
              details: undefined,
              isError: true,
            };
          }
        },
      });
    }
  }

  async function discoverAndRegisterTools(signal?: AbortSignal): Promise<number> {
    await ensureConnected(signal);
    const liveTools = await client!.listAllTools(signal);
    registerTools(liveTools);

    return liveTools.length;
  }

  function registerRecoverySurface(): void {
    pi.registerTool({
      name: `${TOOL_PREFIX}connect`,
      label: `${TOOL_PREFIX}connect`,
      description:
        'Retry Cua Driver startup and register the exact live tool contract for this platform.',
      parameters: Type.Object({}),
      async execute(
        _toolCallId: string,
        _params: Record<string, never>,
        signal: AbortSignal | undefined,
      ) {
        try {
          const count = await discoverAndRegisterTools(signal);
          applyToolProfile();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cua Driver connected; registered ${count} platform tools. Continue with the requested computer_use tool.`,
              },
            ],
            details: { registered_tools: count },
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          return {
            content: [{ type: 'text' as const, text: 'Cua Driver is still unavailable.' }],
            details: undefined,
            isError: true,
          };
        }
      },
    });

    pi.registerCommand('computer-use-connect', {
      description: 'Retry Cua Driver startup and discover platform tools',
      async handler(_args, ctx) {
        try {
          const count = await discoverAndRegisterTools(ctx.signal);
          applyToolProfile();
          ctx.ui.notify(`pi-computer-use: registered ${count} platform tools.`, 'info');
        } catch {
          ctx.ui.notify('pi-computer-use: Cua Driver is still unavailable.', 'warning');
        }
      },
    });
  }

  function registerVisionTool(): void {
    if (!config?.visionModel) return;
    const visionConfig = config.visionModel;

    pi.registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Capture a window through get_window_state and analyze its image using the configured vision model. Pass pid and window_id from list_windows.',
      parameters: Type.Object({
        pid: Type.Integer({ description: 'Target process ID from list_windows.' }),
        window_id: Type.Integer({
          description: 'Required CGWindowID / kCGWindowNumber to capture.',
        }),
        instruction: Type.Optional(
          Type.String({
            description:
              'What to identify or analyze visually (e.g., "Find the coordinates of the blue submit button").',
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        try {
          await ensureConnected(signal);
        } catch (connErr) {
          if (signal?.aborted) throw connErr;
          const msg = connErr instanceof Error ? connErr.message : String(connErr);
          ctx.ui.notify(`pi-computer-use: cannot connect to cua-driver — ${msg}`, 'warning');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to connect to cua-driver: ${msg}. ${permissionHint()}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }

        const screenshotArgs: Record<string, unknown> = {
          pid: params.pid,
          window_id: params.window_id,
          include_screenshot: true,
          max_elements: 1,
        };

        let screenshotResult: McpToolResult;
        try {
          screenshotResult = await client!.callTool('get_window_state', screenshotArgs, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              { type: 'text' as const, text: `Failed to capture window state: ${message}` },
            ],
            details: undefined,
            isError: true,
          };
        }
        const imageContent = screenshotResult.content?.find((c) => c.type === 'image' && c.data);

        if (process.env.DEBUG?.includes('pi-computer-use')) {
          console.error(
            '[pi-computer-use analyze_screenshot] screenshot result',
            JSON.stringify(
              {
                window_id: params.window_id,
                isError: screenshotResult.isError,
                contentTypes: screenshotResult.content?.map((c) => c.type),
                imageDataLength: imageContent?.data?.length,
                imageMimeType: imageContent?.mimeType,
              },
              null,
              2,
            ),
          );
        }

        if (!imageContent?.data) {
          const errorText =
            screenshotResult.content
              ?.filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text)
              .join('\n') || 'Failed to capture screenshot.';
          const formatted = formatToolError('get_window_state', errorText, params);
          return {
            content: [{ type: 'text' as const, text: formatted ?? errorText }],
            details: undefined,
            isError: true,
          };
        }

        const callVision = createPiVisionCaller(visionConfig, ctx);
        const instruction =
          (params.instruction as string) ??
          'Describe the full screen: identify all visible windows, UI elements, buttons, text fields, and their positions.';
        const analysis = await callVision(
          instruction,
          imageContent.data,
          imageContent.mimeType ?? 'image/png',
          signal,
        );

        if (process.env.DEBUG?.includes('pi-computer-use')) {
          console.error(
            '[pi-computer-use analyze_screenshot] vision analysis',
            JSON.stringify(
              {
                analysisLength: analysis.length,
              },
              null,
              2,
            ),
          );
        }

        return {
          content: [{ type: 'text' as const, text: analysis }],
          details: undefined,
        };
      },
    });
  }

  registerToolGroupSurface();

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(
      loadConfigFromFile({
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
      }),
    );
    client = undefined;
    sessionAbortController = new AbortController();
    macPermissionPromise = undefined;
    approvedLaunchApprovalKeys.clear();
    driverToolNames.clear();

    if (process.platform === 'darwin') {
      registerTools(toolManifest.tools);
      registerVisionTool();
      applyToolProfile();
      return;
    }

    let connectedAtStartup = false;
    try {
      await discoverAndRegisterTools(ctx.signal);
      connectedAtStartup = true;
    } catch (error) {
      registerRecoverySurface();
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[pi-computer-use] startup discovery failed (${errorName})`);
      ctx.ui.notify(
        'pi-computer-use: driver unavailable; use computer_use_connect to retry discovery.',
        'warning',
      );
    }

    registerVisionTool();
    applyToolProfile();
    if (!connectedAtStartup) return;

    try {
      const permissions = await client!.callTool(
        'check_permissions',
        { prompt: false },
        ctx.signal,
      );
      const status = permissions.structuredContent;
      if (status?.accessibility === false || status?.screen_recording === false) {
        ctx.ui.notify(`pi-computer-use: ${permissionHint()}`, 'warning');
      }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[pi-computer-use] startup probe failed (${errorName})`);
    }
  });

  pi.on('session_shutdown', async () => {
    const closingClient = client;
    const sessionAbort = sessionAbortController;
    const pendingPermission = macPermissionPromise;
    client = undefined;
    config = undefined;
    sessionAbortController = undefined;
    macPermissionPromise = undefined;
    approvedLaunchApprovalKeys.clear();
    sessionAbort?.abort(new Error('pi-computer-use: session shut down'));
    await Promise.allSettled([pendingPermission, closingClient?.close()]);
  });
}

function formatToolError(
  toolName: string,
  errorText: string,
  params: Record<string, unknown>,
): string | undefined {
  if (errorText.includes('ax_not_granted')) {
    return accessibilityHint();
  }
  if (errorText.includes('sc_not_granted')) {
    return screenRecordingHint();
  }

  if (toolName === 'get_window_state' || errorText.includes('screencapture failed')) {
    const windowId = params.window_id;
    if (windowId !== undefined) {
      if (errorText.includes('screencapture failed')) {
        return [
          `Screenshot failed for window ${windowId}. Possible causes:`,
          `1. ${screenRecordingHint()}`,
          '2. The window_id is stale — the window may have been closed or recreated (e.g. after navigation in Electron apps). Re-fetch window list to get current IDs.',
          '3. The window is minimized or not yet rendered.',
          'Re-run list_windows and retry get_window_state with the current window_id.',
        ].join('\n');
      }
      if (errorText.includes('empty output')) {
        return `Screenshot captured an empty image for window ${windowId}. The window may be minimized, fully transparent, or off-screen. Try restoring the window first.`;
      }
    } else {
      if (errorText.includes('screencapture failed')) {
        return `Screenshot failed for the main display. ${screenRecordingHint()}`;
      }
    }
  }

  return undefined;
}
