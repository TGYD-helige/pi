import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  isProjectTrusted,
  loadPiSettings,
  type PiSettingsOptions,
} from '@amaster.ai/pi-shared/settings';
import type { TextContent as AiTextContent } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import {
  handleAnalyzeScreenshot,
  VISUAL_SYSTEM_PROMPT,
  type VisionCaller,
} from './analyze-screenshot.js';
import {
  type BrowserSessionMode,
  type BrowserUseConfig,
  configToArgs,
  resolveConfig,
  type VisionModelConfig,
} from './config.js';
import { prepareBrowserProfile } from './profile.js';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from './tool-augment.js';
import { buildGroups, CORE_TOOLS, GROUP_SUMMARIES, loadCategoryMap } from './tool-groups.js';

export type { BrowserSessionMode, BrowserUseConfig, VisionModelConfig };
export { configToArgs, resolveConfig };

// All upstream tools are re-exported with this prefix to avoid name collisions with other extensions.
const TOOL_PREFIX = 'browser_';

const MCP_TIMEOUT_MS = 60_000;
const MCP_HEALTH_TIMEOUT_MS = 5_000;
const MCP_HEALTH_CHECK_INTERVAL_MS = 10_000;
const MCP_STDERR_LIMIT = 4_096;
const MCP_SYSTEM_ERROR_CODE_PATTERN =
  /^(?:EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)$/;
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
  return typeof value === 'string' && MCP_SYSTEM_ERROR_CODE_PATTERN.test(value) ? value : undefined;
}

function summarizeMcpFailure(stderr: string, errorName: string, errorCode?: string): string {
  const systemError =
    safeMcpSystemErrorCode(errorCode) ??
    stderr.match(
      /\b(EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)\b/,
    )?.[1];
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
  const safeErrorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(errorName) ? errorName : 'UnknownError';
  return `MCP transport failed (${safeErrorName}).`;
}

