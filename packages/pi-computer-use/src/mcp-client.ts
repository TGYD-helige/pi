import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyError, SafeToolError } from '@amaster.ai/pi-shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/index.js';
import type { ComputerUseConfig } from './config.js';
import type { McpToolResult } from './tool-result.js';

const MCP_TIMEOUT_MS = 60_000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const NAMED_SESSION_CURSOR_PREFIX = 'named:';
const PERMANENT_STATUS_ERROR_CODES = new Set(['EACCES', 'ENOENT', 'EPERM']);
const DAEMON_LEASE_SCRIPT = `
if IFS= read -r _; then exit 0; fi
attempt=0
while [ "$attempt" -lt 100 ]; do
  if [ -S "$2" ]; then
    "$1" stop --socket "$2" >/dev/null 2>&1
    status=$("$1" status --socket "$2" 2>&1)
    if [ -S "$2" ] && [ "$status" = "Cua Driver daemon is not running" ]; then
      /bin/rm -f -- "$2"
    fi
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
`;
const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);

function extensionEnvironment(): Record<string, string> {
  const catalog = process.env.CUA_DRIVER_PERCEPTION_CATALOG;
  return {
    ...(catalog ? { CUA_DRIVER_PERCEPTION_CATALOG: catalog } : {}),
    ...(process.env.CUA_DRIVER_RS_HOME
      ? { CUA_DRIVER_RS_HOME: process.env.CUA_DRIVER_RS_HOME }
      : {}),
  };
}

function requestOptions(signal?: AbortSignal, timeout = MCP_TIMEOUT_MS) {
  return signal ? { signal, timeout } : { timeout };
}

function toolTimeout(name: string): number {
  return name === 'run_script' ? 125_000 : name === 'run_steps' ? 65_000 : MCP_TIMEOUT_MS;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error('Cua Driver operation aborted.');
}

export async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function resolveBundledTarget(platform: string, arch: string): string {
  if (platform === 'darwin') return 'darwin-universal';
  return `${platform}-${arch}`;
}

function resolveDriverPackageRoot(platform: string, arch: string): string {
  const target = resolveBundledTarget(platform, arch);
  const packageName = `@amaster.ai/pi-computer-use-cua-driver-${target}`;
  try {
    return path.dirname(localRequire.resolve(`${packageName}/package.json`));
  } catch {
    throw new Error(`Cua Driver runtime package is not installed for ${target}.`);
  }
}

export function resolveUnixSocketPath(tempDir: string, suffix: string): string {
  const filename = `pi-cua-${suffix}.sock`;
  const configuredTmpPath = path.join(tempDir, filename);
  // sockaddr_un.sun_path is only 104 bytes on macOS and 108 bytes on Linux.
  return Buffer.byteLength(configuredTmpPath) <= 90
    ? configuredTmpPath
    : path.join('/tmp', filename);
}

export async function waitForDaemonStatus(
  binaryPath: string,
  socket: string,
  signal?: AbortSignal,
  checkStatus: () => Promise<unknown> = () =>
    execFileAsync(binaryPath, ['status', '--socket', socket], {
      signal,
      timeout: DAEMON_START_TIMEOUT_MS,
      windowsHide: true,
    }),
): Promise<void> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await checkStatus();
      return;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      lastError = error;
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
      if (code && PERMANENT_STATUS_ERROR_CODES.has(code)) {
        throw new Error(`Cua Driver status check failed (${code}).`, { cause: error });
      }
    }
    await delay(50, signal);
  }
  throw new Error('Cua Driver daemon did not respond to a status check.', { cause: lastError });
}

export interface DriverLayout {
  binaryPath: string;
  appPath?: string;
  embedded: boolean;
}

