import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createSourceObservationReceipt } from '@amaster.ai/pi-shared';
import {
  isProjectTrusted,
  loadPiSettings,
  type PiSettingsOptions,
} from '@amaster.ai/pi-shared/settings';
import type { TextContent as AiTextContent } from '@earendil-works/pi-ai';
import { complete } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import {
  handleAnalyzeScreenshot,
  VISUAL_SYSTEM_PROMPT,
  type VisionCaller,
} from './analyze-screenshot.js';
import { type BrowserReadSession, startBrowserReadSession } from './browser-read-session.js';
import {
  type BrowserReadPolicyV1,
  type BrowserSessionMode,
  type BrowserUseConfig,
  configToArgs,
  resolveConfig,
  type VisionModelConfig,
} from './config.js';
import { prepareBrowserProfile } from './profile.js';
import { assertBrowserReadNavigation } from './read-policy.js';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from './tool-augment.js';

export { assertBrowserReadNavigation, assertBrowserReadSubresource } from './read-policy.js';
export type { BrowserReadPolicyV1, BrowserSessionMode, BrowserUseConfig, VisionModelConfig };
export { configToArgs, resolveConfig };

// All upstream tools are re-exported with this prefix to avoid name collisions with other extensions.
const TOOL_PREFIX = 'browser_';

// These upstream tools are noisy or slow; skip them during registration.
const EXCLUDED_TOOLS = new Set([
  'lighthouse_audit',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'screencast_start',
  'screencast_stop',
  'install_extension',
  'list_extensions',
  'reload_extension',
  'trigger_extension_action',
  'uninstall_extension',
]);
const READ_POLICY_TOOLS = new Set([
  'list_pages',
  'navigate_page',
  'take_snapshot',
  'take_screenshot',
  'wait_for',
]);

const MCP_TIMEOUT_MS = 60_000;
const MCP_HEALTH_TIMEOUT_MS = 5_000;
const MCP_HEALTH_CHECK_INTERVAL_MS = 10_000;
const MCP_STDERR_LIMIT = 4_096;
const MCP_SYSTEM_ERROR_CODE_PATTERN =
  /^(?:EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)$/;
const require = createRequire(import.meta.url);
const chromeDevToolsMcpPackagePath = require.resolve('chrome-devtools-mcp/package.json');
const chromeDevToolsMcpPackage = require(chromeDevToolsMcpPackagePath) as {
  bin?: Record<string, string>;
};
const chromeDevToolsMcpBin = chromeDevToolsMcpPackage.bin?.['chrome-devtools-mcp'];
if (!chromeDevToolsMcpBin) {
  throw new Error('chrome-devtools-mcp package does not declare its chrome-devtools-mcp binary');
}
const CHROME_DEVTOOLS_MCP_ENTRYPOINT = join(
  dirname(chromeDevToolsMcpPackagePath),
  chromeDevToolsMcpBin,
);

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

    const transport = new StdioClientTransport({
      command: process.env.PI_BROWSER_USE_NODE?.trim() || process.execPath,
      args: [CHROME_DEVTOOLS_MCP_ENTRYPOINT, ...args],
      stderr: 'pipe',
    });
    let stderr = '';
    let transportErrorCode: string | undefined;
    transport.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MCP_STDERR_LIMIT);
    });

    const client = new Client({ name: 'pi-browser-use', version: '0.1.0' }, { capabilities: {} });
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

    try {
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
        await client.close();
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
  const runtimePolicy = process.env.PI_BROWSER_USE_RUNTIME_READ_POLICY;
  if (runtimePolicy !== undefined && runtimePolicy !== 'required') {
    throw new Error('PI_BROWSER_USE_RUNTIME_READ_POLICY is invalid.');
  }
  const settingsOptions: PiSettingsOptions = { ...options };
  if (runtimePolicy === 'required') settingsOptions.projectTrusted = false;
  const config = loadPiSettings<BrowserUseConfig>('pi-browser-use', settingsOptions);
  if (runtimePolicy === 'required' && !config.readPolicy) {
    throw new Error('A runtime browser read policy is required.');
  }
  return config;
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
  let readSession: BrowserReadSession | undefined;

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    if (!client) throw new Error('browser-use: session not started');
    await client.ensureReady(signal);
  }

  async function registerUpstreamTools(): Promise<void> {
    await ensureConnected();
    const upstreamTools = await client!.listAllTools();

    for (const tool of upstreamTools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue;
      if (config?.readPolicy && !READ_POLICY_TOOLS.has(tool.name)) continue;

      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      const originalName = tool.name;
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
          if (config?.readPolicy && originalName === 'navigate_page') {
            if (
              params.type !== 'url' ||
              typeof params.url !== 'string' ||
              params.initScript !== undefined ||
              params.handleBeforeUnload !== undefined
            ) {
              throw new Error('Browser read policy allows only explicit URL navigation.');
            }
            await assertBrowserReadNavigation(params.url, config.readPolicy);
          }
          await ensureConnected(signal);
          const result = await client!.callTool(originalName, params, signal);
          const toolContent = toToolContent(result, originalName);
          const observation = config?.readPolicy?.observation;
          const locator =
            typeof params.url === 'string'
              ? params.url
              : (config?.readPolicy?.allowedTopLevelLocators[0] ?? '[browser-page]');
          const rawContent = (result.content ?? [])
            .map((item) => item.text ?? item.data ?? '')
            .join('');
          const details = observation
            ? createSourceObservationReceipt({
                runId: observation.runId,
                toolName: prefixedName,
                requestedLocator: locator,
                finalLocator: locator,
                mediaType: result.content?.some((item) => item.type === 'image')
                  ? 'image/png'
                  : 'text/plain',
                content: rawContent,
                truncated: false,
              })
            : undefined;
          return { ...toolContent, details };
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

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(
      loadConfigFromFile({
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
      }),
    );
    prepareBrowserProfile(config);
    try {
      readSession = await startBrowserReadSession(config);
      client = new DevToolsClient(readSession?.mcpConfig ?? config);
      await registerUpstreamTools();
      if (config.visionModel) {
        await registerVisionTool(config.visionModel);
      }
    } catch (error) {
      await client?.close().catch(() => {});
      client = undefined;
      await readSession?.close().catch(() => {});
      readSession = undefined;
      throw error;
    }
  });

  pi.on('session_shutdown', async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
    if (readSession) {
      await readSession.close();
      readSession = undefined;
    }
  });
}
