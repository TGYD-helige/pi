import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { createBrowserAdapter } from './adapter.js';
import { type BrowserUseConfig, resolveConfig } from './config.js';
import { DevToolsClient } from './index.js';
import {
  BrowserAcquisitionError,
  type BrowserLifecycleAdapter,
  type ManagedBrowser,
  validateBrowserBinding,
  validateBrowserExpiry,
} from './session-backend.js';
import { createBrowserConnection } from './session-connection.js';
import { BrowserSessionError, scriptValue } from './session-control.js';

const MAX_BYTES = 32 * 1024 * 1024;
const OPERATION_MS = 60_000;

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BrowserSessionError('Browser session cleanup timed out.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function hasKnownId(browser: ManagedBrowser) {
  return (
    typeof browser?.id === 'string' && browser.id.trim().length > 0 && browser.id.length <= 1024
  );
}

/** SDK hosts can run this in their own long-lived process and inject an adapter. */
export async function serveBrowserSession(
  config: BrowserUseConfig,
  token: string,
  options: {
    adapter?: BrowserLifecycleAdapter;
    browser?: ManagedBrowser;
    onAcquire?: (browser: ManagedBrowser) => Promise<void>;
    onStop?: (reason: 'closed' | 'expired' | 'lost' | 'cleanup-failed') => Promise<void>;
  } = {},
) {
  const session = config.session;
  if (!session?.enabled)
    throw new BrowserSessionError('Browser session retention is not configured.');
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new BrowserSessionError('Browser session transport requires a random 32-byte hex token.');
  const retentionMs = session.retentionMs;
  const adapter = await createBrowserAdapter(config, options);
  let managed: ManagedBrowser | undefined;
  let acquiring: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let replacing: Promise<void> | undefined;
  let acquisitionFailed = false;
  let browserCleanupFailed = false;
  let browserUsed = false;
  let connection: Awaited<ReturnType<typeof createBrowserConnection>> | undefined;
  const startupSignal = AbortSignal.timeout(OPERATION_MS);
  const { session: _session, ...directConfig } = config;
  let client = new DevToolsClient(directConfig);
  let owner: string | undefined;
  let ownerPid: number | undefined;
  let attachedOnce = false;
  let resumed = false;
  const startedAt = Date.now();
  let lastSeen = Date.now();
  let expiresAt: number | undefined;
  let hardDeadline: number | undefined;
  let marker: { pageId: number; nonce: string } | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let sweepScheduled = false;
  let mutations = Promise.resolve<unknown>(undefined);
  const lifetime = new AbortController();

  function ownerExited() {
    if (!ownerPid) return false;
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  function releaseManaged() {
    if (managed)
      releasing ??= bounded(
        Promise.resolve().then(() => adapter!.release(managed!, AbortSignal.timeout(15_000))),
        15_000,
      );
    return releasing;
  }

  async function closeBrowser(
    closingClient: DevToolsClient | undefined,
    closingConnection: Awaited<ReturnType<typeof createBrowserConnection>> | undefined,
  ) {
    const results = await Promise.allSettled(
      [() => closingClient?.close(), () => closingConnection?.close()].map((close) =>
        bounded(Promise.resolve().then(close), 15_000),
      ),
    );
    if (results.some((result) => result.status === 'rejected')) {
      browserCleanupFailed = true;
      console.error(
        '[pi-browser-use] browser session cleanup failed; provider inspection may be required',
      );
    }
  }

  function status() {
    let state = browserUsed ? 'active' : 'idle';
    if (expiresAt) state = expiresAt > Date.now() ? 'retained' : 'expired';
    return {
      state,
      resumed,
      strategy: 'held-connection',
      ownership: adapter.ownership ?? 'adapter',
      providerDeadlineKnown: hardDeadline !== undefined,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(hardDeadline ? { providerExpiresAt: new Date(hardDeadline).toISOString() } : {}),
    };
  }

  async function stop(reason: 'closed' | 'expired' | 'lost' = 'closed') {
    if (stopping) return stopping;
    stopped = true;
    lifetime.abort();
    stopping = (async () => {
      clearInterval(sweep);
      if (acquiring) {
        try {
          await bounded(acquiring, 15_000);
        } catch {
          acquisitionFailed = true;
        }
      }
      let outcome: typeof reason | 'cleanup-failed' =
        acquisitionFailed && !managed ? 'cleanup-failed' : reason;
      if (replacing) {
        try {
          await bounded(
            replacing.catch(() => {}),
            15_000,
          );
        } catch {
          outcome = 'cleanup-failed';
        }
      }
      if (marker && reason !== 'lost' && adapter.ownership === 'external') {
        try {
          if (client.getState() !== 'ready')
            throw new BrowserSessionError('The marker connection is no longer available.');
          await bounded(removeMarker(AbortSignal.timeout(5000)), 5000);
        } catch {
          outcome = 'cleanup-failed';
          console.error('[pi-browser-use] could not remove the browser session marker');
        }
      }
      await closeBrowser(client, connection);
      if (browserCleanupFailed) outcome = 'cleanup-failed';
      try {
        await releaseManaged();
      } catch {
        outcome = 'cleanup-failed';
        console.error(
          '[pi-browser-use] provider cleanup failed; the protected session record contains recovery metadata',
        );
      }
      try {
        await options.onStop?.(outcome);
      } catch {
        console.error('[pi-browser-use] could not save browser session cleanup status');
      } finally {
        if (server.listening) server.close();
        server.closeIdleConnections();
      }
    })();
    return stopping;
  }

  async function ensureBrowser(signal: AbortSignal) {
    if (acquisitionFailed)
      throw new BrowserSessionError(
        'Browser creation had an uncertain outcome. Inspect the provider before starting another session.',
      );
    if (!managed) {
      try {
        acquiring = (async () => {
          try {
            const acquired = await adapter.acquire(config, signal);
            if (hasKnownId(acquired)) managed = acquired;
            validateBrowserBinding(acquired, adapter.ownership);
            hardDeadline = acquired.expiresAt;
          } catch (error) {
            if (error instanceof BrowserAcquisitionError && hasKnownId(error.browser))
              managed = error.browser;
            throw error;
          } finally {
            if (managed) {
              await options.onAcquire?.(managed);
              if (stopped) await releaseManaged();
            }
          }
        })();
        await abortable(acquiring, signal);
      } catch {
        acquisitionFailed = true;
        throw new BrowserSessionError(
          'Browser creation failed; its outcome may be unknown. Inspect the provider before retrying.',
        );
      }
    }
    signal.throwIfAborted();
    if (!browserUsed) {
      const resolved = managed!.connection;
      // Keep the discovery transport when the acquired launch configuration is unchanged.
      if (
        !resolved.wsEndpoint &&
        !resolved.browserUrl &&
        isDeepStrictEqual(resolveConfig(resolved), resolveConfig(directConfig))
      ) {
        browserUsed = true;
        return;
      }
      replacing = (async () => {
        const nextConnection =
          resolved.wsEndpoint || resolved.browserUrl
            ? await createBrowserConnection(resolved, signal)
            : undefined;
        const {
          wsEndpoint: _ws,
          browserUrl: _url,
          wsHeaders: _headers,
          userDataDir: _profile,
          executablePath: _executable,
          channel: _channel,
          isolated: _isolated,
          autoConnect: _autoConnect,
          ...localConfig
        } = directConfig;
        // Provider connections must not inherit local-launch/discovery flags.
        let nextClient: DevToolsClient | undefined;
        try {
          signal.throwIfAborted();
          if (stopped) throw new BrowserSessionError('The browser session has ended.');
          await client.close();
          nextClient = new DevToolsClient(
            nextConnection
              ? {
                  ...localConfig,
                  sessionMode: 'existing',
                  wsEndpoint: nextConnection.wsEndpoint,
                }
              : resolved,
          );
          if (nextConnection) await nextClient.connect(signal);
          signal.throwIfAborted();
          if (stopped) throw new BrowserSessionError('The browser session has ended.');
          client = nextClient;
          connection = nextConnection;
        } catch (error) {
          await closeBrowser(nextClient, nextConnection);
          throw error;
        }
      })();
      try {
        await replacing;
      } finally {
        replacing = undefined;
      }
    }
    browserUsed = true;
  }

  async function verify(signal: AbortSignal) {
    if (connection && !connection.alive)
      throw new BrowserSessionError(
        'The original CDP connection was lost. No replacement browser was created.',
      );
    if (adapter.describe && managed) {
      const description = await abortable(adapter.describe(managed, signal), signal);
      if (!description || typeof description.alive !== 'boolean')
        throw new BrowserSessionError('The browser backend returned an invalid live status.');
      validateBrowserExpiry(description.expiresAt);
      if (!description.alive)
        throw new BrowserSessionError(
          'The original browser is no longer alive. Start a new session explicitly.',
        );
      if (description.expiresAt !== undefined) hardDeadline = description.expiresAt;
    }
    if (hardDeadline !== undefined && hardDeadline <= Date.now())
      throw new BrowserSessionError('The provider browser deadline has expired.');
    if (
      marker &&
      scriptValue(
        await client.callTool(
          'evaluate_script',
          {
            pageId: marker.pageId,
            function: `() => globalThis.__piBrowserRetention === ${JSON.stringify(marker.nonce)}`,
          },
          signal,
        ),
      ) !== true
    )
      throw new BrowserSessionError(
        'The original live browser was lost. Profile restoration is not live-session recovery.',
      );
  }

  async function removeMarker(signal: AbortSignal) {
    if (!marker) return;
    await client.removeSessionMarker(marker.pageId, marker.nonce, signal);
    marker = undefined;
  }

  async function dispatch(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (stopped) throw new BrowserSessionError('The browser session has ended.');
    const action = input.action;
    if (action === 'attach') {
      if (typeof input.owner !== 'string' || !/^[a-f0-9]{64}$/.test(input.owner))
        throw new BrowserSessionError('Invalid browser session client.');
      if (
        input.pid !== undefined &&
        (!Number.isSafeInteger(input.pid) || (input.pid as number) < 1)
      )
        throw new BrowserSessionError('Invalid browser session client process.');
      if (ownerExited()) owner = undefined;
      if (owner && owner !== input.owner)
        throw new BrowserSessionError('This browser session is already in use by another client.');
      if (expiresAt && expiresAt <= Date.now())
        throw new BrowserSessionError('The retained browser has expired.');
      if (expiresAt) await verify(signal);
      owner = input.owner;
      ownerPid = input.pid as number | undefined;
      resumed = attachedOnce && expiresAt !== undefined;
      attachedOnce = true;
      lastSeen = Date.now();
      // Keep the deadline until explicit release, including a subsequent client crash.
      return status();
    }
    if (!owner || input.owner !== owner)
      throw new BrowserSessionError('Browser session client is not attached.');
    lastSeen = Date.now();
    if (action === 'heartbeat') return {};
    if (action === 'detach') {
      owner = undefined;
      if (!expiresAt || expiresAt <= Date.now()) await stop(expiresAt ? 'expired' : 'closed');
      return {};
    }
    if (action === 'status') {
      if (marker || connection) await verify(signal);
      return status();
    }
    if (action === 'retain') {
      if (!browserUsed)
        throw new BrowserSessionError('Use the browser before requesting live-page retention.');
      await verify(signal);
      if (!marker && !connection) {
        const nonce = randomBytes(24).toString('hex');
        const url = `about:blank#pi-retained-session-${nonce}`;
        const result = await client.callTool(
          'new_page',
          { url: 'about:blank', background: true },
          signal,
        );
        const text =
          result.content
            ?.filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n') ?? '';
        const match = /^(\d+): about:blank \[selected\]/m.exec(text);
        if (result.isError || !match)
          throw new BrowserSessionError(
            'Could not establish live-browser identity; retention was not enabled.',
          );
        marker = { pageId: Number(match[1]), nonce };
        scriptValue(
          await client.callTool(
            'evaluate_script',
            {
              pageId: marker.pageId,
              function: `() => { history.replaceState(null, "", ${JSON.stringify(url)}); globalThis.__piBrowserRetention = ${JSON.stringify(nonce)}; return true; }`,
            },
            signal,
          ),
        );
      }
      // Repeated retain is idempotent, not an unbounded renewal mechanism.
      let effective = expiresAt ?? Date.now() + retentionMs;
      if (adapter.retain && managed && !expiresAt) {
        const retained = await abortable(adapter.retain(managed, effective, signal), signal);
        if (!retained || retained.expiresAt === undefined)
          throw new BrowserSessionError('The browser backend returned no retention deadline.');
        validateBrowserExpiry(retained.expiresAt);
        effective = Math.min(effective, retained.expiresAt);
      }
      if (hardDeadline !== undefined) effective = Math.min(effective, hardDeadline);
      if (!Number.isFinite(effective) || effective <= Date.now())
        throw new BrowserSessionError(
          'The provider cannot retain this browser beyond its current deadline.',
        );
      expiresAt = effective;
      return status();
    }
    if (action === 'release') {
      expiresAt = undefined;
      await removeMarker(signal);
      return status();
    }
    if (action === 'tools') return client.listAllTools(signal);
    if (action === 'call') {
      if (
        typeof input.name !== 'string' ||
        !input.args ||
        typeof input.args !== 'object' ||
        Array.isArray(input.args)
      )
        throw new BrowserSessionError('Invalid browser tool request.');
      await ensureBrowser(signal);
      if (marker || connection) await verify(signal);
      return client.callTool(input.name, input.args as Record<string, unknown>, signal);
    }
    throw new BrowserSessionError('Unknown browser session operation.');
  }

  const server = createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/' ||
      req.headers.origin ||
      req.headers.authorization !== `Bearer ${token}`
    ) {
      res.writeHead(403).end();
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      lifetime.signal,
      AbortSignal.timeout(OPERATION_MS),
    ]);
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES)
          throw new BrowserSessionError('Browser session request is too large.');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new BrowserSessionError('Invalid browser session request.');
      if (owner && input.owner === owner) lastSeen = Date.now();
      const work = mutations.then(() => {
        signal.throwIfAborted();
        return dispatch(input, signal);
      });
      mutations = work.catch(() => {});
      const result = await work;
      const body = JSON.stringify({ result });
      if (Buffer.byteLength(body) > MAX_BYTES)
        throw new BrowserSessionError('Browser result exceeded the session transport limit.');
      res.end(body);
    } catch (error) {
      if (!(error instanceof BrowserSessionError))
        console.error('[pi-browser-use] browser session operation failed');
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error:
            error instanceof BrowserSessionError
              ? error.message
              : 'Browser session operation failed.',
        }),
      );
    }
  });
  server.requestTimeout = OPERATION_MS;
  server.headersTimeout = 10_000;
  const sweep = setInterval(() => {
    if (stopped || sweepScheduled) return;
    sweepScheduled = true;
    mutations = mutations
      .then(async () => {
        if (!attachedOnce && Date.now() - startedAt < OPERATION_MS) return;
        // Heartbeats track client liveness; they never extend the retention deadline.
        if (owner && (ownerExited() || Date.now() - lastSeen > 30_000)) owner = undefined;
        const expired = hardDeadline !== undefined && Date.now() >= hardDeadline;
        if (connection && !connection.alive) await stop('lost');
        else if (expired || (!owner && (!expiresAt || Date.now() >= expiresAt)))
          await stop(expired || expiresAt ? 'expired' : 'closed');
        else if (!owner && marker && !connection) {
          try {
            await bounded(
              verify(AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])),
              5000,
            );
          } catch {
            await stop('lost');
          }
        }
      })
      .catch(() => console.error('[pi-browser-use] browser session expiry cleanup failed'))
      .finally(() => {
        sweepScheduled = false;
      });
  }, 1000);
  try {
    await client.connect(startupSignal);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await stop('lost');
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new BrowserSessionError('Could not start browser session transport.');
  return { port: address.port, stop };
}