export function resolveDriverLayout(
  config: ComputerUseConfig,
  rootDir: string | undefined = undefined,
  platform = process.platform,
  arch = process.arch,
): DriverLayout {
  if (config.mode === 'path' && config.binaryPath) {
    return { binaryPath: config.binaryPath, embedded: platform === 'darwin' };
  }

  const binDir = rootDir
    ? path.join(rootDir, 'bin', resolveBundledTarget(platform, arch))
    : path.join(resolveDriverPackageRoot(platform, arch), 'bin');
  if (platform === 'darwin') {
    const appPath = path.join(binDir, 'CuaDriver.app');
    return {
      appPath,
      binaryPath: path.join(appPath, 'Contents', 'MacOS', 'cua-driver'),
      embedded: false,
    };
  }

  return {
    binaryPath: path.join(binDir, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
    embedded: false,
  };
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'closing';

/** schemars emits these non-standard `format` values for Rust integer types; ajv warns on each. */
const INTEGER_FORMAT_BOUNDS: Record<string, { minimum?: number; maximum?: number }> = {
  int8: { minimum: -128, maximum: 127 },
  int16: { minimum: -32_768, maximum: 32_767 },
  int32: { minimum: -2_147_483_648, maximum: 2_147_483_647 },
  int64: {},
  uint8: { minimum: 0, maximum: 255 },
  uint16: { minimum: 0, maximum: 65_535 },
  uint32: { minimum: 0, maximum: 4_294_967_295 },
  uint64: { minimum: 0 },
};

/** Schema keys whose values are instance data, not subschemas — never rewrite inside them. */
const NON_SCHEMA_KEYS = new Set(['const', 'default', 'enum', 'examples']);

/**
 * Keywords whose values are maps of property name → subschema. Inside these maps the
 * keys are property names, not schema keywords, so NON_SCHEMA_KEYS must not apply:
 * a property literally named "default" or "enum" still needs its subschema sanitized.
 */
const PROPERTY_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

/**
 * Returns a copy of the schema with schemars' non-standard integer `format`
 * annotations ("uint64", ...) replaced by standard constraints ajv can enforce,
 * and string-only enums given the explicit type required by model providers.
 * The input schema is not modified.
 */
export function sanitizeSchemaFormats<T>(schema: T): T {
  return sanitizeSchemaNode(schema) as T;
}

function sanitizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaNode);
  if (node === null || typeof node !== 'object') return node;

  // Null-prototype copy: a schema from the wire may carry an own "__proto__"
  // key (JSON.parse creates one), and assigning it on a plain object would hit
  // the inherited setter — dropping the key and replacing the copy's prototype.
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(node)) {
    result[key] = sanitizeSchemaValue(key, value);
  }

  // String-only enums imply their type; providers such as Moonshot require it explicitly.
  if (
    result.type === undefined &&
    Array.isArray(result.enum) &&
    result.enum.length > 0 &&
    result.enum.every((value) => typeof value === 'string')
  )
    result.type = 'string';

  const format = result.format;
  if (typeof format !== 'string') return result;
  // Own-property check: a plain table lookup would match Object.prototype keys
  // ("constructor", "toString", ...) on hostile or malformed schemas.
  const bounds = Object.hasOwn(INTEGER_FORMAT_BOUNDS, format)
    ? INTEGER_FORMAT_BOUNDS[format]
    : undefined;
  if (!bounds) return result;
  // Only rewrite integer schemas; injecting numeric bounds into a node that
  // declares another type would misannotate it.
  if (!isIntegerType(result.type)) return result;

  delete result.format;
  result.type ??= 'integer';
  if (bounds.minimum !== undefined && result.minimum === undefined) {
    result.minimum = bounds.minimum;
  }
  if (bounds.maximum !== undefined && result.maximum === undefined) {
    result.maximum = bounds.maximum;
  }
  return result;
}

function sanitizeSchemaValue(key: string, value: unknown): unknown {
  if (NON_SCHEMA_KEYS.has(key)) return value;
  if (PROPERTY_MAP_KEYS.has(key) && isRecord(value)) {
    const map: Record<string, unknown> = Object.create(null);
    for (const [name, subschema] of Object.entries(value)) {
      map[name] = sanitizeSchemaNode(subschema);
    }
    return map;
  }
  return sanitizeSchemaNode(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerType(type: unknown): boolean {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.includes('integer');
  return type === 'integer';
}

/**
 * Wraps the SDK's default ajv validator, sanitizing non-standard integer formats
 * before compilation so ajv stays silent and the integer bounds stay enforced.
 */
export class SanitizingJsonSchemaValidator implements jsonSchemaValidator {
  private readonly inner = new AjvJsonSchemaValidator();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    return this.inner.getValidator<T>(sanitizeSchemaFormats(schema));
  }
}

export class CuaDriverRequestNotDispatched extends SafeToolError {
  constructor(error: unknown) {
    super('Cua Driver preflight', error, 'Check that the driver and target are available.');
  }
}

interface McpProxy {
  client?: Client;
  connecting?: Promise<Client>;
  closing?: Promise<void>;
  state: ConnectionState;
  hasConnected?: boolean;
}

interface DaemonEndpoint {
  layout: DriverLayout;
  socket: string;
}

function sessionPage(result: McpToolResult) {
  const sessions: unknown = result.structuredContent?.sessions;
  const cursor = result.structuredContent?.next_cursor;
  if (result.isError || !Array.isArray(sessions)) return undefined;
  return {
    sessions: sessions as unknown[],
    cursor: typeof cursor === 'string' ? cursor : undefined,
  };
}

function mergedSessionPage(sessions: unknown[], cursor?: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `${sessions.length} visible session(s).` }],
    structuredContent: { sessions, next_cursor: cursor ?? null },
  };
}

