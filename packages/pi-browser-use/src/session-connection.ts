import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { BrowserUseConfig } from './config.js';
import { BrowserSessionError } from './session-control.js';

export function parseBrowserHeaders(value?: string): Record<string, string> {
  try {
    const headers = value ? (JSON.parse(value) as unknown) : {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
    for (const [name, header] of Object.entries(headers)) {
      if (typeof header !== 'string') throw new Error();
      validateHeaderName(name);
      validateHeaderValue(name, header);
    }
    return headers as Record<string, string>;
  } catch {
    throw new BrowserSessionError(
      'Browser wsHeaders must contain valid HTTP header names and string values.',
    );
  }
}

/** Single-use WebSocket tunnel: never redial a launch URL after losing the original browser. */
export async function createBrowserConnection(config: BrowserUseConfig, signal: AbortSignal) {
  const headers = parseBrowserHeaders(config.wsHeaders);
  let endpoint = config.wsEndpoint;
  if (!endpoint && config.browserUrl) {
    const url = new URL(config.browserUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/json/version`;
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: 'error',
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 65_536) {
      await response.body?.cancel();
      throw new BrowserSessionError('Could not discover the browser CDP endpoint.');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65_536) {
          await reader.cancel();
          throw new BrowserSessionError('Browser discovery response exceeded 64 KiB.');
        }
        chunks.push(chunk.value);
      }
    endpoint = (
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as { webSocketDebuggerUrl?: string }
    ).webSocketDebuggerUrl;
  }
  if (!endpoint) throw new BrowserSessionError('A remote browser requires a CDP endpoint.');
  const remote = new URL(endpoint);
  if (!['ws:', 'wss:'].includes(remote.protocol))
    throw new BrowserSessionError('Browser CDP endpoint must use WebSocket.');
  remote.protocol = remote.protocol === 'wss:' ? 'https:' : 'http:';
  const path = `/${randomBytes(32).toString('hex')}`;
  let used = false,
    lost = false;
  let localSocket: Duplex | undefined, remoteSocket: Duplex | undefined;
  let pendingRequest: ReturnType<typeof httpRequest> | undefined;
  const server = createServer((_req, res) => res.writeHead(403).end());
  server.headersTimeout = 10_000;
  const fail = () => {
    lost = true;
    signal.removeEventListener('abort', fail);
    pendingRequest?.destroy();
    pendingRequest = undefined;
    localSocket?.destroy();
    remoteSocket?.destroy();
  };
  server.on('upgrade', (req, socket, head) => {
    if (used || lost || req.url !== path || req.headers.origin) {
      socket.destroy();
      return;
    }
    used = true;
    localSocket = socket;
    socket.on('error', fail);
    socket.once('close', fail);
    let request: ReturnType<typeof httpRequest>;
    try {
      request = (remote.protocol === 'https:' ? httpsRequest : httpRequest)(remote, {
        headers: { ...req.headers, ...headers, host: remote.host },
        timeout: 15_000,
      });
    } catch {
      console.error('[pi-browser-use] browser connection handshake failed');
      fail();
      return;
    }
    pendingRequest = request;
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
    request.once('timeout', () => request.destroy());
    request.once('error', () => {
      fail();
    });
    request.once('response', (response) => {
      response.resume();
      fail();
    });
    request.once('upgrade', (response, upstream, upstreamHead) => {
      signal.removeEventListener('abort', fail);
      pendingRequest = undefined;
      upstream.setTimeout(0);
      remoteSocket = upstream;
      upstream.on('error', fail);
      upstream.once('close', fail);
      if (lost || socket.destroyed) {
        upstream.destroy();
        return;
      }
      const responseHeaders = Object.entries(response.headers)
        .flatMap(([name, value]) =>
          value === undefined
            ? []
            : (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}\r\n`),
        )
        .join('');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n`);
      if (head.length) upstream.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(upstream).pipe(socket);
    });
    request.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new BrowserSessionError('Could not start the browser connection tunnel.');
  return {
    wsEndpoint: `ws://127.0.0.1:${address.port}${path}`,
    get alive() {
      return !lost;
    },
    async close() {
      fail();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
