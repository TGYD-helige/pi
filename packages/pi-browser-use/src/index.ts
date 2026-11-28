import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  classifyError,
  createModelErrorCapture,
  describeToolError,
  SafeToolError,
  ValidationError,
  withAgentToolErrors,
} from '@amaster.ai/pi-shared';
import {
  isProjectTrusted,
  loadPiSettings,
  type PiSettingsOptions,
} from '@amaster.ai/pi-shared/settings';
import type { TextContent as AiTextContent } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import {
  handleAnalyzeScreenshot,
  VISUAL_SYSTEM_PROMPT,
  type VisionCaller,
} from './analyze-screenshot.js';
import {
  type BrowserSessionMode,
  type BrowserUseConfig,
  buildSubprocessEnv,
  configToArgs,
  resolveConfig,
  type VisionModelConfig,
} from './config.js';
import { prepareBrowserProfile } from './profile.js';
import { type ManagedBrowser, readBrowserSessionBinding } from './session-backend.js';
import { BrowserSessionClient } from './session-client.js';
import type { SessionAction } from './session-control.js';
import {
  BrowserSessionError,
  BrowserToolNotDispatched,
  SESSION_DESCRIPTION,
  scriptValue,
  sessionParameters,
  sessionRefusalResult,
  sessionToolResult,
} from './session-control.js';
import { augmentToolDescription } from './tool-augment.js';
import { buildGroups, CORE_TOOLS, GROUP_SUMMARIES, loadCategoryMap } from './tool-groups.js';
import { toToolContent } from './tool-result.js';

export {
  type CloudBrowserProvider,
  createBrowserAdapter,
  createCloudBrowserAdapter,
} from './adapter.js';
export type {
  BrowserAdapter,
  BrowserLifecycleAdapter,
  BrowserSessionConfig,
  HttpBrowserBackend,
  ManagedBrowser,
} from './session-backend.js';
export { createHttpBrowserAdapter, readBrowserSessionBinding } from './session-backend.js';
export { BrowserSessionClient, listBrowserSessionRecords } from './session-client.js';
export { BrowserSessionError } from './session-control.js';
export { serveBrowserSession } from './session-server.js';
export type { BrowserSessionMode, BrowserUseConfig, VisionModelConfig };
export { configToArgs, resolveConfig };

// All upstream tools are re-exported with this prefix to avoid name collisions with other extensions.
const TOOL_PREFIX = 'browser_';

const MCP_TIMEOUT_MS = 50_000;
const TOOL_WAIT_MS = 40_000;
const MCP_HEALTH_TIMEOUT_MS = 5_000;
const MCP_HEALTH_CHECK_INTERVAL_MS = 10_000;
const MCP_STDERR_LIMIT = 4_096;
const MCP_SYSTEM_ERROR_CODE_PATTERN =
  /\b(?:EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EMFILE|ENFILE|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)\b/;
const CHROME_LAUNCH_FAILURE = /^(?:Error: )?failed to launch (?:the )?(?:browser|chrome)\b/i;
const require = createRequire(import.meta.url);

// Resolved lazily at connect time so extension load does no filesystem work.
function resolveChromeDevToolsMcpEntrypoint(): string {
  const packagePath = require.resolve('chrome-devtools-mcp/package.json');
  const pkg = require(packagePath) as { bin?: Record<string, string> };
  const bin = pkg.bin?.['chrome-devtools-mcp'];
  if (!bin) {
    throw new Error('chrome-devtools-mcp package does not declare its chrome-devtools-mcp binary');
  }
  return join(dirname(packagePath), bin);
}

function requestOptions(timeout: number, signal?: AbortSignal) {
  return signal ? { signal, timeout } : { timeout };
}

function safeMcpSystemErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && value.match(MCP_SYSTEM_ERROR_CODE_PATTERN)?.[0] === value
    ? value
    : undefined;
}

