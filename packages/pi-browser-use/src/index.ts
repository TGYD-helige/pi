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
import {
  type BrowserCredentialAuthority,
  BrowserCredentialAuthTransaction,
  BrowserCredentialGate,
  parseBrowserJson,
} from './credential-auth.js';
import {
  attestCredentialBrowserTcb,
  credentialBrowserChildEnv,
  credentialBrowserConfig,
} from './credential-browser-tcb.js';
import {
  BrowserCredentialChannelClient,
  browserCredentialPrivateChannelAvailable,
} from './credential-channel.js';
import { prepareBrowserProfile } from './profile.js';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from './tool-augment.js';

export {
  attestCredentialBrowserTcb,
  credentialBrowserChildEnv,
  credentialBrowserConfig,
} from './credential-browser-tcb.js';
export type { BrowserSessionMode, BrowserUseConfig, VisionModelConfig };
export { BrowserCredentialGate, configToArgs, resolveConfig };
export const BROWSER_CREDENTIAL_AUTH_TRANSACTION_CAPABILITY =
  'browser_credential_auth_transaction_v1' as const;

// All upstream tools are re-exported with this prefix to avoid name collisions with other extensions.
const TOOL_PREFIX = 'browser_';
const CREDENTIAL_CONTROL_PLANE_TOOL = /^(?:mirrorx_|runtime_action_)/u;
const CREDENTIAL_OPEN_TOOLS = new Set([
  'browser_auth_list_pages',
  'browser_auth_navigate',
  'browser_auth_preflight',
  'browser_auth_submit_with_credential_refs',
]);
const CREDENTIAL_BOUND_TOOLS = new Set([
  'browser_credential_read',
  'browser_credential_activate',
  'browser_credential_navigate',
]);

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

const MCP_TIMEOUT_MS = 60_000;
const MCP_HEALTH_TIMEOUT_MS = 5_000;
const MCP_HEALTH_CHECK_INTERVAL_MS = 10_000;
const MCP_STDERR_LIMIT = 4_096;
const MCP_SYSTEM_ERROR_CODE_PATTERN =
  /^(?:EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOENT|ENOTEMPTY|ENOTFOUND|EPERM|ETIMEDOUT)$/;
const require = createRequire(import.meta.url);
const ORIGIN_PROOF_FUNCTION = `async () => {
  globalThis.__mirrorxAuthPageGeneration ||= crypto.randomUUID();
  return { origin: location.origin, pageGeneration: globalThis.__mirrorxAuthPageGeneration };
}`;

function exactCredentialNavigation(urlValue: string, originValue: string): URL {
  const url = new URL(urlValue);
  const origin = new URL(originValue);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    originValue !== origin.origin ||
    url.origin !== origin.origin
  ) {
    throw new Error('browser_credential_navigation_invalid');
  }
  return url;
}

