import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  createBrowserSessionRunner,
  waitForSessionEnd,
} from '../../tests/fixtures/browser-session-harness.mjs';

/** An explicit endpoint lets the same cloud protocol test run against a local CDP fixture. */
export async function runBrowserlessSessionE2E(endpoint) {
  if (!endpoint && !process.env.BROWSERLESS_TOKEN)
    throw Error('BROWSERLESS_TOKEN is required for Browserless Cloud lifecycle E2E.');
  const provider = {
    name: 'browserless',
    apiKey: endpoint ? 'local-fixture' : process.env.BROWSERLESS_TOKEN,
    ...(endpoint ? {} : { create: { timeout: 60000 } }),
  };
  const binding = (key) => endpoint ? { key, browser: { id: 'browserless-fixture', connection: { wsEndpoint: endpoint } } } : undefined;
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-use-cloud-'));
  const configPath = join(root, 'config.json');
  // Cloud Chrome cannot reach the runner's loopback HTTP server.
  const runner = createBrowserSessionRunner(root, configPath, 'about:blank#pi-cloud-handshake');
  let phase = 'configure';
  let sessionEnabled = false;
  const base = { sessionMode: 'existing', ...(endpoint ? { wsEndpoint: endpoint } : {}) };
  const recordPath = (key) =>
    join(root, 'browser-sessions', createHash('sha256').update(key).digest('hex'), 'session.json');
  async function configure(session) {
    const config = { ...base, session: { ...session, provider } };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(join(root, 'settings.json'), JSON.stringify({ 'pi-browser-use': config }), {
      mode: 0o600,
    });
    sessionEnabled = session.enabled;
  }
  try {
    phase = 'retain-and-resume';
    await configure({ enabled: true, key: 'cloud-handoff', retentionMs: 15000 });
    const first = await runner.run('retain', binding('cloud-handoff'));
    await delay(1500);
    const second = await runner.run('resume');
    assert.equal(first.state, 'retained');
    assert.equal(second.state, 'active');
    assert.equal(second.handshake, first.handshake);
    assert.ok(second.ticks > first.ticks);
    await assert.rejects(readFile(recordPath('cloud-handoff')), { code: 'ENOENT' });
    console.log(
      'PASS: Browserless Cloud preserves the original page and polling across independent Pi processes, then releases retention.',
    );

    phase = 'ordinary-cleanup';
    await configure({ enabled: true, key: 'cloud-ordinary', retentionMs: 15000 });
    assert.equal((await runner.run('ordinary', binding('cloud-ordinary'))).state, 'active');
    await assert.rejects(readFile(recordPath('cloud-ordinary')), { code: 'ENOENT' });
    console.log('PASS: ordinary Browserless use has no retention window.');

    phase = 'expiry';
    await configure({ enabled: true, key: 'cloud-expiry', retentionMs: 200 });
    await runner.run('retain', binding('cloud-expiry'));
    assert.equal(await waitForSessionEnd(recordPath('cloud-expiry')), 'expired');
    await assert.rejects(runner.run('resume'));
    await runner.run('cleanup');
    console.log(
      'PASS: expired Browserless sessions fail instead of silently replacing the browser.',
    );

    phase = 'disabled';
    await configure({ enabled: false });
    assert.equal((await runner.run('disabled')).state, 'direct');
    console.log('PASS: disabled sessions expose no retention tools or commands.');
  } catch (error) {
    // Child/MCP stderr may contain provider connection information. Never upload or print it.
    const diagnostic = error?.browserSessionDiagnostic ? ` ${error.message}` : '';
    throw Error(`Browserless Cloud lifecycle E2E failed during ${phase}.${diagnostic}`);
  } finally {
    runner.stop();
    if (sessionEnabled) {
      try {
        await runner.run('cleanup');
      } catch {
        console.error(
          'Browserless cleanup could not be confirmed; the test connection has a 60-second provider limit.',
        );
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserlessSessionE2E().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
