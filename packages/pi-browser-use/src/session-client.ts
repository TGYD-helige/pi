import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SafeToolError } from '@amaster.ai/pi-shared';
import { resolveHome } from '@amaster.ai/pi-shared/settings';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createCloudBrowserAdapter } from './adapter.js';
import type { BrowserUseConfig } from './config.js';
import { buildSubprocessEnv } from './config.js';
import type { DevToolsClient } from './index.js';
import {
  createHttpBrowserAdapter,
  hasKnownBrowserId,
  type ManagedBrowser,
} from './session-backend.js';
import {
  BrowserSessionError,
  BrowserToolNotDispatched,
  type SessionAction,
  type SessionRefusalCode,
} from './session-control.js';

export interface SessionRecord {
  port?: number;
  token: string;
  configHash: string;
  ended?: string;
  managed?: ManagedBrowser;
  binding?: ManagedBrowser;
  cleanup?: SessionCleanupProgress;
}

export interface SessionCleanupProgress {
  markerRemoved: boolean;
  transportClosed: boolean;
  providerReleased: boolean;
}

export async function writeSessionRecord(path: string, record: SessionRecord) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function readSessionRecord(path: string) {
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    ) {
      throw new BrowserSessionError('Browser session record permissions are unsafe.');
    }
    if (stat.size > 131_072) throw new BrowserSessionError('Browser session record is invalid.');
    const value = JSON.parse(await readFile(path, 'utf8')) as SessionRecord;
    if (
      !/^[a-f0-9]{64}$/.test(value.token) ||
      typeof value.configHash !== 'string' ||
      (value.ended !== undefined &&
        !['closed', 'expired', 'lost', 'cleanup-failed', 'startup-failed'].includes(value.ended)) ||
      (value.port !== undefined &&
        (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535))
    ) {
      throw new BrowserSessionError('Browser session record is invalid.');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof BrowserSessionError || error instanceof SafeToolError) throw error;
    throw new BrowserSessionError('Could not read the browser session record.');
  }
}

async function isProtectedSessionDirectory(path: string): Promise<boolean> {
  const directory = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new BrowserSessionError('Could not inspect the browser session directory.');
  });
  if (!directory) return false;
  if (
    !directory.isDirectory() ||
    (process.platform !== 'win32' &&
      (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))
  )
    throw new BrowserSessionError('Browser session directory ownership is unsafe.');
  return true;
}

/** Summarize protected local records for SDK hosts without opening browser connections. */
export async function listBrowserSessionRecords(limit = 50, signal?: AbortSignal) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new BrowserSessionError('Browser session record limit must be between 1 and 100.');
  signal?.throwIfAborted();
  const root = join(resolveHome(), 'browser-sessions');
  const records: Array<{ id: string; state: string; cleanup?: SessionCleanupProgress }> = [];
  const directory = await opendir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new BrowserSessionError('Could not list browser session records.');
  });
  if (!directory) return { records, truncated: false };
  let visited = 0;
  for await (const entry of directory) {
    signal?.throwIfAborted();
    if (++visited > 500) return { records, truncated: true };
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    let summary: (typeof records)[number];
    try {
      if (!(await isProtectedSessionDirectory(path))) continue;
      const record = await readSessionRecord(join(path, 'session.json'));
      if (!record) continue;
      const cleanup = record.cleanup;
      summary = {
        id: entry.name,
        state: record.ended ?? (record.port ? 'recorded' : 'unavailable'),
        ...(cleanup &&
        typeof cleanup.markerRemoved === 'boolean' &&
        typeof cleanup.transportClosed === 'boolean' &&
        typeof cleanup.providerReleased === 'boolean'
          ? {
              cleanup: {
                markerRemoved: cleanup.markerRemoved,
                transportClosed: cleanup.transportClosed,
                providerReleased: cleanup.providerReleased,
              },
            }
          : {}),
      };
    } catch {
      summary = { id: entry.name, state: 'unreadable' };
    }
    if (records.length >= limit) return { records, truncated: true };
    records.push(summary);
  }
  signal?.throwIfAborted();
  return { records, truncated: false };
}

