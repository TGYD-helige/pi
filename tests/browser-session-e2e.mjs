// Run after building pi-browser-use: node tests/browser-session-e2e.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createBrowserSessionRunner,
  waitForSessionEnd,
} from './fixtures/browser-session-harness.mjs';
import { createSessionGateway } from './fixtures/browser-session-gateway.mjs';
import { runBrowserlessSessionE2E } from '../.github/scripts/browserless-session-e2e.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-browser-use-live-session-'));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<script>globalThis.handshake=crypto.randomUUID();globalThis.ticks=0;setInterval(()=>ticks++,20)</script><p>Waiting for human login</p>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const configPath = join(root, 'config.json');
const baseConfig = {
  headless: true,
  sessionMode: 'isolated',
  session: { enabled: true, key: 'qr-test', retentionMs: 15000 },
  ...(process.env.PI_BROWSER_TEST_EXECUTABLE
    ? { executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE }
    : {}),
};
const runner = createBrowserSessionRunner(
  root,
  configPath,
  `http://127.0.0.1:${server.address().port}/qr`,
);
const { run } = runner;
let gateway, management;
try {
  gateway = await createSessionGateway(join(root, 'gateway-profile'));
  for (const [name, config] of [
    ['local headless Chrome', baseConfig],
    [
      'disconnect-reaping CDP gateway',
      {
        ...baseConfig,
        sessionMode: 'existing',
        wsEndpoint: gateway.wsEndpoint,
        session: { ...baseConfig.session, key: 'gateway-qr-test' },
      },
    ],
  ]) {
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': config }), {
      mode: 0o600,
    });
    const first = await run('retain');
    await delay(1500); // Longer than the gateway's disconnect-to-close window.
    const second = await run('resume');
    assert.equal(second.handshake, first.handshake, 'Must resume the original in-memory handshake');
    assert.ok(
      second.ticks > first.ticks,
      'The original page polling loop must continue between Pi processes',
    );
    assert.equal(first.state, 'retained');
    assert.equal(second.state, 'active');
    assert.equal(first.resumed, false);
    assert.equal(second.resumed, true);
    console.log(
      `PASS: ${name}: independent Pi clients retain the original page and polling loop, then release it.`,
    );
  }
  assert.equal(gateway.launches, 1, 'The gateway must not replace Chrome between Pi processes');
  await delay(1500);
  const ordinary = {
    ...baseConfig,
    sessionMode: 'existing',
    wsEndpoint: gateway.wsEndpoint,
    session: { ...baseConfig.session, key: 'ordinary' },
  };
  await writeFile(configPath, JSON.stringify(ordinary), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': ordinary }), {
    mode: 0o600,
  });
  assert.equal((await run('ordinary')).state, 'active');
  const recordPath = (key) =>
    join(root, 'browser-sessions', createHash('sha256').update(key).digest('hex'), 'session.json');
  await assert.rejects(readFile(recordPath('ordinary')), { code: 'ENOENT' });
  console.log('PASS: ordinary tasks detach and clean up without a retention window.');
  await delay(1500);
  const crashed = { ...ordinary, session: { ...ordinary.session, key: 'crashed-client' } };
  await writeFile(configPath, JSON.stringify(crashed), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': crashed }), {
    mode: 0o600,
  });
  const beforeCrash = await run('crash-retain');
  const afterCrash = await run('resume');
  assert.equal(afterCrash.handshake, beforeCrash.handshake);
  assert.ok(afterCrash.ticks >= beforeCrash.ticks);
  console.log(
    'PASS: a retained page can be resumed immediately after the Pi client process crashes.',
  );
  await delay(1500);
  const lost = { ...ordinary, session: { ...ordinary.session, key: 'lost-browser' } };
  await writeFile(configPath, JSON.stringify(lost), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': lost }), {
    mode: 0o600,
  });
  await run('retain');
  const launches = gateway.launches;
  await gateway.killBrowser();
  await assert.rejects(run('resume'));
  assert.equal(
    gateway.launches,
    launches,
    'Loss detection must not reconnect to a launch URL and create a replacement browser',
  );
  console.log('PASS: a lost CDP browser is reported without silently launching a replacement.');
  await delay(1200);
  await run('cleanup');
  const expiring = {
    ...ordinary,
    session: { ...ordinary.session, key: 'expired-browser', retentionMs: 200 },
  };
  await writeFile(configPath, JSON.stringify(expiring), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': expiring }), {
    mode: 0o600,
  });
  await run('retain');
  const beforeExpiry = gateway.launches;
  assert.equal(await waitForSessionEnd(recordPath('expired-browser')), 'expired');
  await assert.rejects(run('resume'));
  assert.equal(
    gateway.launches,
    beforeExpiry,
    'Expired sessions must not silently create a replacement browser',
  );
  console.log(
    'PASS: retained sessions expire and require explicit reset instead of allocating a replacement.',
  );
  await run('cleanup');
  const requests = [];
  management = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/create')
      res.end(
        JSON.stringify({
          id: 'cloud-owned-1',
          cdpUrl: gateway.wsEndpoint,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    else if (req.method === 'GET') res.end('{"status":"running"}');
    else {
      await gateway.releaseOwned();
      res.end('{}');
    }
  });
  await new Promise((resolve) => management.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${management.address().port}`;
  const cloud = {
    ...baseConfig,
    sessionMode: 'existing',
    session: {
      ...baseConfig.session,
      key: 'http-owned',
      backend: {
        create: { url: `${base}/create`, method: 'POST' },
        release: { url: `${base}/stop/{sessionId}`, method: 'POST' },
        fields: { id: 'id', wsEndpoint: 'cdpUrl', expiresAt: 'expiresAt' },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(cloud), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': cloud }), {
    mode: 0o600,
  });
  assert.equal((await run('discover')).state, 'idle');
  assert.deepEqual(requests, [], 'Discovery must not create a paid cloud browser');
  const cloudFirst = await run('retain');
  assert.deepEqual(requests, ['POST /create'], 'Retaining must not release the cloud browser');
  const cloudSecond = await run('resume');
  assert.equal(cloudSecond.handshake, cloudFirst.handshake);
  assert.deepEqual(requests, ['POST /create', 'POST /stop/cloud-owned-1']);
  console.log(
    'PASS: HTTP cloud lifecycle is lazy, preserves the same browser, and releases the owned session exactly once.',
  );
  requests.length = 0;
  const existing = {
    ...cloud,
    session: {
      ...cloud.session,
      key: 'http-existing',
      backend: {
        release: { url: `${base}/stop/{sessionId}`, method: 'POST' },
        status: { url: `${base}/status/{sessionId}`, method: 'GET' },
        fields: { status: 'status', liveStatus: 'running' },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(existing), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': existing }), {
    mode: 0o600,
  });
  const binding = {
    key: existing.session.key,
    browser: { id: 'host-supplied-1', connection: { wsEndpoint: gateway.wsEndpoint } },
  };
  assert.equal((await run('discover', binding)).state, 'idle');
  assert.deepEqual(requests, [], 'Discovery must not adopt or release the supplied instance');
  const existingFirst = await run('retain', binding);
  await assert.rejects(
    run('resume', { ...binding, browser: { ...binding.browser, id: 'wrong-instance' } }),
  );
  const existingSecond = await run('resume');
  assert.equal(existingSecond.handshake, existingFirst.handshake);
  assert.ok(existingSecond.ticks >= existingFirst.ticks);
  assert.ok(requests.includes('GET /status/host-supplied-1'));
  assert.deepEqual(
    requests.filter((request) => !request.startsWith('GET ')),
    ['POST /stop/host-supplied-1'],
  );
  console.log(
    'PASS: a host-supplied session ID survives handoff, supports status, and releases once without HTTP creation.',
  );
  requests.length = 0;
  const adapterPath = join(root, 'custom-adapter.mjs');
  await writeFile(
    adapterPath,
    `export function createBrowserLifecycleAdapter() {
    return {
      async acquire(_config, signal) {
        const response = await fetch(${JSON.stringify(`${base}/create`)}, {method: 'POST', signal});
        const value = await response.json();
        return {id: value.id, connection: {wsEndpoint: value.cdpUrl}, expiresAt: Date.parse(value.expiresAt)};
      },
      async release(browser, signal) {
        await fetch(${JSON.stringify(`${base}/stop/`)} + encodeURIComponent(browser.id), {method: 'POST', signal});
      }
    };
  }`,
    { mode: 0o600 },
  );
  const { backend: _backend, ...moduleSession } = cloud.session;
  const custom = {
    ...cloud,
    session: { ...moduleSession, key: 'custom-module', adapterModule: adapterPath },
  };
  await writeFile(configPath, JSON.stringify(custom), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': custom }), {
    mode: 0o600,
  });
  const customFirst = await run('retain');
  const customSecond = await run('resume');
  assert.equal(customSecond.handshake, customFirst.handshake);
  assert.deepEqual(requests, ['POST /create', 'POST /stop/cloud-owned-1']);
  console.log(
    'PASS: a programmatic adapter runs across Pi clients and performs final provider cleanup.',
  );
  const disabled = {
    sessionMode: 'existing',
    wsEndpoint: gateway.wsEndpoint,
    session: { enabled: false },
  };
  await writeFile(configPath, JSON.stringify(disabled), { mode: 0o600 });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': disabled }), {
    mode: 0o600,
  });
  const beforeDisabled = gateway.launches;
  assert.equal((await run('disabled')).state, 'direct');
  assert.equal(gateway.launches, beforeDisabled);
  console.log(
    'PASS: disabling sessions hides tool/command controls and preserves direct connections.',
  );
  await runBrowserlessSessionE2E(gateway.wsEndpoint);
  console.log('PASS: the Browserless Cloud CI script passes against the real-CDP gateway fixture.');
} finally {
  runner.stop();
  // Best-effort explicit release if an assertion failed after retention.
  try {
    await run('cleanup');
  } catch {}
  await gateway?.close();
  if (management) await new Promise((resolve) => management.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