function summarizeMcpFailure(stderr: string, errorName: string, errorCode?: string): string {
  const systemError =
    safeMcpSystemErrorCode(errorCode) ?? stderr.match(MCP_SYSTEM_ERROR_CODE_PATTERN)?.[0];
  if (systemError === 'EMFILE' || systemError === 'ENFILE')
    return `MCP subprocess exhausted file descriptors (${systemError}). Close unused browser sessions before retrying.`;
  if (systemError) return `MCP subprocess failed (${systemError}).`;
  if (/could not find (?:chrome|browser)/i.test(stderr)) {
    return 'Chrome executable was not found.';
  }
  if (/failed to launch (?:the )?(?:browser|chrome)/i.test(stderr)) {
    return 'Chrome failed to launch.';
  }
  if (/(?:browser|chrome).+already running|profile.+in use/i.test(stderr)) {
    return 'Chrome profile is already in use.';
  }
  const safeErrorName = [
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'TimeoutError',
    'AbortError',
  ].includes(errorName)
    ? errorName
    : 'UnknownError';
  return `MCP transport failed (${safeErrorName}).`;
}

function pageRoutingGuidance(enabled: boolean) {
  return enabled
    ? {
        promptSnippet: 'Use browser_list_pages first, then pass its numeric pageId.',
        promptGuidelines: [
          'Call browser_list_pages before page-scoped tools to obtain the current numeric pageId.',
          'Pass pageId explicitly instead of relying on shared browser_select_page state.',
          'After a timeout or recovery notice, do not replay the action. Refresh page IDs and snapshot UIDs and inspect the actual state before continuing.',
        ],
      }
    : {};
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'stalled'
  | 'closing';

/**
 * MCP client that spawns chrome-devtools-mcp as a subprocess and communicates
 * over stdio.  Owns the child-process lifecycle: connect() starts it, close() kills it.
 */
export class DevToolsClient {
  private sessionClient: BrowserSessionClient | undefined;
  private client: Client | null = null;
  private config: BrowserUseConfig;
  private state: ConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private generation = 0;
  private hasConnected = false;
  private explicitlyClosed = false;
  private lastHealthCheckAt = 0;
  private launchFailures = 0;
  private launchRetryAt = 0;

  constructor(config?: BrowserUseConfig, browser?: ManagedBrowser) {
    this.config = resolveConfig(config);
    if (browser && !this.config.session?.enabled)
      throw new Error('A runtime browser binding requires enabled browser sessions.');
    if (this.config.session?.enabled)
      this.sessionClient = new BrowserSessionClient(this.config, browser);
  }

  getState(): ConnectionState {
    if (this.sessionClient) return this.sessionClient.getState();
    return this.state;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.sessionClient) return this.sessionClient.connect(signal);
    if (this.state === 'stalled')
      throw new BrowserSessionError(
        'Browser tools are stalled. The previous action may have completed. Automatic reattachment is unavailable for this connection; inspect the original browser externally before explicitly starting another session.',
      );
    if (this.state === 'ready') return;
    if (this.connectPromise) return this.connectPromise;

    this.explicitlyClosed = false;
    this.connectPromise = this.openConnection(signal);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async openConnection(signal?: AbortSignal): Promise<void> {
    this.state = this.hasConnected ? 'reconnecting' : 'connecting';
    const args = configToArgs(this.config);
    const generation = ++this.generation;

    let client: Client | null = null;
    let stderr = '';
    let transportErrorCode: string | undefined;

    try {
      // Imported lazily: the MCP SDK is heavy and only needed once a session actually connects.
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
      ]);

      const transport = new StdioClientTransport({
        command: process.env.PI_BROWSER_USE_NODE?.trim() || process.execPath,
        // SDK types omit the undefined values Node supports for overriding inherited defaults.
        env: buildSubprocessEnv(
          process.env,
          this.config.envAllowlist,
          this.config.envBlocklist,
        ) as Record<string, string>,
        args: [resolveChromeDevToolsMcpEntrypoint(), ...args],
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-MCP_STDERR_LIMIT);
      });

      client = new Client({ name: 'pi-browser-use', version: '0.1.0' }, { capabilities: {} });
      this.client = client;

      transport.onerror = (error: Error) => {
        if (generation !== this.generation) return;
        transportErrorCode = safeMcpSystemErrorCode((error as Error & { code?: unknown }).code);
        console.error(
          `[pi-browser-use] chrome-devtools-mcp transport error (${transportErrorCode ?? classifyError(error).errorCategory})`,
        );
        void this.disconnectUnhealthyClient(generation);
      };
      transport.onclose = () => this.markDisconnected(generation);

      await client.connect(transport, requestOptions(MCP_TIMEOUT_MS, signal));
      if (generation !== this.generation) return;
      this.state = 'ready';
      this.hasConnected = true;
      this.lastHealthCheckAt = Date.now();
    } catch (error) {
      if (generation === this.generation) {
        ++this.generation;
        this.client = null;
        this.state = 'failed';
      }
      try {
        await client?.close();
      } catch {
        // The failed transport may already be closed.
      }
      if (signal?.aborted) throw error;
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const errorCode =
        error instanceof Error
          ? safeMcpSystemErrorCode((error as Error & { code?: unknown }).code)
          : undefined;
      const diagnostic = summarizeMcpFailure(stderr, errorName, transportErrorCode ?? errorCode);
      console.error(`[pi-browser-use] browser connection failed: ${diagnostic}`);
      throw new SafeToolError('Browser connection', error, diagnostic);
    }
  }

  private markDisconnected(generation: number): void {
    if (generation !== this.generation || this.state === 'closing' || this.state === 'stalled')
      return;
    ++this.generation;
    this.client = null;
    this.state = 'disconnected';
  }

  private async disconnectUnhealthyClient(generation: number): Promise<void> {
    if (generation !== this.generation || this.state === 'closing' || this.state === 'stalled')
      return;
    const failedClient = this.client;
    this.markDisconnected(generation);
    if (!failedClient) return;

    try {
      await failedClient.close();
    } catch {
      console.error('[pi-browser-use] failed to close unhealthy MCP client');
    }
  }

  async ping(signal?: AbortSignal): Promise<boolean> {
    if (this.sessionClient) {
      if (this.sessionClient.getState() !== 'ready') return false;
      try {
        const status = await this.sessionClient.control('status', signal);
        return (
          this.sessionClient.getState() === 'ready' &&
          'state' in status &&
          ['idle', 'active', 'retained'].includes(String(status.state)) &&
          'toolState' in status &&
          status.toolState === 'ready'
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        return false;
      }
    }
    if (this.state !== 'ready' || !this.client) return false;

    const generation = this.generation;
    try {
      await this.client.ping(requestOptions(MCP_HEALTH_TIMEOUT_MS, signal));
      if (generation !== this.generation) return false;
      this.lastHealthCheckAt = Date.now();
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.disconnectUnhealthyClient(generation);
      return false;
    }
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.sessionClient) return this.sessionClient.connect(signal);
    if (this.explicitlyClosed) throw new BrowserSessionError('Client not connected.');

    if (this.state === 'ready') {
      const healthCheckIsFresh = Date.now() - this.lastHealthCheckAt < MCP_HEALTH_CHECK_INTERVAL_MS;
      if (healthCheckIsFresh || (await this.ping(signal))) return;
    }

    await this.connect(signal);
  }

  async listAllTools(signal?: AbortSignal): Promise<Tool[]> {
    signal?.throwIfAborted();
    if (this.sessionClient) {
      const { session: _session, ...config } = this.config;
      const discovery = new DevToolsClient(config);
      try {
        return await discovery.listAllTools(signal);
      } finally {
        await discovery.close();
      }
    }
    await this.ensureReady(signal);
    const client = this.client;
    if (!client) throw new Error('Client not connected');

    const allTools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        requestOptions(MCP_TIMEOUT_MS, signal),
      );
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  }> {
    if (this.sessionClient) return this.sessionClient.callTool(name, args, signal);
    signal?.throwIfAborted();
    if (this.launchRetryAt > Date.now())
      throw new BrowserSessionError(
        'This browser tool was not sent. Wait for the local Chrome launch backoff before retrying.',
        undefined,
        'browser_launch_backoff',
      );
    const callerSignal = signal;
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(MCP_TIMEOUT_MS)]);
    let client: Client;
    try {
      signal.throwIfAborted();
      await this.ensureReady(signal);
      signal.throwIfAborted();
      if (!this.client) throw new BrowserSessionError('Client not connected.');
      client = this.client;
    } catch (error) {
      callerSignal?.throwIfAborted();
      throw new BrowserToolNotDispatched(error);
    }
    if (['navigate_page', 'new_page', 'wait_for'].includes(name)) {
      const timeout = args.timeout;
      if (
        timeout === undefined ||
        (typeof timeout === 'number' && (timeout === 0 || timeout > TOOL_WAIT_MS))
      )
        args = { ...args, timeout: TOOL_WAIT_MS };
    }

    try {
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        requestOptions(MCP_TIMEOUT_MS, signal),
      )) as {
        content?: Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
        }>;
        isError?: boolean;
      };
      if (!this.config.wsEndpoint && !this.config.browserUrl && !this.config.autoConnect) {
        if (!result.isError) {
          this.launchFailures = 0;
          this.launchRetryAt = 0;
        } else if (
          result.content?.some(
            (item) =>
              item.type === 'text' && CHROME_LAUNCH_FAILURE.test(item.text?.slice(0, 128) ?? ''),
          )
        ) {
          this.launchFailures = Math.min(this.launchFailures + 1, 8);
          if (this.launchFailures >= 3)
            this.launchRetryAt =
              Date.now() + Math.min(30_000, 1000 * 2 ** (this.launchFailures - 3));
        }
      }
      return result;
    } catch (error) {
      if (
        !this.explicitlyClosed &&
        (this.client === client || !this.client) &&
        (signal.aborted || classifyError(error).errorCategory === 'timeout')
      ) {
        this.state = 'stalled';
        console.error(
          '[pi-browser-use] browser tool execution stalled; recovery required (phase=tool)',
        );
      }
      if (signal.aborted) throw error;
      if ((this.state !== 'ready' && this.state !== 'stalled') || this.client !== client) {
        throw new SafeToolError(
          'Browser tool call',
          error,
          'The browser connection was lost. The action may have completed; inspect the current page before retrying.',
        );
      }
      const failure = new SafeToolError(
        'Browser tool call',
        error,
        'The action may have completed. Inspect the current page before retrying.',
      );
      console.error(
        `[pi-browser-use] upstream tool call failed (category=${failure.errorCategory})`,
      );
      throw failure;
    }
  }

  /** Cleanup must keep the original MCP connection and its page IDs. */
  async removeSessionMarker(pageId: number, nonce: string, signal: AbortSignal): Promise<void> {
    const client = this.client;
    if (this.state !== 'ready' || !client)
      throw new BrowserSessionError('The marker connection is no longer available.');
    const pages = CallToolResultSchema.parse(
      await client.callTool(
        { name: 'list_pages', arguments: {} },
        undefined,
        requestOptions(MCP_TIMEOUT_MS, signal),
      ),
    );
    const pageList = pages.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (pages.isError || (pageList.match(/^\d+: /gm)?.length ?? 0) < 2)
      throw new BrowserSessionError('Cannot safely remove the last browser page.');
    const result = await client.callTool(
      {
        name: 'evaluate_script',
        arguments: {
          pageId,
          function: `() => { if (globalThis.__piBrowserRetention !== ${JSON.stringify(nonce)}) return false; window.close(); return window.closed; }`,
        },
      },
      undefined,
      requestOptions(MCP_TIMEOUT_MS, signal),
    );
    if (scriptValue(result) !== true)
      throw new BrowserSessionError('The original browser marker could not be removed.');
  }

  async close(): Promise<void> {
    if (this.sessionClient) return this.sessionClient.close();
    if (this.explicitlyClosed) return;
    this.explicitlyClosed = true;
    this.state = 'closing';
    const client = this.client;
    ++this.generation;
    this.client = null;
    try {
      if (client) await client.close();
    } finally {
      this.state = 'disconnected';
    }
  }

  async sessionControl(action: SessionAction, signal?: AbortSignal): Promise<object> {
    if (!this.sessionClient) throw new Error('Browser session retention is not configured.');
    return this.sessionClient.control(action, signal);
  }
}