/** Authenticated local bridge to an independent process holding the same MCP/CDP connection. */
export class BrowserSessionClient {
  private record: SessionRecord | undefined;
  private owner = randomBytes(32).toString('hex');
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private connected = false;
  private attachAttempted = false;
  private connecting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private path: string;
  private readonly configHash: string;

  constructor(
    private readonly config: BrowserUseConfig,
    private readonly browser?: ManagedBrowser,
  ) {
    if (!config.session?.enabled)
      throw new BrowserSessionError('Browser session retention is not configured.');
    if (browser) {
      if ((!config.session.backend && !config.session.provider) || config.session.adapterModule)
        throw new BrowserSessionError(
          'A runtime browser binding requires an HTTP lifecycle backend or built-in provider.',
        );
      if (config.session.provider) createCloudBrowserAdapter(config.session.provider, browser);
      else createHttpBrowserAdapter(config.session.backend!, browser);
    }
    const identity = createHash('sha256').update(config.session.key).digest('hex');
    this.path = join(resolveHome(), 'browser-sessions', identity, 'session.json');
    this.configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  }

  getState() {
    return this.connected ? ('ready' as const) : ('disconnected' as const);
  }

  async connect(signal?: AbortSignal) {
    if (this.closing) throw new BrowserSessionError('Browser session client is closing.');
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open(signal);
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async lock(signal?: AbortSignal) {
    signal?.throwIfAborted();
    let directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32' && stat.uid !== process.getuid?.()))
      throw new BrowserSessionError('Browser session directory ownership is unsafe.');
    await chmod(directory, 0o700);
    directory = await realpath(directory);
    this.path = join(directory, 'session.json');
    const lockPath = join(directory, 'lock');
    const deadline = Date.now() + 65_000;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
      signal?.throwIfAborted();
      try {
        lock = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new BrowserSessionError('Could not lock the browser session.');
        if (Date.now() >= deadline)
          throw new BrowserSessionError(
            'Browser session startup is locked. Check the session directory before retrying.',
          );
        await delay(100, undefined, signal ? { signal } : {});
      }
    }
    const handle = lock;
    return async () => {
      await handle.close();
      await rm(lockPath, { force: true });
    };
  }

  private validateRecordIdentity(record: SessionRecord) {
    const stored = record.binding;
    if (
      this.browser &&
      (!stored ||
        this.browser.id !== stored.id ||
        (['wsEndpoint', 'browserUrl', 'wsHeaders'] as const).some(
          (key) => this.browser!.connection[key] !== stored.connection?.[key],
        ))
    )
      throw new BrowserSessionError(
        'The runtime browser binding changed. Release the original session or use a new key.',
      );
    if (record.configHash !== this.configHash)
      throw new BrowserSessionError(
        'Browser session configuration changed. Release the old session or use a new key.',
      );
  }

