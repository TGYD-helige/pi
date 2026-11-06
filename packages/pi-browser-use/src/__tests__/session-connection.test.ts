import { createServer, request } from 'node:http';
import { connect, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserConnection } from '../session-connection.js';

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, createServer: vi.fn(actual.createServer), request: vi.fn(actual.request) };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, connect: vi.fn(actual.connect) };
});

describe('browser session connection', () => {
  afterEach(() => {
    vi.mocked(connect).mockReset();
  });

  it('replaces a loopback listener that the browser subprocess cannot reach', async () => {
    const probe = vi.mocked(connect).mockImplementationOnce(() => {
      const socket = new Socket();
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')));
      return socket;
    });
    const tunnel = await createBrowserConnection(
      { wsEndpoint: 'ws://127.0.0.1:9222' },
      new AbortController().signal,
    );
    try {
      expect(probe).toHaveBeenCalledTimes(2);
      const endpoint = new URL(tunnel.wsEndpoint);
      const response = await fetch(`http://${endpoint.host}`);
      expect(response.status).toBe(403);
    } finally {
      await tunnel.close();
    }
  });

  it('closes the unpublished listener and its pending requests when aborted during the probe', async () => {
    const { connect: realConnect } = await vi.importActual<typeof import('node:net')>('node:net');
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const server = createServer();
    vi.mocked(createServer).mockReturnValueOnce(server);
    server.once('connection', (socket) => socket.once('data', () => controller.abort(reason)));
    let peer: Socket | undefined;
    vi.mocked(connect).mockImplementationOnce((port) => {
      const socket = realConnect(Number(port), '127.0.0.1');
      peer = socket;
      socket.on('error', () => {});
      socket.write('GET / HTTP/1.1\r\nHost:');
      return new Socket();
    });
    const result = expect(
      createBrowserConnection({ wsEndpoint: 'ws://127.0.0.1:9222' }, controller.signal),
    ).rejects.toBe(reason);
    try {
      await vi.waitFor(() => expect(peer?.destroyed).toBe(true));
    } finally {
      peer?.destroy();
      await result;
    }
  });

  it.each([
    { Authorization: 'secret\nvalue' },
    { 'invalid header': 'secret' },
    { Authorization: 'secret\u0100' },
  ])('rejects invalid CDP headers before creating a tunnel (%j)', async (headers) => {
    const result = await createBrowserConnection(
      { wsEndpoint: 'ws://127.0.0.1:9222', wsHeaders: JSON.stringify(headers) },
      new AbortController().signal,
    ).then(
      async (tunnel) => {
        await tunnel.close();
        return 'accepted';
      },
      (error: Error) => error.message,
    );
    expect(result).toBe(
      'Browser wsHeaders must contain valid HTTP header names and string values.',
    );
  });

  it('closes the tunnel safely when provider request construction throws', async () => {
    vi.mocked(request).mockImplementationOnce(() => {
      throw new Error('secret-provider-data');
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tunnel = await createBrowserConnection(
      { wsEndpoint: 'ws://127.0.0.1:9222' },
      new AbortController().signal,
    );
    const endpoint = new URL(tunnel.wsEndpoint);
    const local = connect(Number(endpoint.port), '127.0.0.1');
    local.on('error', () => {});
    try {
      local.write(
        `GET ${endpoint.pathname} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
      await vi.waitFor(() => expect(tunnel.alive).toBe(false));
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        '[pi-browser-use] browser connection handshake failed',
      );
    } finally {
      local.destroy();
      await tunnel.close();
      diagnostic.mockRestore();
    }
  });

  it('cancels a pending provider upgrade when the tunnel closes', async () => {
    let upstream: Duplex | undefined;
    let received!: () => void;
    const requested = new Promise<void>((resolve) => {
      received = resolve;
    });
    const provider = createServer();
    provider.on('upgrade', (_request, socket) => {
      upstream = socket;
      socket.on('error', () => {});
      socket.resume();
      received();
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw Error('Missing provider address');
    const tunnel = await createBrowserConnection(
      { wsEndpoint: `ws://127.0.0.1:${address.port}` },
      new AbortController().signal,
    );
    const endpoint = new URL(tunnel.wsEndpoint);
    const local = connect(Number(endpoint.port), '127.0.0.1');
    local.on('error', () => {});
    try {
      local.write(
        `GET ${endpoint.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      await requested;
      await tunnel.close();

      await vi.waitFor(() => expect(upstream?.readableEnded).toBe(true), { timeout: 500 });
      expect(tunnel.alive).toBe(false);
    } finally {
      local.destroy();
      upstream?.destroy();
      await tunnel.close();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});
