// Run after building pi-browser-use: node tests/browser-session-concurrency-e2e.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveBrowserSession } from '../packages/pi-browser-use/dist/index.js';

const require = createRequire(new URL('../packages/pi-browser-use/package.json', import.meta.url));
const { puppeteer } = await import(pathToFileURL(join(
  dirname(require.resolve('chrome-devtools-mcp/package.json')), 'build/src/third_party/index.js',
)).href);
const root = await mkdtemp(join(tmpdir(), 'pi-browser-use-concurrency-'));
let browser, session, slowResponse, entered;
const navigating = new Promise((resolve) => { entered = resolve; });
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/slow') {
    slowResponse = res;
    res.write('<title>Slow page</title><p>Loading</p>');
    entered();
  } else res.end('<title>Independent page</title><p>Independent page content</p>');
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
let pending = [];
try {
  browser = await puppeteer.launch({ channel: 'chrome', headless: true, userDataDir: root,
    ...(process.env.PI_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE } : {}),
  });
  const second = await browser.newPage();
  await second.goto(`${url}/fast`);
  const token = randomBytes(32).toString('hex');
  const owner = randomBytes(32).toString('hex');
  session = await serveBrowserSession({
    session: { enabled: true, key: 'concurrency-e2e', retentionMs: 30000 },
  }, token, { adapter: {
    async acquire() { return { id: 'same-chrome', connection: { wsEndpoint: browser.wsEndpoint() } }; },
    async release() {},
  } });
  const request = async (action, data = {}, signal = AbortSignal.timeout(15000)) => {
    const response = await fetch(`http://127.0.0.1:${session.port}/`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ owner, action, ...data }), signal,
    });
    return response.json();
  };
  const call = (name, args, signal) => request('call', { name, args }, signal);
  await request('attach');
  await request('call', { name: 'list_pages', args: {} });
  await request('retain');
  const pages = await call('list_pages', {});
  const text = pages.result.content.map((item) => item.text ?? '').join('\n');
  const firstId = Number(/^(\d+): about:blank/m.exec(text)[1]);
  const secondId = Number(new RegExp(`^(\\d+): .*${fixture.address().port}/fast`, 'm').exec(text)[1]);
  const navigation = call('navigate_page', { pageId: firstId, url: `${url}/slow`, timeout: 10000 });
  pending.push(navigation.catch(() => undefined));
  await navigating;
  const samePage = call('take_snapshot', { pageId: firstId });
  pending.push(samePage.catch(() => undefined));
  const start = performance.now();
  const independent = await call('take_snapshot', { pageId: secondId }, AbortSignal.timeout(2000));
  const snapshotMs = Math.round(performance.now() - start);
  assert.match(JSON.stringify(independent), /Independent page content/);
  assert.ok(!slowResponse.writableEnded, 'Independent inspection must finish while navigation remains pending');
  const heartbeat = await request('heartbeat', {}, AbortSignal.timeout(1000));
  assert.deepEqual(heartbeat, { result: {} });
  slowResponse.end('<p>Navigation complete</p>');
  assert.ok((await navigation).result);
  const ordered = await samePage;
  assert.match(JSON.stringify(ordered), /Navigation complete/, 'Same-page inspection must follow navigation');
  console.log(JSON.stringify({ snapshotMs, samePageOrdered: true, retained: true, heartbeat: true }));
} finally {
  slowResponse?.end('<p>Navigation complete</p>');
  await session?.stop();
  await Promise.allSettled(pending);
  await browser?.close();
  await new Promise((resolve) => { fixture.close(resolve); fixture.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
}