  private async open(signal?: AbortSignal) {
    const unlock = await this.lock(signal);
    try {
      this.record = await readSessionRecord(this.path);
      if (this.record) {
        this.validateRecordIdentity(this.record);
        if (this.record.ended === 'expired' || this.record.ended === 'lost')
          throw new BrowserSessionError(
            `The original browser session ${this.record.ended === 'expired' ? 'expired' : 'was lost'}. No replacement was created. Release it explicitly or use a new key.`,
            undefined,
            this.record.ended === 'expired' ? 'session_expired' : undefined,
          );
        if (this.record.ended || !this.record.port)
          throw new BrowserSessionError(
            'The previous browser session ended or startup was uncertain. Inspect the provider, then explicitly release it or use a new key.',
            undefined,
            this.record.ended === 'closed' ? undefined : 'session_cleanup_partial',
          );
      } else {
        if (this.config.session?.backend && !this.config.session.backend.create && !this.browser)
          throw new BrowserSessionError(
            'A runtime browser binding is required to start this managed session.',
          );
        this.record = {
          token: randomBytes(32).toString('hex'),
          configHash: this.configHash,
          ...(this.browser ? { binding: this.browser } : {}),
        };
        // Persist before creation: an ambiguous paid-provider failure must not trigger a new create on retry.
        await writeSessionRecord(this.path, this.record);
        if (signal?.aborted) {
          // No worker or provider has started, so this record cannot represent an uncertain create.
          await rm(this.path, { force: true });
          this.record = undefined;
          signal.throwIfAborted();
        }
        const workerPath = fileURLToPath(new URL('./session-worker.js', import.meta.url));
        const child = spawn(
          process.env.PI_BROWSER_USE_NODE?.trim() || process.execPath,
          [workerPath],
          {
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: buildSubprocessEnv(
              process.env,
              this.config.envAllowlist,
              this.config.envBlocklist,
            ) as NodeJS.ProcessEnv,
          },
        );
        let initializationSent = false;
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () =>
                done(
                  new BrowserSessionError(
                    'Browser session startup timed out; inspect the provider before retrying.',
                    new DOMException('Startup deadline exceeded', 'TimeoutError'),
                  ),
                ),
              60_000,
            );
            const abort = () => done(signal?.reason);
            const done = (error?: unknown) => {
              clearTimeout(timeout);
              signal?.removeEventListener('abort', abort);
              if (error) reject(error);
              else resolve();
            };
            child.once('error', () =>
              done(new BrowserSessionError('Could not start the browser session process.')),
            );
            child.once('exit', () =>
              done(new BrowserSessionError('Browser session process exited during startup.')),
            );
            child.once('message', (message) => {
              const value = message as { ready?: boolean };
              done(
                value.ready
                  ? undefined
                  : new BrowserSessionError(
                      'Browser session startup failed; inspect the provider before retrying.',
                    ),
              );
            });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
              abort();
              return;
            }
            initializationSent = true;
            child.send({ config: this.config, path: this.path, record: this.record });
          });
        } catch (error) {
          child.kill('SIGTERM');
          if (!initializationSent && signal?.aborted) {
            await rm(this.path, { force: true });
            this.record = undefined;
          }
          throw error;
        } finally {
          if (child.connected) child.disconnect();
          child.unref();
        }
        this.record = await readSessionRecord(this.path);
      }
    } finally {
      await unlock();
    }
    // The worker owns client exclusion; a stalled attach must not strand the startup lock.
    this.attachAttempted = true;
    await this.request('attach', { pid: process.pid }, signal);
    this.connected = true;
    const heartbeat = setInterval(() => {
      void this.request('heartbeat').catch(() => {
        if (this.heartbeat !== heartbeat) return;
        this.connected = false;
        clearInterval(heartbeat);
        this.heartbeat = undefined;
      });
    }, 5000);
    this.heartbeat = heartbeat;
    heartbeat.unref();
  }

  private async request<T = unknown>(
    action: string,
    data: object = {},
    signal?: AbortSignal,
    record = this.record,
    timeoutMs = 65_000,
  ): Promise<T> {
    if (!record?.port)
      throw new BrowserSessionError('The original browser session is unavailable.');
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${record.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...data, action, owner: this.owner }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      const result = (await response.json()) as {
        error?: string;
        code?: SessionRefusalCode;
        errorCategory?: string;
        httpStatus?: number;
        result?: unknown;
      };
      if (!response.ok)
        throw new BrowserSessionError(
          typeof result.error === 'string'
            ? result.error.slice(0, 512)
            : 'Browser session operation failed.',
          Object.assign(new Error(), {
            errorCategory: result.errorCategory,
            httpStatus: result.httpStatus,
          }),
          result.code,
        );
      return result.result as T;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof BrowserSessionError || error instanceof SafeToolError) throw error;
      throw new SafeToolError(
        'Browser session request',
        error,
        action === 'status'
          ? 'Retry the status query or check whether the worker is still running.'
          : 'The original browser session has not been replaced. The action may have completed; inspect the current page before retrying.',
      );
    }
  }

  async listAllTools(signal?: AbortSignal): Promise<Tool[]> {
    await this.connect(signal);
    return this.request<Tool[]>('tools', {}, signal);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    try {
      await this.connect(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BrowserToolNotDispatched(error);
    }
    return this.request<Awaited<ReturnType<DevToolsClient['callTool']>>>(
      'call',
      { name, args },
      signal,
    );
  }

  async control(action: SessionAction, signal?: AbortSignal): Promise<object> {
    signal?.throwIfAborted();
    if (action === 'status') {
      if (!(await isProtectedSessionDirectory(dirname(this.path)))) return { state: 'not-started' };
      const record = await readSessionRecord(this.path);
      signal?.throwIfAborted();
      if (!record) return { state: 'not-started' };
      this.validateRecordIdentity(record);
      if (record.ended) return { state: record.ended };
      if (!record.port) return { state: 'unavailable' };
      return this.request<object>('status', {}, signal, record, 5000);
    }
    if (action === 'release' && !this.connected) {
      const unlock = await this.lock(signal);
      try {
        const record = await readSessionRecord(this.path);
        if (!record) return { state: 'released' };
        const backend = this.config.session?.backend;
        if (
          record.ended === 'cleanup-failed' &&
          record.configHash === this.configHash &&
          backend?.retryRelease === true &&
          record.cleanup?.markerRemoved === true &&
          record.cleanup.transportClosed === true &&
          record.cleanup.providerReleased === false &&
          record.managed
        ) {
          this.validateRecordIdentity(record);
          const releaseSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000);
          try {
            if (!hasKnownBrowserId(record.managed))
              throw new BrowserSessionError('The recorded provider instance ID is invalid.');
            const adapter = createHttpBrowserAdapter(backend, record.binding);
            await adapter.release(record.managed, releaseSignal);
            await rm(this.path, { force: true });
            return { state: 'released' };
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            throw new BrowserSessionError(
              'Provider cleanup is still incomplete. Inspect the provider before continuing.',
              error,
              'session_cleanup_partial',
            );
          }
        }
        if (
          (!record.port && !record.ended) ||
          ['cleanup-failed', 'startup-failed'].includes(record.ended ?? '')
        ) {
          throw new BrowserSessionError(
            'Provider startup or cleanup was uncertain. Inspect the protected session record and provider before manually resetting this session.',
            undefined,
            'session_cleanup_partial',
          );
        }
        if (record.ended || !record.port) {
          await rm(this.path, { force: true });
          return {
            state: 'released',
            providerCleanup: 'verify-if-startup-or-cleanup-was-uncertain',
          };
        }
      } finally {
        await unlock();
      }
    }
    await this.connect(signal);
    try {
      const result = await this.request<object>(action, {}, signal);
      if (action === 'release' && 'state' in result && result.state === 'released')
        this.clearAttachment();
      return result;
    } catch (error) {
      if (
        action === 'release' &&
        this.config.session?.enabled &&
        this.config.session.localParkingMs !== undefined &&
        error instanceof BrowserSessionError &&
        error.code === 'session_cleanup_partial'
      )
        this.clearAttachment();
      throw error;
    }
  }

  private clearAttachment() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.connected = false;
    this.attachAttempted = false;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.detach();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }

  private async detach() {
    // A failed attach response may still have established ownership in the worker.
    await this.connecting?.catch(() => undefined);
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (!this.record?.port || !this.attachAttempted) return;
    try {
      await this.request('detach');
    } finally {
      this.connected = false;
      this.attachAttempted = false;
    }
  }
}
