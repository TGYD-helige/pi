// Run after building pi-browser-use: node tests/browser-timeout-recovery-e2e.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DevToolsClient, serveBrowserSession } from '../packages/pi-browser-use/dist/index.js';

const require = createRequire(new URL('../packages/pi-browser-use/package.json', import.meta.url));
const { puppeteer } = await import(pathToFileURL(join(
  dirname(require.resolve('chrome-devtools-mcp/package.json')), 'build/src/third_party/index.js',
)).href);
const root = await mkdtemp(join(tmpdir(), 'pi-browser-use-timeout-'));
let browser, session, heartbeat;
const heartbeats = new Set();
let connections = 0;
const calls = [];
const originalConnect = DevToolsClient.prototype.connect;
const originalCall = DevToolsClient.prototype.callTool;
DevToolsClient.prototype.connect = function (...args) {
  connections++;
  return originalConnect.apply(this, args);
};
DevToolsClient.prototype.callTool = function (name, ...args) {
  calls.push(name);
  return originalCall.call(this, name, ...args);
};
try {
  browser = await puppeteer.launch({
    channel: 'chrome', headless: true, userDataDir: root,
    ...(process.env.PI_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE } : {}),
  });
  for (const supported of [true, false]) {
    const [page] = await browser.pages();
    const nonce = randomBytes(16).toString('hex');
    const browserBinding = { id: nonce, connection: { wsEndpoint: browser.wsEndpoint() } };
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    let reconnects = 0;
    session = await serveBrowserSession({
      experimentalPageIdRouting: true,
      session: { enabled: true, key: 'timeout-e2e', retentionMs: 30000 },
    }, token, { adapter: {
      async acquire() { return browserBinding; },
      ...(supported ? { async reconnect(original) {
        assert.equal(original.id, nonce);
        reconnects++;
        return browserBinding.connection;
      } } : {}),
      async release() {},
    } });
    const request = async (action, data = {}, signal = AbortSignal.timeout(15000)) => {
      const response = await fetch(`http://127.0.0.1:${session.port}/`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ owner, action, ...data }), signal,
      });
      return response.json();
    };
    const call = (name, args = {}, signal) => request('call', { name, args }, signal);
    await request('attach');
    heartbeat = setInterval(() => {
      const pending = request('heartbeat', {}, AbortSignal.timeout(65000)).catch(() => undefined);
      heartbeats.add(pending);
      void pending.finally(() => heartbeats.delete(pending));
    }, 5000);
    const normalStart = performance.now();
    const initialPages = await call('list_pages');
    const pageId = Number(/^(\d+): /m.exec(initialPages.result.content[0].text)[1]);
    assert.ok((await call('evaluate_script', { pageId,
      function: `() => { globalThis.identity = ${JSON.stringify(nonce)}; globalThis.writes = 0; return true; }`,
    })).result);
    const normalMs = Math.round(performance.now() - normalStart);
    const abort = new AbortController();
    const started = performance.now();
    const naturalTimeout = supported && process.env.PI_BROWSER_TEST_NATURAL_TIMEOUT === '1';
    const stalled = call('evaluate_script', { pageId,
      function: '() => { globalThis.writes++; return new Promise(() => {}); }',
    }, naturalTimeout ? AbortSignal.timeout(65000) : abort.signal).catch(() => undefined);
    await page.waitForFunction('globalThis.writes === 1', { timeout: 5000 });
    if (!naturalTimeout) abort.abort();
    const failure = await stalled;
    if (naturalTimeout) assert.match(failure.error, /timed out/);
    const failedCallMs = Math.round(performance.now() - started);
    const beforeConnections = connections;
    const beforeCalls = calls.length;
    const recovering = performance.now();
    const recovery = await call('list_pages', {}, AbortSignal.timeout(12000));
    if (supported) {
      assert.match(recovery.error, /MCP subprocess was replaced.*browser_list_pages.*browser_take_snapshot/, 'Recovery must require fresh identifiers');
      assert.equal(reconnects, 1);
      assert.equal(connections - beforeConnections, 1, 'Replace exactly one MCP subprocess');
      assert.deepEqual(calls.slice(beforeCalls), ['list_pages'], 'Probe tool execution once');
      const pages = await call('list_pages');
      const freshPageId = Number(/^(\d+): /m.exec(pages.result.content[0].text)[1]);
      const snapshot = await call('take_snapshot', { pageId: freshPageId });
      assert.ok(snapshot.result && !snapshot.result.isError);
      const inspected = await call('evaluate_script', { pageId: freshPageId,
        function: '() => ({ identity: globalThis.identity, writes: globalThis.writes })',
      });
      const text = inspected.result.content.map((item) => item.text ?? '').join('\n');
      assert.ok(text.includes(nonce), 'Keep the original in-memory page');
      assert.match(text, /"writes":\s*1/, 'Never replay the uncertain write');
    } else {
      assert.match(recovery.error, /stalled.*reattachment.*unavailable/);
      const second = await call('evaluate_script', { pageId, function: '() => document.title' });
      assert.match(second.error, /stalled/);
      assert.equal(connections, beforeConnections, 'Never redial an unsupported launch endpoint');
      assert.equal(calls.length, beforeCalls, 'Do not send more tools to the stalled MCP');
    }
    console.log(JSON.stringify({ supported, normalMs, failedCallMs,
      inspectionOrRejectionMs: Math.round(performance.now() - recovering),
      extraMcpProcesses: connections - beforeConnections, reconnects, writes: await page.evaluate('globalThis.writes'),
    }));
    clearInterval(heartbeat);
    await Promise.all(heartbeats);
    await session.stop();
    session = undefined;
  }
} finally {
  clearInterval(heartbeat);
  await session?.stop();
  await Promise.all(heartbeats);
  await browser?.close();
  DevToolsClient.prototype.connect = originalConnect;
  DevToolsClient.prototype.callTool = originalCall;
  await rm(root, { recursive: true, force: true });
}