/** Read pi-browser-use settings, including the project layer only when trusted. */
function loadConfigFromFile(options?: PiSettingsOptions): BrowserUseConfig {
  const config = loadPiSettings<BrowserUseConfig>('pi-browser-use', {
    ...options,
  });
  // Management credentials and executable adapters are host/user configuration only.
  const session = loadPiSettings<BrowserUseConfig>('pi-browser-use', {
    ...options,
    projectTrusted: false,
  }).session;
  if (session) config.session = session;
  else delete config.session;
  return config;
}

/**
 * pi-coding-agent extension entry point.
 *
 * On session_start: spawns chrome-devtools-mcp, discovers upstream tools,
 * and registers each one via pi.registerTool() with a "browser_" prefix.
 * On session_shutdown: tears down the subprocess.
 *
 * Config is loaded from config.json["pi-browser-use"] in the working directory.
 * If visionModel is configured, an additional analyze_screenshot tool is registered.
 */
export default function browserUseExtension(pi: ExtensionAPI): void {
  const registerTool = (tool: ToolDefinition) =>
    pi.registerTool({
      ...tool,
      execute: withAgentToolErrors(
        tool,
        pi,
        'pi-browser-use',
        'The action may have completed. Inspect the current page before retrying.',
      ),
    });

  let config: BrowserUseConfig | undefined;
  let client: DevToolsClient | undefined;
  const upstreamToolNames = new Set<string>();
  let toolGroups = new Map<string, string[]>();

  const TOOLS_META_TOOL = `${TOOL_PREFIX}tools`;

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    if (!client) {
      throw new BrowserToolNotDispatched(
        new BrowserSessionError('The browser session is unavailable.'),
      );
    }
    try {
      await client.ensureReady(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BrowserToolNotDispatched(error);
    }
  }

  function formatGroupList(): string {
    const active = new Set(pi.getActiveTools());
    const lines = ['Browser tool groups:'];
    for (const [name, tools] of toolGroups) {
      const activeCount = tools.filter((tool) => active.has(`${TOOL_PREFIX}${tool}`)).length;
      const suffix =
        activeCount === 0
          ? 'inactive'
          : activeCount === tools.length
            ? 'active'
            : `${activeCount}/${tools.length} active`;
      lines.push(
        `- ${name} (${tools.length} tools, ${suffix}): ${GROUP_SUMMARIES[name] ?? GROUP_SUMMARIES.other}`,
      );
    }
    lines.push(`Activate a group with ${TOOLS_META_TOOL} group=<name> or /browser-tools <name>.`);
    return lines.join('\n');
  }

  function activateGroup(group: string): { activated: string[]; alreadyActive: boolean } {
    const wanted = (toolGroups.get(group) ?? []).map((tool) => `${TOOL_PREFIX}${tool}`);
    const active = pi.getActiveTools();
    const toAdd = wanted.filter((name) => !active.includes(name));
    if (toAdd.length > 0) pi.setActiveTools([...active, ...toAdd]);
    return { activated: wanted, alreadyActive: toAdd.length === 0 && wanted.length > 0 };
  }

  function applyToolProfile(): void {
    if (config?.slim || (config?.toolProfile !== 'core' && config?.toolProfile !== 'lazy')) return;
    const core = new Set(CORE_TOOLS);
    pi.setActiveTools(
      pi
        .getActiveTools()
        .filter((name) => !upstreamToolNames.has(name) || core.has(name.slice(TOOL_PREFIX.length))),
    );
  }

  function registerToolGroupSurface(): void {
    registerTool({
      name: TOOLS_META_TOOL,
      exposure: 'model-only',
      label: TOOLS_META_TOOL,
      description:
        'List and activate additional browser tool groups (derived from chrome-devtools-mcp categories: input, navigation, debugging, network, emulation, memory, performance, ...). Call without arguments to list groups and their activation status.',
      parameters: Type.Object({
        group: Type.Optional(
          Type.String({ description: 'Tool group to activate. Omit to list available groups.' }),
        ),
      }),
      promptSnippet:
        'List or activate extra browser tool groups when the core tools are insufficient',
      promptGuidelines: [
        `Only the core browser tools are active by default. When a task needs network inspection, console details, emulation, heap snapshots, or performance tracing, call ${TOOLS_META_TOOL} with the matching group first — the group's tools become available on the next turn.`,
      ],
      prepareLoadout: (loadout) =>
        loadout.declared.some((tool) => tool.name === 'tool_search')
          ? { hiddenDeclarations: [TOOLS_META_TOOL] }
          : undefined,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ) {
        const discoveryError = await retryDiscovery(signal);
        if (discoveryError) {
          return {
            content: [{ type: 'text' as const, text: discoveryError }],
            details: undefined,
            isError: true,
          };
        }
        const group = typeof params.group === 'string' ? params.group : undefined;
        if (!group) {
          return {
            content: [{ type: 'text' as const, text: formatGroupList() }],
            details: undefined,
          };
        }
        if (!toolGroups.has(group)) {
          const available = [...toolGroups.keys()];
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  available.length === 0
                    ? 'No browser tool groups available — the browser bridge is not connected yet.'
                    : `Unknown group "${group}". Available: ${available.join(', ')}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        const { activated, alreadyActive } = activateGroup(group);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${alreadyActive ? 'Already active' : 'Activated'} group "${group}" (${activated.length} tools): ${activated.join(', ')}. These tools are available from the next turn.`,
            },
          ],
          details: undefined,
        };
      },
    });

    pi.registerCommand('browser-tools', {
      description: 'List or activate browser tool groups',
      getArgumentCompletions: (argumentPrefix) => {
        const prefix = argumentPrefix.trim().toLowerCase();
        return [...toolGroups.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({
            value: name,
            label: name,
            description: GROUP_SUMMARIES[name] ?? GROUP_SUMMARIES.other ?? '',
          }));
      },
      async handler(args, ctx) {
        const discoveryError = await retryDiscovery(ctx.signal);
        if (discoveryError) {
          ctx.ui.notify(discoveryError, 'error');
          return;
        }
        const group = String(args ?? '')
          .trim()
          .toLowerCase();
        if (!group) {
          ctx.ui.notify(formatGroupList(), 'info');
          return;
        }
        if (!toolGroups.has(group)) {
          ctx.ui.notify(
            `pi-browser-use: unknown group "${group}". Available: ${[...toolGroups.keys()].join(', ') || '(none — browser not connected)'}`,
            'warning',
          );
          return;
        }
        const { activated, alreadyActive } = activateGroup(group);
        ctx.ui.notify(
          `pi-browser-use: ${alreadyActive ? 'already active' : 'activated'} "${group}" (${activated.length} tools).`,
          'info',
        );
      },
    });
  }

  let discovery: Promise<void> | undefined;

  /** Register upstream tools and groups; concurrent callers share one attempt. */
  function discoverUpstreamTools(signal?: AbortSignal): Promise<void> {
    if (discovery) return discovery;
    const attempt = (async () => {
      await registerUpstreamTools(signal);
      toolGroups = buildGroups(
        [...upstreamToolNames].map((name) => name.slice(TOOL_PREFIX.length)),
        await loadCategoryMap(),
      );
      applyToolProfile();
    })().finally(() => {
      if (discovery === attempt) discovery = undefined;
    });
    discovery = attempt;
    return attempt;
  }

  /** Retry discovery when no groups exist; returns a safe message on failure. */
  async function retryDiscovery(signal?: AbortSignal): Promise<string | undefined> {
    if (toolGroups.size > 0) return;
    try {
      await discoverUpstreamTools(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = describeToolError(
        'Browser tool discovery',
        error,
        'Check that Chrome and chrome-devtools-mcp can start, then retry.',
      );
      console.error(`[pi-browser-use] tool discovery failed (category=${failure.errorCategory})`);
      return failure.error;
    }
  }

  async function registerUpstreamTools(signal?: AbortSignal): Promise<void> {
    // Inspect the host, since the extension's installed peer can be a different version.
    const nativeDiscovery = pi.getAllTools?.().some((tool) => 'exposure' in tool) ?? false;
    if (!client) throw new BrowserSessionError('The browser session is unavailable.');
    const upstreamTools = await client.listAllTools(signal);

    for (const tool of upstreamTools) {
      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      const originalName = tool.name;
      upstreamToolNames.add(prefixedName);
      const description = augmentToolDescription(originalName, tool.description ?? '');
      const routingGuidance = pageRoutingGuidance(
        tool.inputSchema.required?.includes('pageId') ?? false,
      );

      let exposure: 'direct' | 'deferred';
      if (config?.slim || config?.toolProfile === 'full') {
        exposure = 'direct';
      } else if (config?.toolProfile === 'lazy') {
        exposure = 'deferred';
      } else {
        exposure = CORE_TOOLS.includes(originalName) ? 'direct' : 'deferred';
      }

      registerTool({
        name: prefixedName,
        label: prefixedName,
        ...(nativeDiscovery
          ? {
              namespace: {
                name: 'browser',
                aliases: ['browser_use'],
                description: 'Browser automation',
              },
              exposure,
            }
          : {}),
        description,
        ...routingGuidance,
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          try {
            await ensureConnected(signal);
            const result = await client!.callTool(originalName, params, signal);
            return { ...toToolContent(result, originalName), details: undefined };
          } catch (error) {
            if (signal?.aborted) throw error;
            const refusal = sessionRefusalResult(error);
            if (!refusal) throw error;
            return { ...refusal, details: undefined };
          }
        },
      });
    }
  }

  /** Create a VisionCaller that sends requests through the model registry. */
  function createPiVisionCaller(
    visionConfig: VisionModelConfig,
    ctx: ExtensionContext,
  ): VisionCaller {
    return async (
      instruction: string,
      imageBase64: string,
      mimeType: string,
      signal?: AbortSignal,
    ): Promise<string> => {
      signal?.throwIfAborted();
      // Imported lazily: pi-ai is heavy and only needed when a vision call actually runs.
      const { completeModelRequest } = await import('@amaster.ai/pi-shared/models');
      signal?.throwIfAborted();
      const model = ctx.modelRegistry.find(visionConfig.provider, visionConfig.model);
      if (!model) {
        throw new ValidationError(
          'Vision model not found in model registry. Check the configured provider/model.',
          'configuration_error',
        );
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      signal?.throwIfAborted();
      if (!auth.ok) {
        throw new ValidationError(
          'Auth failed for vision model: credentials are unavailable. Check the vision model credentials.',
          'configuration_error',
        );
      }

      const modelErrors = createModelErrorCapture();
      const result = await completeModelRequest(
        ctx.modelRegistry,
        model,
        {
          systemPrompt: VISUAL_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user' as const,
              content: [
                {
                  type: 'text' as const,
                  text: `Analyze this screenshot and respond to the following instruction:\n\n${instruction}`,
                },
                { type: 'image' as const, data: imageBase64, mimeType },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 2048, ...(signal ? { signal } : {}), ...modelErrors.fetchOptions(model.api) },
        auth,
      );

      signal?.throwIfAborted();
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw modelErrors.error(
          'Vision model request',
          result,
          'Use accessibility tree elements instead.',
        );
      }

      const analysis = result.content
        .filter((c): c is AiTextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (!analysis.trim())
        throw new ValidationError(
          'Vision model returned no analysis. Use accessibility tree elements instead.',
          'invalid_response',
        );
      return analysis;
    };
  }

  async function registerVisionTool(visionConfig: VisionModelConfig): Promise<void> {
    const routingGuidance = pageRoutingGuidance(config?.experimentalPageIdRouting === true);
    const pageIdParameter = config?.experimentalPageIdRouting
      ? {
          pageId: Type.Number({
            description: 'Numeric page ID returned by browser_list_pages.',
          }),
        }
      : {};

    registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Analyze the current page visually using a screenshot. Use when you need to identify elements by visual attributes (color, layout, position) not available in the accessibility tree, or when you need precise pixel coordinates for click_at.',
      ...routingGuidance,
      parameters: Type.Object({
        ...pageIdParameter,
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
        if (!client) throw new BrowserSessionError('The browser session is unavailable.');
        const callVision = createPiVisionCaller(visionConfig, ctx);
        const result = await handleAnalyzeScreenshot(client, callVision, params, signal);
        const content: Array<{ type: 'text'; text: string }> = [];
        if (result.content) {
          for (const item of result.content) {
            if (item.type === 'text' && item.text) {
              content.push({ type: 'text', text: item.text });
            }
          }
        }
        if (content.length === 0) {
          content.push({ type: 'text', text: '' });
        }
        return result.isError
          ? {
              content,
              isError: true,
              details: undefined,
              ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
            }
          : { content, details: undefined };
      },
    });
  }

  registerToolGroupSurface();
  function registerSessionSurface() {
    registerTool({
      name: 'browser_session',
      label: 'Browser session',
      description: SESSION_DESCRIPTION,
      promptSnippet:
        'Inspect a session without attaching, or retain the original page for a human handoff.',
      promptGuidelines: [
        'Use browser_session retain before a human handoff and release when complete. Release disconnects parking-enabled sessions.',
        'After reattachment, call browser_list_pages and take a fresh snapshot before using element UIDs.',
      ],
      parameters: sessionParameters,
      prepareLoadout: () =>
        config?.session?.enabled ? undefined : { hiddenDeclarations: ['browser_session'] },
      async execute(_id, params, signal) {
        return sessionToolResult(
          (params as { action: string }).action,
          config?.session?.enabled && client
            ? (action, callerSignal) => client!.sessionControl(action, callerSignal)
            : undefined,
          signal,
        );
      },
    });
    pi.registerCommand('browser-session', {
      description: 'Retain, inspect, or release the current browser session',
      async handler(args, ctx) {
        const result = await sessionToolResult(
          args.trim() || 'status',
          config?.session?.enabled && client
            ? (action, signal) => client!.sessionControl(action, signal)
            : undefined,
          ctx.signal,
        );
        ctx.ui.notify(result.content[0]!.text, result.isError ? 'warning' : 'info');
      },
    });
  }

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(
      loadConfigFromFile({
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
      }),
    );
    if (!config.session?.enabled) prepareBrowserProfile(config);
    client = new DevToolsClient(config, readBrowserSessionBinding(config));
    if (config.session?.enabled) registerSessionSurface();
    else pi.setActiveTools(pi.getActiveTools().filter((name) => name !== 'browser_session'));
    upstreamToolNames.clear();
    toolGroups = new Map();
    discovery = undefined;
    try {
      await discoverUpstreamTools(ctx.signal);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      console.error(
        `[pi-browser-use] startup discovery failed (category=${classifyError(error).errorCategory})`,
      );
      ctx.ui.notify(
        `pi-browser-use: browser bridge unavailable; ${TOOLS_META_TOOL} or /browser-tools retries discovery.`,
        'warning',
      );
    }
    if (config.visionModel) {
      await registerVisionTool(config.visionModel);
    }
  });

  pi.on('session_shutdown', async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
  });
}
