import { lookup as nodeLookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { DnsLookup } from '@amaster.ai/pi-shared';
import { resolvePublicHttpUrl } from '@amaster.ai/pi-shared';
import type { BrowserReadPolicyV1 } from './config.js';

const defaultLookup: DnsLookup = async (hostname) =>
  nodeLookup(hostname, { all: true, verbatim: true });

export type BrowserProxyTarget = {
  hostname: string;
  address: string;
  family: number;
  port: number;
};

function defaultPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

async function resolveAnyAddress(
  hostname: string,
  lookup: DnsLookup,
): Promise<{
  address: string;
  family: number;
}> {
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname);
  const target = addresses[0];
  if (!target) throw new Error('Browser policy proxy could not resolve the destination.');
  return target;
}

export async function resolveBrowserProxyTarget(
  locator: string | URL,
  policy: BrowserReadPolicyV1,
  lookup: DnsLookup = defaultLookup,
): Promise<BrowserProxyTarget> {
  const url = locator instanceof URL ? new URL(locator) : new URL(locator);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Browser policy proxy requires an HTTP(S) destination.');
  }

  const signedPrivateOrigin =
    policy.accessMode === 'authenticated' && policy.allowedTopLevelOrigins.includes(url.origin);
  const target = signedPrivateOrigin
    ? await resolveAnyAddress(url.hostname, lookup)
    : (await resolvePublicHttpUrl(url, lookup)).addresses[0];
  if (!target) throw new Error('Browser policy proxy could not resolve the destination.');
  return {
    hostname: url.hostname,
    address: target.address,
    family: target.family,
    port: defaultPort(url),
  };
}

function safeProxyFailure(socket: Socket | Duplex): void {
  if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
}

function absoluteHttpUrl(request: IncomingMessage): URL {
  const url = new URL(request.url ?? '');
  if (url.protocol !== 'http:') {
    throw new Error('Browser policy proxy accepts HTTPS only through CONNECT.');
  }
  return url;
}

export type BrowserPolicyProxy = {
  url: string;
  close(): Promise<void>;
};

export async function startBrowserPolicyProxy(
  policy: BrowserReadPolicyV1,
  lookup: DnsLookup = defaultLookup,
): Promise<BrowserPolicyProxy> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = absoluteHttpUrl(request);
        const target = await resolveBrowserProxyTarget(url, policy, lookup);
        const headers = { ...request.headers };
        delete headers['proxy-connection'];
        const outgoing = httpRequest(
          {
            host: target.address,
            family: target.family,
            port: target.port,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
          },
        );
        outgoing.once('error', () => response.destroy());
        request.pipe(outgoing);
      } catch {
        response.writeHead(502, { connection: 'close' });
        response.end();
      }
    })();
  });

  server.on('connect', (request, clientSocket, head) => {
    void (async () => {
      try {
        const connectUrl = new URL(`https://${request.url ?? ''}/`);
        const target = await resolveBrowserProxyTarget(connectUrl, policy, lookup);
        const upstream = netConnect({
          host: target.address,
          family: target.family,
          port: target.port,
        });
        upstream.once('connect', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.once('error', () => safeProxyFailure(clientSocket));
        clientSocket.once('error', () => upstream.destroy());
      } catch {
        safeProxyFailure(clientSocket);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Browser policy proxy failed to bind a local port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
