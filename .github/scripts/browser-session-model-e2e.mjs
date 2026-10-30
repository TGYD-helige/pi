import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseTraceEvents } from './pi-review-trace.mjs';

const run = promisify(execFile);
const normalizeScript = value => String(value).replace(/\s+/g, '').replace(/;$/, '');
const text = (result) => (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');

export function assertModelPhase(events, { phase, url, script, marker }) {
  assert(!events.some(event => event.type === 'message_end' && event.message?.stopReason === 'error'), 'Model provider failed');
  const starts = new Map(events.filter(event => event.type === 'tool_execution_start').map(event => [event.toolCallId, event]));
  const calls = events.filter(event => event.type === 'tool_execution_end').map(event => ({ ...event, args: starts.get(event.toolCallId)?.args }));
  assert(calls.length > 0, 'Model did not execute tools');
  const failed = calls.find(event => event.isError || event.result?.isError);
  if (failed) {
    const name = ['browser_list_pages', 'browser_new_page', 'browser_evaluate_script', 'browser_session'].includes(failed.toolName) ? failed.toolName : 'unknown';
    const categories = ['timeout', 'connect', 'unauthorized', 'forbidden', 'rate limit', '429', 'pageId', 'invalid', 'not found', 'disabled', 'closed'].filter(word => text(failed.result).toLowerCase().includes(word.toLowerCase()));
    assert.fail(`Browser tool failed: ${name} (${categories.join(', ') || 'unclassified'})`);
  }
  const pages = calls.find(event => event.toolName === (phase === 'retain' ? 'browser_new_page' : 'browser_list_pages') && text(event.result).includes(url));
  assert(pages, 'Model did not obtain the test page');
  const pageId = Number(/^(\d+):/m.exec(text(pages.result).split('\n').find(line => line.includes(url)) ?? '')?.[1]);
  assert(Number.isInteger(pageId), 'Missing test page ID');
  const evaluations = calls.filter(event => event.toolName === 'browser_evaluate_script');
  assert(evaluations.length > 0 && evaluations.every(event => normalizeScript(event.args?.function) === normalizeScript(script) && event.args?.pageId === pageId), 'Model did not execute the exact fixture script on the test page');
  const match = /```json\s*([\s\S]*?)\s*```/.exec(text(evaluations.at(-1).result));
  assert(match, 'Missing real browser evaluation result');
  const memory = JSON.parse(match[1]);
  assert.equal(memory.marker, marker, 'Original page marker changed');
  assert.equal(typeof memory.ticks, 'number', 'Missing page polling counter');
  const sessions = calls.filter(event => event.toolName === 'browser_session').map(event => ({ action: event.args?.action, status: JSON.parse(text(event.result)) }));
  if (phase === 'retain') {
    assert.equal(memory.ticks, 0, 'Fixture was not initialized');
    assert.equal(sessions.at(-1)?.action, 'retain', 'Model did not retain before exiting');
    assert.equal(sessions.at(-1)?.status.state, 'retained', 'Session was not retained');
    assert(!sessions.some(event => event.action === 'release'), 'Model released the first handoff');
  } else {
    assert(sessions.some(event => event.action === 'status' && event.status.resumed === true), 'Second Pi did not resume the retained session');
    assert(memory.ticks > 0, 'Original page polling did not continue');
    assert.equal(sessions.at(-1)?.action, 'release', 'Model did not release the handoff');
    assert.equal(sessions.at(-1)?.status.state, 'active', 'Handoff release failed');
    assert(!calls.some(event => ['browser_new_page', 'browser_navigate_page', 'browser_close_page'].includes(event.toolName)), 'Second Pi replaced the original page');
  }
  return { phase, markerMatched: true, ticks: memory.ticks, toolCalls: calls.length };
}

export async function runBrowserSessionModelE2E({ browser } = {}) {
  const source = process.env.PI_CODING_AGENT_DIR;
  assert(source, 'PI_CODING_AGENT_DIR is required');
  assert(browser || process.env.BROWSERLESS_TOKEN, 'BROWSERLESS_TOKEN is required for the real cloud model test');
  const originalSettings = JSON.parse(await readFile(join(source, 'settings.json'), 'utf8'));
  const provider = originalSettings.defaultProvider ?? 'deepseek-integration';
  const model = process.env.PI_INTEGRATION_MODEL ?? originalSettings.defaultModel;
  assert(model, 'An integration model is required');
  const [{ loadPiSettings }, { DevToolsClient }] = await Promise.all([
    import('../../packages/shared/dist/settings.js'),
    import('../../packages/pi-browser-use/dist/index.js'),
  ]);
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-model-e2e-'));
  const agentDir = join(root, 'agent');
  const previous = { PI_AGENT_HOME: process.env.PI_AGENT_HOME, PI_CODING_AGENT_DIR: source };
  const key = `model-session-${randomUUID()}`;
  const marker = randomUUID();
  const url = `about:blank#${key}`;
  const initialize = `() => { globalThis.__piModelMarker = ${JSON.stringify(marker)}; globalThis.__piModelTicks = 0; setInterval(() => globalThis.__piModelTicks++, 20); return { marker: globalThis.__piModelMarker, ticks: globalThis.__piModelTicks }; }`;
  const inspect = '() => ({ marker: globalThis.__piModelMarker, ticks: globalThis.__piModelTicks })';
  let cleanupSucceeded = false;
  let active = false;
  try {
    await mkdir(agentDir, { mode: 0o700 });
    for (const name of ['models.json', 'auth.json']) {
      try { await copyFile(join(source, name), join(agentDir, name)); await chmod(join(agentDir, name), 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: model,
      'pi-browser-use': { sessionMode: 'existing', session: { enabled: true, key, retentionMs: 60000,
        provider: { name: 'browserless', apiKey: browser ? 'local-fixture' : process.env.BROWSERLESS_TOKEN,
          ...(browser ? {} : { create: { timeout: 120000 } }) } } } }), { mode: 0o600 });
    process.env.PI_AGENT_HOME = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    active = true;
    const results = [];
    for (const phase of ['retain', 'resume']) {
      const script = phase === 'retain' ? initialize : inspect;
      const prompt = phase === 'retain'
        ? `Use browser_list_pages, then browser_new_page to open ${url}. On its pageId call browser_evaluate_script with this exact function: ${script} Then call browser_session action retain and end immediately. Do not release, close, navigate or refresh the page.`
        : `Call browser_session action status, then browser_list_pages to find ${url}. Use its pageId in browser_evaluate_script with this exact read-only function: ${script} Read the existing marker and confirm ticks > 0. Then call browser_session action release and end. Do not open, close, navigate or refresh any page. Never initialize or rewrite the marker.`;
      const args = ['--provider', provider, '--model', model, '--thinking', 'off', '--no-session', '--mode', 'json', '--no-approve',
        '--no-extensions', '--extension', resolve('packages/pi-browser-use/dist/index.js'), '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-builtin-tools',
        '--tools', phase === 'retain' ? 'browser_list_pages,browser_new_page,browser_evaluate_script,browser_session' : 'browser_list_pages,browser_evaluate_script,browser_session', '-p', prompt];
      let output;
      try {
        const task = run('pi', args, { env: { ...process.env, PI_TELEMETRY: '0', PI_BROWSER_USE_SESSION_BINDING: browser ? JSON.stringify({ key, browser }) : '' }, cwd: root, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
        task.child.stdin.end();
        output = (await task).stdout;
      } catch { throw Error(`Real Pi CLI ${phase} failed or timed out`); }
      try { results.push(assertModelPhase(parseTraceEvents(output), { phase, url, script, marker })); }
      catch (error) {
        console.error(`FAIL: model ${phase}: ${error.code === 'ERR_ASSERTION' ? error.message : 'Invalid tool trace'}`);
        throw Error(`Model ${phase} did not provide valid tool evidence`);
      }
      console.log(`PASS: real Pi model ${phase} verified through browser tool results`);
    }
    return { provider, model, results };
  } finally {
    try {
      if (active) {
        const client = new DevToolsClient(loadPiSettings('pi-browser-use', { projectTrusted: false }));
        try { await client.sessionControl('release'); } finally { await client.close(); }
      }
      cleanupSucceeded = true;
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      if (cleanupSucceeded) await rm(root, { recursive: true, force: true });
      else console.error('Browser model E2E cleanup is uncertain; protected recovery state retained.');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserSessionModelE2E().catch(() => { console.error('Browser session model E2E failed; raw model/tool output withheld.'); process.exitCode = 1; });
}