function pageRoutingGuidance(enabled: boolean) {
  return enabled
    ? {
        promptSnippet: 'Use browser_list_pages first, then pass its numeric pageId.',
        promptGuidelines: [
          'Call browser_list_pages before page-scoped tools to obtain the current numeric pageId.',
          'Pass pageId explicitly instead of relying on shared browser_select_page state.',
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
  | 'closing';

/**
 * MCP client that spawns chrome-devtools-mcp as a subprocess and communicates
 * over stdio.  Owns the child-process lifecycle: connect() starts it, close() kills it.
 */
export class DevToolsClient {
  private client: Client | null = null;
  private config: BrowserUseConfig;
  private state: ConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private generation = 0;
  private hasConnected = false;
  private explicitlyClosed = false;
  private lastHealthCheckAt = 0;

  constructor(config?: BrowserUseConfig) {
    this.config = resolveConfig(config);
  }

  getState(): ConnectionState {
    return this.state;
  }

  async connect(signal?: AbortSignal): Promise<void> {
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
        // SDK default env strips display/proxy vars a headful Chrome needs.
        env: process.env as Record<string, string>,
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
          `[pi-browser-use] chrome-devtools-mcp transport error (${transportErrorCode ?? error.name})`,
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
      throw new Error(`Browser connection failed. ${diagnostic}`);
    }
  }

  private markDisconnected(generation: number): void {
    if (generation !== this.generation || this.state === 'closing') return;
    ++this.generation;
    this.client = null;
    this.state = 'disconnected';
  }

  private async disconnectUnhealthyClient(generation: number): Promise<void> {
    if (generation !== this.generation || this.state === 'closing') return;
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
    if (this.explicitlyClosed) throw new Error('Client not connected');

    if (this.state === 'ready') {
      const healthCheckIsFresh = Date.now() - this.lastHealthCheckAt < MCP_HEALTH_CHECK_INTERVAL_MS;
      if (healthCheckIsFresh || (await this.ping(signal))) return;
    }

    await this.connect(signal);
  }

  async listAllTools(signal?: AbortSignal): Promise<Tool[]> {
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
    await this.ensureReady(signal);
    const client = this.client;
    if (!client) throw new Error('Client not connected');

    try {
      return (await client.callTool(
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
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.state !== 'ready' || this.client !== client) {
        throw new Error('Browser connection lost; retry the tool.');
      }
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[pi-browser-use] upstream tool call failed (${errorName})`);
      throw new Error('Browser tool call failed.');
    }
  }

  async close(): Promise<void> {
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
}

/** Read pi-browser-use settings, including the project layer only when trusted. */
function loadConfigFromFile(options?: PiSettingsOptions): BrowserUseConfig {
  return loadPiSettings<BrowserUseConfig>('pi-browser-use', {
    ...options,
  });
}

/** Convert upstream MCP result into pi-agent content, applying text post-processing. */
function toToolContent(
  result: {
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  },
  originalName: string,
): {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
} {
  const textContent = extractTextContent(result.content);
  const processed = postProcessToolResult(originalName, textContent);

  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  > = [];

  if (processed !== textContent) {
    content.push({ type: 'text', text: processed });
  } else if (result.content) {
    for (const item of result.content) {
      if (item.type === 'text' && item.text) {
        content.push({ type: 'text', text: item.text });
      }
    }
  }

  if (result.content) {
    for (const item of result.content) {
      if (item.type === 'image' && item.data) {
        content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return result.isError ? { content, isError: true } : { content };
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
  let config: BrowserUseConfig | undefined;
  let client: DevToolsClient | undefined;
  const upstreamToolNames = new Set<string>();
  let toolGroups = new Map<string, string[]>();

  const TOOLS_META_TOOL = `${TOOL_PREFIX}tools`;

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    if (!client) throw new Error('browser-use: session not started');
    await client.ensureReady(signal);
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
    if (config?.slim || config?.toolProfile !== 'core') return;
    const core = new Set(CORE_TOOLS);
    pi.setActiveTools(
      pi
        .getActiveTools()
        .filter((name) => !upstreamToolNames.has(name) || core.has(name.slice(TOOL_PREFIX.length))),
    );
  }

  function registerToolGroupSurface(): void {
    pi.registerTool({
      name: TOOLS_META_TOOL,
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
      async execute(_toolCallId: string, params: Record<string, unknown>) {
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

  async function registerUpstreamTools(): Promise<void> {
    await ensureConnected();
    const upstreamTools = await client!.listAllTools();

    for (const tool of upstreamTools) {
      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      const originalName = tool.name;
      upstreamToolNames.add(prefixedName);
      const description = augmentToolDescription(originalName, tool.description ?? '');
      const routingGuidance = pageRoutingGuidance(
        tool.inputSchema.required?.includes('pageId') ?? false,
      );

      pi.registerTool({
        name: prefixedName,
        label: prefixedName,
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
          await ensureConnected(signal);
          const result = await client!.callTool(originalName, params, signal);
          const toolContent = toToolContent(result, originalName);
          return { ...toolContent, details: undefined };
        },
      });
    }
  }

  /** Create a VisionCaller that uses pi-ai's complete() with the model registry. */
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
      // Imported lazily: pi-ai is heavy and only needed when a vision call actually runs.
      const { complete } = await import('@earendil-works/pi-ai/compat');
      const model = ctx.modelRegistry.find(visionConfig.provider, visionConfig.model);
      if (!model) {
        throw new Error(
          `Vision model "${visionConfig.provider}/${visionConfig.model}" not found in model registry.`,
        );
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(`Auth failed for vision model: ${auth.error}`);
      }

      const options: Record<string, unknown> = {
        maxTokens: 2048,
      };
      if (auth.apiKey) options.apiKey = auth.apiKey;
      if (auth.headers) options.headers = auth.headers;
      if (signal) options.signal = signal;

      const result = await complete(
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
        options,
      );

      if (result.stopReason === 'error') {
        throw new Error(result.errorMessage || 'Vision model request failed');
      }

      return result.content
        .filter((c): c is AiTextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
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

    pi.registerTool({
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
        await ensureConnected(signal);
        const callVision = createPiVisionCaller(visionConfig, ctx);
        const result = await handleAnalyzeScreenshot(client!, callVision, params, signal);
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
          ? { content, isError: true, details: undefined }
          : { content, details: undefined };
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
    prepareBrowserProfile(config);
    client = new DevToolsClient(config);
    upstreamToolNames.clear();
    toolGroups = new Map();
    await registerUpstreamTools();
    toolGroups = buildGroups(
      [...upstreamToolNames].map((name) => name.slice(TOOL_PREFIX.length)),
      await loadCategoryMap(),
    );
    if (config.visionModel) {
      await registerVisionTool(config.visionModel);
    }
    applyToolProfile();
  });

  pi.on('session_shutdown', async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
  });
}
