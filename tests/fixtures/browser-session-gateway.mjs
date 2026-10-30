// Real Chrome behind a gateway that closes it one second after the last CDP peer disconnects.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(
  new URL('../../packages/pi-browser-use/package.json', import.meta.url),
);
const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { WebSocket, WebSocketServer } = sdkRequire('ws');
const upstream = dirname(require.resolve('chrome-devtools-mcp/package.json'));
const { puppeteer } = await import(
  pathToFileURL(join(upstream, 'build/src/third_party/index.js')).href
);

export async function createSessionGateway(profileDir) {
  if (process.env.PI_BROWSER_TEST_GATEWAY_MODULE) {
    const { createGateway } = await import(
      pathToFileURL(process.env.PI_BROWSER_TEST_GATEWAY_MODULE).href
    );
    let browser,
      launches = 0;
    const sockets = await mkdtemp('/tmp/pi-browser-gateway-');
    const gateway = await createGateway({
      WebSocket,
      WebSocketServer,
      port: 0,
      dataRoot: join(profileDir, 'registry'),
      socketPath: join(sockets, 'control.sock'),
      healthy: async () => true,
      async launch() {
        launches++;
        browser = await puppeteer.launch({
          channel: 'chrome',
          headless: true,
          userDataDir: join(profileDir, 'chrome'),
          ...(process.env.PI_BROWSER_TEST_EXECUTABLE
            ? { executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE }
            : {}),
        });
        const owned = browser;
        return { endpoint: browser.wsEndpoint(), close: () => owned.close() };
      },
    });
    const executionId = randomUUID();
    const { wsEndpoint } = await gateway.command({
      op: 'register',
      executionId,
      workspace: profileDir,
    });
    return {
      wsEndpoint,
      get launches() {
        return launches;
      },
      killBrowser: () => browser?.close(),
      releaseOwned: () => gateway.command({ op: 'quiesce', executionId }),
      async close() {
        await gateway.stop();
        await rm(sockets, { recursive: true, force: true });
      },
    };
  }
  let browser, starting, idle;
  let launches = 0;
  const peers = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (client) => {
    clearTimeout(idle);
    peers.add(client);
    let remote;
    const pending = [];
    client.on('error', () => {});
    client.on('message', (data, binary) => {
      if (remote?.readyState === WebSocket.OPEN) remote.send(data, { binary });
      else pending.push([data, binary]);
    });
    client.once('close', () => {
      remote?.terminate();
      peers.delete(client);
      if (!peers.size)
        idle = setTimeout(async () => {
          const old = browser;
          browser = undefined;
          starting = undefined;
          await old?.close();
        }, 1000);
    });
    if (!starting)
      starting = (async () => {
        launches++;
        browser = await puppeteer.launch({
          channel: 'chrome',
          headless: true,
          userDataDir: profileDir,
          ...(process.env.PI_BROWSER_TEST_EXECUTABLE
            ? { executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE }
            : {}),
        });
        return browser;
      })();
    starting
      .then((instance) => {
        if (client.readyState !== WebSocket.OPEN) return;
        remote = new WebSocket(instance.wsEndpoint());
        remote.on('error', () => client.terminate());
        remote.on('close', () => client.terminate());
        remote.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        remote.once('open', () => {
          for (const [data, binary] of pending) remote.send(data, { binary });
          pending.length = 0;
        });
      })
      .catch(() => client.terminate());
  });
  return {
    wsEndpoint: `ws://127.0.0.1:${server.address().port}/browser`,
    get launches() {
      return launches;
    },
    async killBrowser() {
      const old = browser;
      browser = undefined;
      starting = undefined;
      await old?.close();
    },
    async releaseOwned() {
      const old = browser;
      browser = undefined;
      starting = undefined;
      await old?.close();
    },
    async close() {
      clearTimeout(idle);
      for (const peer of peers) peer.terminate();
      await browser?.close();
      clearTimeout(idle);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