function sanitizedPageList(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): Array<{ pageId: number; origin: string | null }> {
  if (result.isError) throw new Error('browser_credential_page_list_failed');
  const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '';
  const pages: Array<{ pageId: number; origin: string | null }> = [];
  for (const match of text.matchAll(/^\s*(\d+):\s+(\S+)/gmu)) {
    const pageId = Number(match[1]);
    if (!Number.isSafeInteger(pageId)) continue;
    let origin: string | null = null;
    try {
      const url = new URL(match[2]!);
      if (url.protocol === 'https:' && !url.username && !url.password) origin = url.origin;
    } catch {
      // about:blank and internal pages intentionally expose no URL details.
    }
    pages.push({ pageId, origin });
  }
  if (pages.length === 0) throw new Error('browser_credential_page_list_unproven');
  return pages;
}

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
  private recentStderr = '';
  private readonly credentialGate: BrowserCredentialGate;

  constructor(
    config?: BrowserUseConfig,
    credentialGate = new BrowserCredentialGate(),
    private readonly credentialMode = false,
  ) {
    if (credentialMode) {
      const userDataDir = config?.userDataDir?.trim();
      if (!userDataDir) throw new Error('browser_credential_trusted_profile_required');
      this.config = credentialBrowserConfig(userDataDir);
    } else {
      this.config = resolveConfig(config);
    }
    this.credentialGate = credentialGate;
  }

  getCredentialGate(): BrowserCredentialGate {
    return this.credentialGate;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getCredentialTransportDiagnosticsForVerification(): string {
    if (!this.credentialMode)
      throw new Error('browser_credential_transport_verification_unavailable');
    return this.recentStderr;
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
    const args = configToArgs(this.config, this.credentialMode);
    const generation = ++this.generation;

    let client: Client | null = null;
    this.recentStderr = '';
    let transportErrorCode: string | undefined;

    try {
      // Imported lazily: the MCP SDK is heavy and only needed once a session actually connects.
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
      ]);

      const transport = new StdioClientTransport({
        command: this.credentialMode
          ? process.execPath
          : process.env.PI_BROWSER_USE_NODE?.trim() || process.execPath,
        args: [resolveChromeDevToolsMcpEntrypoint(), ...args],
        ...(this.credentialMode ? { env: credentialBrowserChildEnv() } : {}),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        this.recentStderr = `${this.recentStderr}${String(chunk)}`.slice(-MCP_STDERR_LIMIT);
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
      const diagnostic = summarizeMcpFailure(
        this.recentStderr,
        errorName,
        transportErrorCode ?? errorCode,
      );
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
    this.credentialGate.assertGenericAllowed(name, args);
    return this.callTrustedTool(name, args, signal);
  }

  async callTrustedTool(
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

const CREDENTIAL_AUTHORITY_PARAMETERS = Type.Object(
  {
    version: Type.Literal(1),
    companyId: Type.String(),
    issueId: Type.String(),
    runId: Type.String(),
    commandId: Type.String(),
    interactionId: Type.String(),
    credentialKey: Type.String(),
    credentialVersion: Type.Number(),
    credentialRole: Type.Union([Type.Literal('username'), Type.Literal('password')]),
    targetOrigin: Type.String(),
    authenticationOrigin: Type.String(),
    bindingId: Type.String(),
    browserLeaseId: Type.String(),
  },
  { additionalProperties: false },
);

const SAFE_READ_FUNCTION = `async () => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const controls = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]')]
    .filter((element) => visible(element) && !(element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)))
    .slice(0, 200)
    .map((element, controlId) => ({
      controlId,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || null,
      text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 500),
      disabled: 'disabled' in element ? Boolean(element.disabled) : false,
    }));
  const text = [...document.querySelectorAll('main,article,[role="main"],body')]
    .find((element) => visible(element))?.innerText || '';
  return { status: 'ok', origin: location.origin, title: document.title.slice(0, 500), text: text.slice(0, 20000), controls };
}`;

const SAFE_ACTIVATE_FUNCTION = `async (controlId) => {
  if (!Number.isSafeInteger(controlId) || controlId < 0 || controlId >= 200) throw new Error('control_id_invalid');
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const controls = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]')]
    .filter((element) => visible(element) && !(element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)))
    .slice(0, 200);
  const control = controls[controlId];
  if (!(control instanceof HTMLElement) || control.matches('input:not([type="button"]):not([type="submit"]),select,textarea')) {
    throw new Error('control_not_activatable');
  }
  control.click();
  return { status: 'activated', origin: location.origin, controlId };
}`;

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
  let credentialChannel: BrowserCredentialChannelClient | undefined;
  let credentialMode = false;

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    if (!client) throw new Error('browser-use: session not started');
    await client.ensureReady(signal);
  }

  async function registerUpstreamTools(): Promise<void> {
    await ensureConnected();
    const upstreamTools = await client!.listAllTools();

    for (const tool of upstreamTools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue;

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
          await ensureConnected(signal);
          const result = await client!.callTool(originalName, params, signal);
          const toolContent = toToolContent(result, originalName);
          return { ...toolContent, details: undefined };
        },
      });
    }
  }

  function registerCredentialTools(): void {
    if (!client) throw new Error('browser-use: session not started');
    const gate = client.getCredentialGate();
    const transaction = () => {
      credentialChannel ??= BrowserCredentialChannelClient.fromProcess();
      return new BrowserCredentialAuthTransaction({
        gate,
        resolveCredential: (authority, signal) => credentialChannel!.resolve(authority, signal),
        callTrustedTool: (name, args, signal) => client!.callTrustedTool(name, args, signal),
        destroyBrowser: () => client!.close(),
      });
    };
    const safeRead = async (pageId: number, signal?: AbortSignal) => {
      const proof = parseBrowserJson(
        await client!.callTrustedTool(
          'evaluate_script',
          { pageId, function: SAFE_READ_FUNCTION, args: [] },
          signal,
        ),
      );
      try {
        gate.assertCredentialSession(pageId, proof.origin);
      } catch {
        gate.close();
        await client!.close();
        throw new Error('browser_credential_session_origin_mismatch');
      }
      return proof;
    };

    pi.registerTool({
      name: 'browser_auth_list_pages',
      label: 'browser_auth_list_pages',
      description:
        'List browser page identifiers and HTTPS origins for the sealed credential authentication flow. Titles, content, DOM, storage, console, network data, and raw URLs are excluded.',
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        const pages = sanitizedPageList(await client!.callTrustedTool('list_pages', {}, signal));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ pages }) }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: 'browser_auth_navigate',
      label: 'browser_auth_navigate',
      description:
        'Navigate one page to an HTTPS URL on the exact authentication origin and return metadata-only origin/page-generation proof.',
      parameters: Type.Object({
        pageId: Type.Number(),
        url: Type.String(),
        targetOrigin: Type.String(),
      }),
      async execute(_id, params, signal) {
        const url = exactCredentialNavigation(params.url as string, params.targetOrigin as string);
        await client!.callTrustedTool(
          'navigate_page',
          { pageId: params.pageId, type: 'url', url: url.toString() },
          signal,
        );
        const proof = parseBrowserJson(
          await client!.callTrustedTool(
            'evaluate_script',
            { pageId: params.pageId, function: ORIGIN_PROOF_FUNCTION, args: [] },
            signal,
          ),
        );
        if (
          proof.origin !== url.origin ||
          typeof proof.pageGeneration !== 'string' ||
          proof.pageGeneration.length < 1
        ) {
          throw new Error('browser_credential_navigation_unproven');
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'navigated',
                origin: proof.origin,
                pageGeneration: proof.pageGeneration,
              }),
            },
          ],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: 'browser_auth_preflight',
      label: 'browser_auth_preflight',
      description:
        'Validate a same-origin, single-page username/password login form before using credential references. Returns only readiness metadata or a human-session handoff reason.',
      parameters: Type.Object({
        pageId: Type.Number(),
        targetOrigin: Type.String(),
      }),
      async execute(_id, params, signal) {
        const result = await transaction().preflight(
          params as {
            pageId: number;
            targetOrigin: string;
          },
          signal,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: 'browser_auth_submit_with_credential_refs',
      label: 'browser_auth_submit_with_credential_refs',
      description:
        'Atomically resolve opaque credential references, fill a validated same-origin login form, submit it, scrub the controls, rotate the document context, and return metadata-only proof.',
      parameters: Type.Object({
        pageId: Type.Number(),
        pageGeneration: Type.String(),
        usernameValue: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        credentialRefs: Type.Array(CREDENTIAL_AUTHORITY_PARAMETERS, { minItems: 1, maxItems: 2 }),
      }),
      async execute(_id, params, signal) {
        const input = params as {
          pageId: number;
          pageGeneration: string;
          usernameValue?: string;
          credentialRefs: BrowserCredentialAuthority[];
        };
        const result = await transaction().authenticate(input, signal);
        credentialChannel!.recordAuthenticated(
          input.credentialRefs[0]!,
          result,
          input.credentialRefs.map((authority) => authority.credentialRole),
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: 'browser_credential_read',
      label: 'browser_credential_read',
      description:
        'Read sanitized visible content from a credential-bound browser session. Password/hidden controls, attributes, storage, console, network data, and raw HTML are excluded.',
      parameters: Type.Object({ pageId: Type.Number() }),
      async execute(_id, params, signal) {
        gate.assertCredentialSession(params.pageId as number);
        const proof = await safeRead(params.pageId as number, signal);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(proof) }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: 'browser_credential_activate',
      label: 'browser_credential_activate',
      description:
        'Activate a visible sanitized control by the controlId returned from browser_credential_read.',
      parameters: Type.Object({
        pageId: Type.Number(),
        controlId: Type.Integer({ minimum: 0, maximum: 199 }),
      }),
      async execute(_id, params, signal) {
        gate.assertCredentialSession(params.pageId as number);
        try {
          await client!.callTrustedTool(
            'evaluate_script',
            {
              pageId: params.pageId,
              function: SAFE_ACTIVATE_FUNCTION,
              args: [params.controlId],
            },
            signal,
          );
        } catch {
          // Navigation may destroy the source execution context. The sanitized read below is authoritative.
        }
        const proof = await safeRead(params.pageId as number, signal);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(proof) }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: 'browser_credential_navigate',
      label: 'browser_credential_navigate',
      description:
        'Navigate a credential-bound browser session to an HTTPS URL without exposing storage or tokens.',
      parameters: Type.Object({ pageId: Type.Number(), url: Type.String() }),
      async execute(_id, params, signal) {
        const url = new URL(params.url as string);
        const boundOrigin = gate.assertCredentialSession(params.pageId as number);
        if (url.protocol !== 'https:' || url.username || url.password) {
          throw new Error('browser_credential_navigation_invalid');
        }
        if (url.origin !== boundOrigin)
          throw new Error('browser_credential_navigation_origin_mismatch');
        await client!.callTrustedTool(
          'navigate_page',
          { pageId: params.pageId, type: 'url', url: url.toString() },
          signal,
        );
        const proof = await safeRead(params.pageId as number, signal);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(proof) }],
          details: undefined,
        };
      },
    });
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

  pi.on('session_start', async (_event, ctx) => {
    credentialMode = browserCredentialPrivateChannelAvailable();
    const trustedProfile = process.env.AMASTER_BROWSER_SESSION_USER_DATA_DIR?.trim();
    if (credentialMode && !trustedProfile) {
      throw new Error('browser_credential_trusted_profile_required');
    }
    if (credentialMode) attestCredentialBrowserTcb();
    const configured = credentialMode
      ? credentialBrowserConfig(trustedProfile!)
      : loadConfigFromFile({
          cwd: ctx.cwd,
          projectTrusted: isProjectTrusted(ctx),
        });
    config = credentialMode ? configured : resolveConfig(configured);
    prepareBrowserProfile(config);
    client = new DevToolsClient(config, undefined, credentialMode);
    if (credentialMode) {
      registerCredentialTools();
    } else {
      await registerUpstreamTools();
    }
    if (!credentialMode && config.visionModel) {
      await registerVisionTool(config.visionModel);
    }
  });

  pi.on('tool_call', async (event) => {
    const gate = client?.getCredentialGate();
    if (!credentialMode || !gate) return undefined;
    if (CREDENTIAL_CONTROL_PLANE_TOOL.test(event.toolName)) return undefined;
    const phase = gate.currentPhase();
    if (phase === 'open' && CREDENTIAL_OPEN_TOOLS.has(event.toolName)) return undefined;
    if (phase === 'credential_bound' && CREDENTIAL_BOUND_TOOLS.has(event.toolName)) {
      return undefined;
    }
    return {
      block: true,
      reason:
        phase === 'sealed'
          ? 'browser_auth_transaction_sealed'
          : 'browser_credential_auth_scope_forbidden',
    };
  });

  pi.on('session_shutdown', async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
    credentialChannel?.close();
    credentialChannel = undefined;
    credentialMode = false;
  });
}
