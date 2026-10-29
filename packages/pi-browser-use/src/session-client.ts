import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveHome } from '@amaster.ai/pi-shared/settings';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserUseConfig } from './config.js';
import { buildSubprocessEnv } from './config.js';
import type { DevToolsClient } from './index.js';
import { createHttpBrowserAdapter, type ManagedBrowser } from './session-backend.js';
import { BrowserSessionError, type SessionAction } from './session-control.js';

export interface SessionRecord {
  port?: number;
  token: string;
  configHash: string;
  ended?: string;
  managed?: ManagedBrowser;
  binding?: ManagedBrowser;
}

export async function writeSessionRecord(path: string, record: SessionRecord) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
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
  private readonly path: string;
  private readonly configHash: string;

  constructor(
    private readonly config: BrowserUseConfig,
    private readonly browser?: ManagedBrowser,
  ) {
    if (!config.session?.enabled)
      throw new BrowserSessionError('Browser session retention is not configured.');
    if (browser) {
      if (!config.session.backend || config.session.adapterModule)
        throw new BrowserSessionError(
          'A runtime browser binding requires an HTTP lifecycle backend.',
        );
      createHttpBrowserAdapter(config.session.backend, browser);
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

  private async readRecord() {
    try {
      const stat = await lstat(this.path);
      if (
        !stat.isFile() ||
        (process.platform !== 'win32' &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      ) {
        throw new BrowserSessionError('Browser session record permissions are unsafe.');
      }
      if (stat.size > 131_072) throw new BrowserSessionError('Browser session record is invalid.');
      const value = JSON.parse(await readFile(this.path, 'utf8')) as SessionRecord;
      if (
        !/^[a-f0-9]{64}$/.test(value.token) ||
        typeof value.configHash !== 'string' ||
        (value.ended !== undefined &&
          !['closed', 'expired', 'lost', 'cleanup-failed', 'startup-failed'].includes(
            value.ended,
          )) ||
        (value.port !== undefined &&
          (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535))
      ) {
        throw new BrowserSessionError('Browser session record is invalid.');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof BrowserSessionError) throw error;
      throw new BrowserSessionError('Could not read the browser session record.');
    }
  }

  private async lock(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32' && stat.uid !== process.getuid?.()))
      throw new BrowserSessionError('Browser session directory ownership is unsafe.');
    await chmod(directory, 0o700);
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

  private async open(signal?: AbortSignal) {
    const unlock = await this.lock(signal);
    try {
      this.record = await this.readRecord();
      if (this.record) {
        const stored = this.record.binding;
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
        if (this.record.configHash !== this.configHash)
          throw new BrowserSessionError(
            'Browser session configuration changed. Release the old session or use a new key.',
          );
        if (this.record.ended === 'expired' || this.record.ended === 'lost')
          throw new BrowserSessionError(
            `The original browser session ${this.record.ended === 'expired' ? 'expired' : 'was lost'}. No replacement was created. Release it explicitly or use a new key.`,
          );
        if (this.record.ended || !this.record.port)
          throw new BrowserSessionError(
            'The previous browser session ended or startup was uncertain. Inspect the provider, then explicitly release it or use a new key.',
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
        this.record = await this.readRecord();
      }
    } finally {
      await unlock();
    }
    // The worker owns client exclusion; a stalled attach must not strand the startup lock.
    this.attachAttempted = true;
    await this.request('attach', { pid: process.pid }, signal);
    this.connected = true;
    this.heartbeat = setInterval(() => {
      void this.request('heartbeat').catch(() => {
        this.connected = false;
        clearInterval(this.heartbeat);
      });
    }, 5000);
    this.heartbeat.unref();
  }

  private async request<T = unknown>(
    action: string,
    data: object = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.record?.port)
      throw new BrowserSessionError('The original browser session is unavailable.');
    try {
      const response = await fetch(`http://127.0.0.1:${this.record.port}/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.record.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...data, action, owner: this.owner }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(65_000)])
          : AbortSignal.timeout(65_000),
        redirect: 'error',
      });
      const result = (await response.json()) as { error?: string; result?: unknown };
      if (!response.ok)
        throw new BrowserSessionError(
          typeof result.error === 'string'
            ? result.error.slice(0, 512)
            : 'Browser session operation failed.',
        );
      return result.result as T;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof BrowserSessionError) throw error;
      throw new BrowserSessionError(
        'The original browser session connection was lost. It has not been replaced.',
      );
    }
  }

  async listAllTools(signal?: AbortSignal): Promise<Tool[]> {
    await this.connect(signal);
    return this.request<Tool[]>('tools', {}, signal);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.connect(signal);
    return this.request<Awaited<ReturnType<DevToolsClient['callTool']>>>(
      'call',
      { name, args },
      signal,
    );
  }

  async control(action: SessionAction, signal?: AbortSignal): Promise<object> {
    signal?.throwIfAborted();
    if (action === 'release' && !this.connected) {
      const unlock = await this.lock(signal);
      try {
        const record = await this.readRecord();
        if (!record) return { state: 'released' };
        if (
          (!record.port && !record.ended) ||
          ['cleanup-failed', 'startup-failed'].includes(record.ended ?? '')
        ) {
          throw new BrowserSessionError(
            'Provider startup or cleanup was uncertain. Inspect the protected session record and provider before manually resetting this session.',
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
    return this.request<object>(action, {}, signal);
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
    if (!this.record?.port || !this.attachAttempted) return;
    try {
      await this.request('detach');
    } finally {
      this.connected = false;
      this.attachAttempted = false;
    }
  }
}