function implicitSessionEnded(result: McpToolResult): boolean {
  return (
    result.isError === true &&
    (result.structuredContent?.code === 'session_ended' ||
      (result.structuredContent?.code === 'tool_invocation_failed' &&
        (result.content ?? [])
          .slice(0, 4)
          .some(
            ({ type, text }) =>
              type === 'text' &&
              text
                ?.slice(0, 1024)
                .split(/\r?\n/)
                .includes(
                  "session has ended; tool call 'list_sessions' was rejected. Call start_session without a session label to start a new unnamed session.",
                ),
          )))
  );
}

// Temporary workaround for https://github.com/trycua/cua/pull/6506.
// Remove the proxy split once Pi bundles a driver with the browser ownership fix.
export class CuaDriverClient {
  private readonly implicit: McpProxy = { state: 'disconnected' };
  private readonly named: McpProxy = { state: 'disconnected' };
  private daemonConnection: Promise<DaemonEndpoint> | undefined;
  private daemonNeedsCheck = false;
  private daemonProcess: ChildProcess | null = null;
  private daemonLease: ChildProcess | null = null;
  private daemon: DaemonEndpoint | undefined;
  private readonly lifecycleController = new AbortController();

  constructor(private readonly config: ComputerUseConfig) {}

  getState(): ConnectionState {
    return this.implicit.state;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.connectProxy(this.implicit, signal);
  }

  private proxyFor(session: unknown): McpProxy {
    return typeof session === 'string' && session.length > 0 ? this.named : this.implicit;
  }

  private async connectProxy(proxy: McpProxy, signal?: AbortSignal): Promise<Client> {
    this.lifecycleController.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (proxy.state === 'ready' && proxy.client) return proxy.client;
    if (!proxy.connecting) {
      const connecting = this.openConnection(proxy);
      proxy.connecting = connecting;
      const clearConnection = () => {
        if (proxy.connecting === connecting) delete proxy.connecting;
      };
      void connecting.then(clearConnection, clearConnection);
    }
    return waitForPromise(proxy.connecting, signal);
  }

