// Run after building pi-browser-use: node tests/browser-session-concurrency-e2e.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveBrowserSession } from '../packages/pi-browser-use/dist/index.js';
import { createSessionGateway } from './fixtures/browser-session-gateway.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-browser-use-concurrency-'));
let session, gateway, slowResponse, entered, observeCancellation;
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
const pending = [];
const originalError = console.error;
console.error = (message, ...args) => {
  if (String(message).includes('operation failed (phase=queue, category=cancelled)')) observeCancellation?.();
  originalError(message, ...args);
};
try {
  gateway = await createSessionGateway(join(root, 'gateway-profile'));
  for (const kind of ['local-marker', 'held-cdp']) {
    const navigating = new Promise((resolve) => { entered = resolve; });
    const token = randomBytes(32).toString('hex');
    const owner = randomBytes(32).toString('hex');
    session = await serveBrowserSession({
      headless: true, sessionMode: 'isolated',
      ...(process.env.PI_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE } : {}),
      session: { enabled: true, key: 'concurrency-e2e', retentionMs: 30000 },
    }, token, kind === 'held-cdp' ? { adapter: {
      async acquire() { return { id: 'same-chrome', connection: { wsEndpoint: gateway.wsEndpoint } }; },
      async release() {},
    } } : {});
    const request = async (action, data = {}, signal = AbortSignal.timeout(15000)) => {
      const response = await fetch(`http://127.0.0.1:${session.port}/`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ owner, action, ...data }), signal,
      });
      return response.json();
    };
    const call = (name, args, signal) => request('call', { name, args }, signal);
    const cancelQueued = async (abort, operation) => {
      const observed = new Promise((resolve) => { observeCancellation = resolve; });
      await request('heartbeat');
      abort.abort();
      await operation;
      const deadline = setTimeout(() => observeCancellation(new Error('Cancellation was not observed')), 2000);
      try {
        const error = await observed;
        if (error) throw error;
      } finally { clearTimeout(deadline); }
    };
    await request('attach');
    await call('list_pages', {});
    await call('new_page', { url: `${url}/fast` });
    assert.ok((await request('retain')).result);
    const pages = await call('list_pages', {});
    const text = pages.result.content.map((item) => item.text ?? '').join('\n');
    const firstId = Number(/^(\d+): about:blank(?: |$)/m.exec(text)[1]);
    const secondId = Number(new RegExp(`^(\\d+): .*${fixture.address().port}/fast`, 'm').exec(text)[1]);
    const navigation = call('navigate_page', { pageId: firstId, url: `${url}/slow`, timeout: 10000 });
    pending.push(navigation.catch(() => undefined));
    await navigating;
    const samePage = call('take_snapshot', { pageId: firstId });
    pending.push(samePage.catch(() => undefined));
    const clickAbort = new AbortController();
    const click = call('click', { pageId: firstId, uid: 'stale_uid' }, clickAbort.signal).catch(() => undefined);
    pending.push(click);
    await request('heartbeat');
    const start = performance.now();
    const independent = await call('take_snapshot', { pageId: secondId }, AbortSignal.timeout(2000));
    const snapshotMs = Math.round(performance.now() - start);
    assert.match(JSON.stringify(independent), /Independent page content/);
    assert.ok(!slowResponse.writableEnded, 'Independent inspection must finish while navigation remains pending');
    await cancelQueued(clickAbort, click);
    const scriptAbort = new AbortController();
    const script = call('evaluate_script', { pageId: firstId,
      function: '() => { globalThis.cancelledWriteRan = true; return true; }',
    }, scriptAbort.signal).catch(() => undefined);
    pending.push(script);
    await cancelQueued(scriptAbort, script);
    const afterCancelStart = performance.now();
    const unblocked = await call('take_snapshot', { pageId: secondId }, AbortSignal.timeout(2000));
    const afterCancelMs = Math.round(performance.now() - afterCancelStart);
    assert.match(JSON.stringify(unblocked), /Independent page content/);
    assert.ok(!slowResponse.writableEnded, 'Cancelling an exclusive request must unblock other pages immediately');
    slowResponse.end('<p>Navigation complete</p>');
    assert.ok((await navigation).result);
    assert.match(JSON.stringify(await samePage), /Navigation complete/, 'Same-page inspection must follow navigation');
    assert.ok((await call('list_pages', {})).result);
    const inspected = await call('evaluate_script', { pageId: firstId,
      function: '() => Boolean(globalThis.cancelledWriteRan)',
    });
    const inspectedText = inspected.result.content.map((item) => item.text ?? '').join('\n');
    assert.equal(JSON.parse(/```json\s*([\s\S]*?)\s*```/.exec(inspectedText)[1]), false);
    console.log(JSON.stringify({ kind, snapshotMs, afterCancelMs, samePageOrdered: true, cancelledWriteRan: false }));
    await session.stop();
    session = undefined;
  }
} finally {
  observeCancellation = undefined;
  slowResponse?.end('<p>Navigation complete</p>');
  await session?.stop();
  await Promise.allSettled(pending);
  await gateway?.close();
  await new Promise((resolve) => { fixture.close(resolve); fixture.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
  console.error = originalError;
}
