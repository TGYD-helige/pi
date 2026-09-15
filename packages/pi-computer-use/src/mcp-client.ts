import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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

function requestOptions(signal?: AbortSignal) {
  return signal ? { signal, timeout: MCP_TIMEOUT_MS } : { timeout: MCP_TIMEOUT_MS };
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
      timeout: 250,
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
 * annotations ("uint64", ...) replaced by standard constraints ajv can enforce.
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

/** Owns the Cua Driver daemon and its stdio MCP proxy as one adapter. */
export class CuaDriverClient {
  private client: Client | null = null;
  private daemonProcess: ChildProcess | null = null;
  private daemonLease: ChildProcess | null = null;
  private daemonSocket: string | null = null;
  private activeLayout: DriverLayout | null = null;
  private state: ConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private readonly lifecycleController = new AbortController();
  private generation = 0;
  private hasConnected = false;
  private explicitlyClosed = false;

  constructor(private readonly config: ComputerUseConfig) {}

  getState(): ConnectionState {
    return this.state;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.explicitlyClosed) throw new Error('Cua Driver client is closed.');
    if (this.state === 'ready') return;
    if (!this.connectPromise) {
      const connection = this.openConnection(this.lifecycleController.signal);
      this.connectPromise = connection;
      const clearConnection = () => {
        if (this.connectPromise === connection) this.connectPromise = null;
      };
      void connection.then(clearConnection, clearConnection);
    }
    await waitForPromise(this.connectPromise, signal);
  }

  private async openConnection(signal?: AbortSignal): Promise<void> {
    this.state = this.hasConnected ? 'reconnecting' : 'connecting';
    const generation = ++this.generation;
    let client: Client | null = null;
    try {
      const layout = resolveDriverLayout(this.config);
      this.ensureExecutable(layout.binaryPath);
      this.activeLayout = layout;
      const socket = await this.ensureDaemon(layout, signal);
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

      const transport = new StdioClientTransport({
        command: layout.binaryPath,
        args: mcpArgs,
        env,
        stderr: 'pipe',
      });
      client = new Client(
        { name: 'pi-computer-use', version: '0.2.0' },
        { capabilities: {}, jsonSchemaValidator: new SanitizingJsonSchemaValidator() },
      );
      this.client = client;

      transport.onerror = (error: Error) => {
        if (generation !== this.generation) return;
        console.error(`[pi-computer-use] cua-driver transport error (${error.name})`);
        void this.disconnectUnhealthyClient(generation);
      };
      transport.onclose = () => void this.disconnectUnhealthyClient(generation);

      await client.connect(transport, requestOptions(signal));
      if (generation !== this.generation) return;
      this.state = 'ready';
      this.hasConnected = true;
    } catch (error) {
      if (generation === this.generation) {
        ++this.generation;
        this.client = null;
        this.state = 'failed';
      }
      try {
        await client?.close();
      } catch {
        // A failed transport may already be closed.
      }
      await this.stopDaemon();
      if (signal?.aborted) throw abortError(signal);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[pi-computer-use] cua-driver connection failed (${errorName})`);
      if (process.env.DEBUG?.includes('pi-computer-use')) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[pi-computer-use] connection detail: ${message}`);
      }
      throw new Error('Cua Driver connection failed.');
    }
  }

  private createSocketPath(): string {
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\pi-computer-use-${suffix}`
      : resolveUnixSocketPath(tmpdir(), suffix);
  }

  private daemonEnvironment(embedded: boolean): NodeJS.ProcessEnv {
    return embedded ? { ...process.env, CUA_DRIVER_EMBEDDED: '1' } : process.env;
  }

  private async ensureDaemon(layout: DriverLayout, signal?: AbortSignal): Promise<string> {
    if (this.daemonSocket) return this.daemonSocket;
    const socket = this.createSocketPath();
    this.daemonSocket = socket;

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
        void this.stopDaemon();
      });
    }

    if (process.platform === 'darwin' && layout.appPath && !layout.embedded) {
      const launcher = spawn(
        '/usr/bin/open',
        ['-n', '-g', layout.appPath, '--args', 'serve', '--socket', socket, '--no-overlay'],
        { stdio: 'ignore' },
      );
      await this.waitForLauncher(launcher, signal);
      await this.waitForSocket(socket, signal);
      return socket;
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
    return socket;
  }

  private waitForLauncher(child: ChildProcess, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Cua Driver LaunchServices startup timed out.')),
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
        () => finish(new Error('Cua Driver daemon startup timed out.')),
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
        if (this.state !== 'closing') {
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
    // Clear owned-daemon state before awaiting the MCP close so an immediate retry
    // cannot attach to a socket that is in the process of being torn down.
    const stopPromise = this.stopDaemon();
    try {
      await failedClient?.close();
    } catch {
      console.error('[pi-computer-use] failed to close unhealthy MCP client');
    } finally {
      await stopPromise;
    }
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.explicitlyClosed) throw new Error('Cua Driver client is closed.');
    if (this.state === 'ready' && this.client) return;
    await this.connect(signal);
  }

  async listAllTools(signal?: AbortSignal): Promise<Tool[]> {
    await this.ensureReady(signal);
    const client = this.client;
    if (!client) throw new Error('Cua Driver client not connected.');

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
    await this.ensureReady(signal);
    const client = this.client;
    if (!client) throw new Error('Cua Driver client not connected.');

    try {
      return (await client.callTool(
        { name, arguments: args },
        undefined,
        requestOptions(signal),
      )) as McpToolResult;
    } catch {
      if (signal?.aborted) throw abortError(signal);
      await this.disconnectUnhealthyClient(this.generation);
      throw new Error('Cua Driver connection lost; retry the tool.');
    }
  }

  private async stopDaemon(): Promise<void> {
    const socket = this.daemonSocket;
    const layout = this.activeLayout;
    const daemonProcess = this.daemonProcess;
    const daemonLease = this.daemonLease;
    this.daemonSocket = null;
    this.activeLayout = null;
    this.daemonProcess = null;
    this.daemonLease = null;

    if (daemonLease?.stdin?.writable) daemonLease.stdin.end('cancel\n');
    else daemonLease?.kill();

    if (socket && layout) {
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
    if (this.explicitlyClosed) return;
    this.explicitlyClosed = true;
    this.state = 'closing';
    const connection = this.connectPromise;
    this.lifecycleController.abort(new Error('Cua Driver client is closing.'));
    if (connection) await Promise.allSettled([connection]);
    const client = this.client;
    ++this.generation;
    this.client = null;
    try {
      await client?.close();
    } finally {
      await this.stopDaemon();
      this.state = 'disconnected';
    }
  }
}