  private async openConnection(proxy: McpProxy): Promise<Client> {
    proxy.state = proxy.hasConnected ? 'reconnecting' : 'connecting';
    const lifecycle = this.lifecycleController.signal;
    const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(MCP_TIMEOUT_MS)]);
    let client: Client | undefined;
    try {
      if (proxy.closing) await waitForPromise(proxy.closing, signal);
      signal.throwIfAborted();
      const { layout, socket } = await waitForPromise(this.connectDaemon(lifecycle), signal);
      signal.throwIfAborted();
      const mcpArgs = [
        'mcp',
        ...(layout.embedded ? ['--embedded'] : []),
        '--socket',
        socket,
        ...(this.config.extraArgs ?? []),
      ];
      const env = layout.embedded
        ? { ...getDefaultEnvironment(), CUA_DRIVER_EMBEDDED: '1' }
        : getDefaultEnvironment();
      Object.assign(env, extensionEnvironment());

      const transport = new StdioClientTransport({
        command: layout.binaryPath,
        args: mcpArgs,
        env,
        stderr: 'pipe',
      });
      const connectedClient = new Client(
        { name: 'pi-computer-use', version: '0.2.0' },
        { capabilities: {}, jsonSchemaValidator: new SanitizingJsonSchemaValidator() },
      );
      client = connectedClient;
      proxy.client = connectedClient;

      transport.onerror = (error: Error) => {
        if (proxy.client !== connectedClient) return;
        console.error(
          `[pi-computer-use] cua-driver transport error (category=${classifyError(error).errorCategory})`,
        );
        void this.disconnectProxy(proxy, connectedClient);
      };
      transport.onclose = () => void this.disconnectProxy(proxy, connectedClient);

      await waitForPromise(connectedClient.connect(transport, requestOptions(signal)), signal);
      signal.throwIfAborted();
      if (proxy.client !== connectedClient) throw new Error('Cua Driver MCP proxy disconnected.');
      proxy.state = 'ready';
      proxy.hasConnected = true;
      return connectedClient;
    } catch (error) {
      if (client) await this.disconnectProxy(proxy, client);
      proxy.state = 'failed';
      if (signal.aborted) throw abortError(signal);
      const failure = new SafeToolError('Cua Driver connection', error);
      console.error(`[pi-computer-use] connection failed (category=${failure.errorCategory})`);
      throw failure;
    }
  }

  private connectDaemon(signal: AbortSignal): Promise<DaemonEndpoint> {
    if (!this.daemonConnection || this.daemonNeedsCheck) {
      const previous = this.daemonConnection;
      this.daemonNeedsCheck = false;
      const connection = this.openDaemon(previous, signal);
      this.daemonConnection = connection;
      void connection.catch(() => {
        if (this.daemonConnection === connection) this.daemonConnection = undefined;
      });
    }
    return this.daemonConnection;
  }

  private async openDaemon(previous: Promise<DaemonEndpoint> | undefined, signal: AbortSignal) {
    const existing = await previous;
    signal.throwIfAborted();
    if (existing) {
      if (this.implicit.client || this.named.client) return existing;
      try {
        await execFileAsync(existing.layout.binaryPath, ['status', '--socket', existing.socket], {
          env: this.daemonEnvironment(existing.layout.embedded),
          signal,
          timeout: 3_000,
          maxBuffer: 4_096,
          windowsHide: true,
        });
        return existing;
      } catch (error) {
        signal.throwIfAborted();
        // A broken proxy or inconclusive status probe is insufficient reason to stop a shared daemon.
        if (
          !(error instanceof Error) ||
          !('stderr' in error) ||
          typeof error.stderr !== 'string' ||
          error.stderr.trim() !== 'Cua Driver daemon is not running'
        ) {
          return existing;
        }
        if (this.implicit.client || this.named.client) return existing;
        if (this.daemon !== existing) throw new Error('Cua Driver daemon changed during recovery.');
        await this.stopDaemon();
      }
    }

    signal.throwIfAborted();
    const layout = resolveDriverLayout(this.config);
    this.ensureExecutable(layout.binaryPath);
    const endpoint = { layout, socket: this.createSocketPath() };
    this.daemon = endpoint;
    try {
      await this.startDaemon(endpoint, signal);
      if (this.daemon !== endpoint) throw new Error('Cua Driver daemon stopped during startup.');
      return endpoint;
    } catch (error) {
      if (this.daemon === endpoint) await this.stopDaemon();
      throw error;
    }
  }

  private createSocketPath(): string {
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\pi-computer-use-${suffix}`
      : resolveUnixSocketPath(tmpdir(), suffix);
  }

  private daemonEnvironment(embedded: boolean): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...extensionEnvironment(),
      ...(embedded ? { CUA_DRIVER_EMBEDDED: '1' } : {}),
    };
  }

  private async startDaemon(
    { layout, socket }: DaemonEndpoint,
    signal: AbortSignal,
  ): Promise<void> {
    if (process.platform !== 'win32') {
      // This anonymous pipe is the lease: owner death closes it even after SIGKILL.
      const lease = spawn(
        '/bin/sh',
        ['-c', DAEMON_LEASE_SCRIPT, 'pi-computer-use-lease', layout.binaryPath, socket],
        {
          env: this.daemonEnvironment(layout.embedded),
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      this.daemonLease = lease;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          lease.removeListener('spawn', onSpawn);
          reject(error);
        };
        const onSpawn = () => {
          lease.removeListener('error', onError);
          resolve();
        };
        lease.once('error', onError);
        lease.once('spawn', onSpawn);
      });
      lease.unref?.();
      (lease.stdin as (typeof lease.stdin & { unref?: () => void }) | null)?.unref?.();
      lease.once('error', () => {
        if (this.daemonLease !== lease) return;
        console.error('[pi-computer-use] failed to start daemon lease');
        this.daemonConnection = undefined;
        void this.stopDaemon();
      });
    }

    if (process.platform === 'darwin' && layout.appPath && !layout.embedded) {
      const launcher = spawn(
        '/usr/bin/open',
        [
          '-n',
          '-g',
          layout.appPath,
          ...Object.entries(extensionEnvironment()).flatMap(([key, value]) => [
            '--env',
            `${key}=${value}`,
          ]),
          '--args',
          'serve',
          '--socket',
          socket,
          '--no-overlay',
        ],
        { stdio: 'ignore' },
      );
      await this.waitForLauncher(launcher, signal);
      await this.waitForSocket(socket, signal);
      return;
    }

    const args = [
      'serve',
      ...(layout.embedded ? ['--embedded'] : []),
      '--socket',
      socket,
      '--no-overlay',
    ];
    const daemon = spawn(layout.binaryPath, args, {
      env: this.daemonEnvironment(layout.embedded),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.daemonProcess = daemon;
    await this.waitForDaemonReady(daemon, socket, signal);
    if (process.platform === 'win32') {
      await waitForDaemonStatus(layout.binaryPath, socket, signal);
    }
  }

  private waitForLauncher(child: ChildProcess, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new DOMException('Cua Driver LaunchServices startup timed out.', 'TimeoutError')),
        DAEMON_START_TIMEOUT_MS,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve();
      };
      const onAbort = () => {
        child.kill();
        finish(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', finish);
      child.once('exit', (code) =>
        code === 0 ? finish() : finish(new Error(`LaunchServices exited with code ${code ?? -1}.`)),
      );
    });
  }

  private async waitForSocket(socket: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(socket)) return;
      await delay(50, signal);
    }
    throw new Error('Cua Driver daemon socket did not become ready.');
  }

  private waitForDaemonReady(
    daemon: ChildProcess,
    socket: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(
        () => finish(new DOMException('Cua Driver daemon startup timed out.', 'TimeoutError')),
        DAEMON_START_TIMEOUT_MS,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        daemon.stderr?.removeListener('data', onData);
        error ? reject(error) : resolve();
      };
      const onAbort = () => {
        daemon.kill();
        finish(abortError(signal));
      };
      const onData = (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
        if (stderr.includes('daemon listening on')) finish();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      daemon.stderr?.on('data', onData);
      daemon.once('error', finish);
      daemon.once('exit', (code) => {
        if (!this.lifecycleController.signal.aborted) {
          const detail = process.env.DEBUG?.includes('pi-computer-use') ? `: ${stderr.trim()}` : '';
          finish(new Error(`Cua Driver daemon exited with code ${code ?? -1}${detail}.`));
        }
      });
      if (process.platform !== 'win32' && existsSync(socket)) finish();
    });
  }

  private ensureExecutable(binaryPath: string): void {
    if (!existsSync(binaryPath)) {
      throw new Error(
        `cua-driver binary not found for ${resolveBundledTarget(process.platform, process.arch)}.`,
      );
    }
    if (process.platform === 'win32') return;

    try {
      accessSync(binaryPath, constants.X_OK);
    } catch {
      try {
        chmodSync(binaryPath, 0o755);
      } catch {
        throw new Error('cua-driver binary is not executable.');
      }
    }
  }

  private disconnectProxy(proxy: McpProxy, client: Client): Promise<void> | undefined {
    if (proxy.client !== client) return proxy.closing;
    delete proxy.client;
    proxy.state = 'disconnected';
    this.daemonNeedsCheck = true;
    const closing = client.close().catch(() => {
      console.error('[pi-computer-use] failed to close MCP proxy');
    });
    proxy.closing = closing;
    void closing.then(() => {
      if (proxy.closing === closing) delete proxy.closing;
    });
    return closing;
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
  }

  async listAllTools(signal?: AbortSignal): Promise<Tool[]> {
    const client = await this.connectProxy(this.implicit, signal);
    signal?.throwIfAborted();
    const allTools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        requestOptions(signal),
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
  ): Promise<McpToolResult> {
    // Keep the shared proxy startup independent of individual tool deadlines.
    const deadline = AbortSignal.timeout(toolTimeout(name));
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      return name === 'list_sessions'
        ? await this.listSessions(args, requestSignal)
        : await this.callProxy(this.proxyFor(args.session), name, args, requestSignal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw error;
    }
  }

  private async listSessions(
    args: Record<string, unknown>,
    requestSignal: AbortSignal,
  ): Promise<McpToolResult> {
    const { session: _session, ...listArgs } = args;
    const { cursor, ...rest } = listArgs;
    const named = this.named.state === 'ready' ? this.named.client : undefined;
    if (!named) return this.callProxy(this.implicit, 'list_sessions', listArgs, requestSignal);

    // The driver's list tool does not activate the transport's implicit session.
    if (typeof cursor === 'string' && cursor.startsWith(NAMED_SESSION_CURSOR_PREFIX)) {
      const driverCursor = cursor.slice(NAMED_SESSION_CURSOR_PREFIX.length);
      const result = await this.requestTool(
        this.named,
        named,
        'list_sessions',
        {
          ...rest,
          ...(driverCursor ? { cursor: driverCursor } : {}),
        },
        requestSignal,
      );
      const page = sessionPage(result);
      return page
        ? mergedSessionPage(page.sessions, page.cursor && NAMED_SESSION_CURSOR_PREFIX + page.cursor)
        : result;
    }

    const implicit = this.implicit.state === 'ready' ? this.implicit.client : undefined;
    let implicitResult: McpToolResult | undefined;
    if (implicit || cursor != null) {
      try {
        implicitResult = await this.callProxy(
          this.implicit,
          'list_sessions',
          listArgs,
          requestSignal,
        );
      } catch (error) {
        if (cursor != null || this.implicit.client === implicit || requestSignal.aborted)
          throw error;
      }
    }
    const implicitPage = implicitResult && sessionPage(implicitResult);
    if (
      implicitResult &&
      (this.named.client !== named ||
        implicitPage?.cursor ||
        (!implicitPage && !(cursor == null && implicitSessionEnded(implicitResult))))
    ) {
      return implicitResult;
    }

    const implicitSessions = implicitPage?.sessions ?? [];
    const limit = typeof rest.limit === 'number' ? rest.limit : 50;
    const remaining = Math.max(0, limit - implicitSessions.length);
    const namedResult = await this.requestTool(
      this.named,
      named,
      'list_sessions',
      {
        ...rest,
        // Check for a next page without consuming its first session if this page is full.
        ...(implicitPage ? { limit: remaining || 1 } : {}),
      },
      requestSignal,
    );
    const namedPage = sessionPage(namedResult);
    if (!namedPage) return namedResult;
    if (remaining === 0) {
      return mergedSessionPage(
        implicitSessions,
        namedPage.sessions.length ? NAMED_SESSION_CURSOR_PREFIX : undefined,
      );
    }
    return mergedSessionPage(
      [...implicitSessions, ...namedPage.sessions],
      namedPage.cursor && NAMED_SESSION_CURSOR_PREFIX + namedPage.cursor,
    );
  }

  private async callProxy(
    proxy: McpProxy,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    let client: Client;
    try {
      client = await this.connectProxy(proxy, signal);
      signal.throwIfAborted();
    } catch (error) {
      throw new CuaDriverRequestNotDispatched(error);
    }

    return this.requestTool(proxy, client, name, args, signal);
  }

  private async requestTool(
    proxy: McpProxy,
    client: Client,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    signal.throwIfAborted();
    if (proxy.client !== client) {
      throw new CuaDriverRequestNotDispatched(new Error('Cua Driver MCP proxy disconnected.'));
    }
    try {
      return (await client.callTool(
        { name, arguments: args },
        undefined,
        // Leave transport time for the driver's bounded automation result to arrive.
        requestOptions(signal, toolTimeout(name)),
      )) as McpToolResult;
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      await this.disconnectProxy(proxy, client);
      throw new SafeToolError(
        'Cua Driver request',
        error,
        'Execution outcome is unknown. Read the current target state before retrying any action.',
      );
    }
  }

  private async stopDaemon(): Promise<void> {
    const endpoint = this.daemon;
    const daemonProcess = this.daemonProcess;
    const daemonLease = this.daemonLease;
    this.daemon = undefined;
    this.daemonProcess = null;
    this.daemonLease = null;

    if (daemonLease?.stdin?.writable) daemonLease.stdin.end('cancel\n');
    else daemonLease?.kill();

    if (endpoint) {
      const { layout, socket } = endpoint;
      try {
        await execFileAsync(layout.binaryPath, ['stop', '--socket', socket], {
          env: this.daemonEnvironment(layout.embedded),
          timeout: 3_000,
        });
      } catch {
        console.error('[pi-computer-use] failed to stop owned daemon');
      }
    }
    daemonProcess?.kill();
  }

  async close(): Promise<void> {
    if (this.lifecycleController.signal.aborted) return;
    this.lifecycleController.abort(new Error('Cua Driver client is closing.'));
    const proxies = [this.implicit, this.named];
    for (const proxy of proxies) proxy.state = 'closing';
    await Promise.allSettled([...proxies.map((proxy) => proxy.connecting), this.daemonConnection]);
    await Promise.all(
      proxies.map((proxy) =>
        proxy.client ? this.disconnectProxy(proxy, proxy.client) : proxy.closing,
      ),
    );
    await this.stopDaemon();
    this.daemonConnection = undefined;
    for (const proxy of proxies) proxy.state = 'disconnected';
  }
}
