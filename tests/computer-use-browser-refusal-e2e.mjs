import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '../packages/pi-computer-use/node_modules/@earendil-works/pi-ai/dist/index.js';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '../packages/pi-computer-use/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import computerUse, { resolveDriverLayout } from '../packages/pi-computer-use/dist/index.js';

const browserSession = 'browser-refusal-e2e';
const stateTool = 'computer_use_get_browser_state';
const sessionIdleSeconds = 60;
const missingTabReason =
  'refused (browser_tab_required): snapshot mode requires a tab_id from a prior bind';
const { binaryPath } = resolveDriverLayout({ mode: 'bundled' });
const scenarioDir = await mkdtemp(join(tmpdir(), 'pi-computer-use-refusal-'));
process.env.PI_CODING_AGENT_DIR = scenarioDir;
process.env.CUA_DRIVER_RS_HOME = join(scenarioDir, 'driver');
process.env.CUA_DRIVER_BROWSER_PROFILE_ROOT = join(scenarioDir, 'profiles');
process.env.CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS = String(sessionIdleSeconds);

const calls = new Map();
let bindingAttempts = 0;
let phase = 'refusal';
let implicitStarted;
function untaggedCall(id, name, args = {}) {
  return { type: 'toolCall', id, name, arguments: args };
}

function toolCall(id, name, args) {
  return untaggedCall(id, name, { ...args, session: browserSession });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function nextCall(messages) {
  if (!calls.has('implicit'))
    return untaggedCall('implicit', 'computer_use_list_windows');
  assert.equal(calls.get('implicit').isError, false, 'Untagged discovery must create an implicit session');
  const prepared = calls.get('prepare');
  if (!prepared) {
    return toolCall('prepare', 'computer_use_browser_prepare', {
      allow_launch: true,
      profile: { mode: 'isolated_new' },
    });
  }
  const pid = prepared.result?.details?.prepared_pid;
  assert(
    !prepared.isError && Number.isInteger(pid),
    `Driver did not launch an isolated browser (${prepared.result?.details?.code ?? 'no refusal code'})`,
  );
  const preparedMessage = messages.find(
    (message) => message.role === 'toolResult' && message.toolCallId === 'prepare',
  );
  assert(
    preparedMessage?.content.some(
      (item) => item.type === 'text' && item.text.includes('idle_expires_in_seconds'),
    ),
    'The model must receive the isolated browser lifecycle',
  );

  if (!calls.has('sessions-before'))
    return untaggedCall('sessions-before', 'computer_use_list_sessions');
  if (!calls.has('windows-1')) {
    const listing = calls.get('sessions-before');
    assert.equal(listing.isError, false, 'Both sessions must be listable before expiry');
    const { sessions } = listing.result.details;
    assert.equal(sessions.length, 2, 'The two proxies must expose exactly two active sessions');
    assert(sessions.some((row) => row.session === browserSession && row.state === 'active'));
    const implicit = sessions.find((row) => row.implicit && row.session === null);
    assert.equal(implicit?.state, 'active');
  }

  const windows = calls.get(`windows-${bindingAttempts}`);
  const candidates =
    windows?.result?.details?.windows?.filter(
      (item) => item.pid === pid && Number.isInteger(item.window_id),
    ) ?? [];
  const window = candidates.length
    ? candidates[(bindingAttempts - 1) % candidates.length]
    : undefined;
  const bound = calls.get(`bind-${bindingAttempts}`);
  const targetId = bound?.result?.details?.target_id;
  const tabs = bound?.result?.details?.tabs ?? [];
  const tabId = (tabs.find((tab) => tab.active) ?? tabs[0])?.tab_id;
  if (!window || (bound && (bound.isError || !targetId || !tabId))) {
    assert(
      bindingAttempts < 80 && !windows?.isError,
      `Could not bind the isolated browser window (${candidates.length} candidates, ${bound?.result?.details?.code ?? 'no refusal code'})`,
    );
    if (bindingAttempts) await delay(250);
    return toolCall(`windows-${++bindingAttempts}`, 'computer_use_list_windows', { pid });
  }
  if (!bound) {
    return toolCall(`bind-${bindingAttempts}`, stateTool, { pid, window_id: window.window_id });
  }
  if (!calls.has('missing-tab')) return toolCall('missing-tab', stateTool, { target_id: targetId });
  if (!calls.has('recovered')) {
    const refusal = messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'missing-tab',
    );
    assert.equal(refusal?.isError, true, 'The model must receive the refusal as an error');
    const text = refusal.content.find((item) => item.type === 'text')?.text ?? '';
    assert(text.startsWith('[browser_tab_required] '), 'The model must receive the unified error code');
    assert(text.includes(`\nCause (Cua Driver): ${missingTabReason}`), 'The model must receive the original refusal reason');
    assert(text.includes('\nRecovery: '), 'The model must receive the recovery guidance');
    assert.match(text, /tab_id.*same session/);
    return toolCall('recovered', stateTool, { target_id: targetId, tab_id: tabId });
  }
  if (!calls.has('stale-ref')) {
    return toolCall('stale-ref', 'computer_use_browser_click', {
      target_id: targetId,
      tab_id: tabId,
      ref: 'p4294967295:0',
      // The Linux trusted-input route can refuse before validating the page ref.
      input_route: 'dom_event',
    });
  }
  if (phase === 'refusal') return { type: 'text', text: 'Browser refusal checks complete.' };
  if (!calls.has('keepalive'))
    return toolCall('keepalive', 'computer_use_list_windows', { pid });
  if (phase === 'keepalive') return { type: 'text', text: 'Named session refreshed.' };
  if (!calls.has('sessions-after'))
    return untaggedCall('sessions-after', 'computer_use_list_sessions');
  if (!calls.has('after-expiry')) {
    const sessionsAfter = calls.get('sessions-after');
    assert.equal(sessionsAfter.isError, false, 'The named session must still be listable');
    assert.deepEqual(
      sessionsAfter.result.details?.sessions.map(({ session, state }) => [session, state]),
      [[browserSession, 'active']],
      'The implicit session must be gone while the named session stays active',
    );
    return toolCall('after-expiry', 'computer_use_list_windows', { pid });
  }
  if (!calls.has('rebind')) {
    const afterExpiry = calls.get('after-expiry');
    assert.equal(afterExpiry.isError, false, 'Named discovery must succeed after implicit expiry');
    assert(isRunning(pid), 'Implicit idle expiry reaped the named browser');
    const liveWindows = afterExpiry.result.details?.windows?.filter(
      (item) => item.pid === pid && Number.isInteger(item.window_id),
    ) ?? [];
    const liveWindow = liveWindows.find((item) => item.window_id === window.window_id) ?? liveWindows[0];
    assert(liveWindow, 'The original named browser must still have a window');
    return toolCall('rebind', stateTool, { pid, window_id: liveWindow.window_id });
  }
  const rebound = calls.get('rebind');
  const reboundState = rebound.result.details;
  const reboundTab = (reboundState?.tabs?.find((tab) => tab.active) ?? reboundState?.tabs?.[0])?.tab_id;
  assert(!rebound.isError && reboundState?.target_id && reboundTab, 'Could not bind the surviving browser');
  if (!calls.has('snapshot-after-expiry'))
    return toolCall('snapshot-after-expiry', stateTool, {
      target_id: reboundState.target_id,
      tab_id: reboundTab,
    });
  if (!calls.has('restart-implicit'))
    return untaggedCall('restart-implicit', 'computer_use_start_session');
  assert.equal(calls.get('restart-implicit').isError, false, 'The implicit session must restart');
  if (!calls.has('end-implicit'))
    return untaggedCall('end-implicit', 'computer_use_end_session');
  if (!calls.has('end')) {
    assert.equal(calls.get('end-implicit').isError, false, 'Explicit implicit-session end must succeed');
    assert(isRunning(pid), 'Explicit implicit-session end reaped the named browser');
    return toolCall('end', 'computer_use_end_session', {});
  }
  if (!calls.has('ended')) return toolCall('ended', 'computer_use_list_windows', {});
  return { type: 'text', text: 'Browser refusal scenario complete.' };
}

let session;
let scriptError;
try {
  await writeFile(
    join(scenarioDir, 'settings.json'),
    JSON.stringify({
      'pi-computer-use': {
        mode: 'path',
        binaryPath,
        extraArgs: [],
        toolProfile: 'full',
        // The scripted provider only prepares an isolated browser in this temporary session.
        confirmDangerousActions: false,
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(scenarioDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('browser-refusal-fixture', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture',
    api: 'browser-refusal-fixture',
    models: [
      {
        id: 'scripted',
        name: 'Scripted',
        reasoning: false,
        input: ['text'],
        contextWindow: 32_768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void nextCall(context.messages)
        .catch((error) => {
          scriptError = error;
          return { type: 'text', text: 'Browser refusal scenario could not complete.' };
        })
        .then((content) => {
          const stopReason = content.type === 'toolCall' ? 'toolUse' : 'stop';
          stream.push({
            type: 'done',
            reason: stopReason,
            message: {
              role: 'assistant',
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              stopReason,
              content: [content],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
          stream.end();
        });
      return stream;
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: scenarioDir,
    agentDir: scenarioDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [computerUse],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: scenarioDir,
    agentDir: scenarioDir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model: runtime.getModel('browser-refusal-fixture', 'scripted'),
    sessionManager: SessionManager.inMemory(scenarioDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  }));
  await session.bindExtensions({ mode: 'rpc' });
  session.subscribe((event) => {
    if (event.type !== 'tool_execution_end') return;
    if (event.toolCallId === 'implicit') implicitStarted = performance.now();
    calls.set(event.toolCallId, event);
  });
  await session.prompt('Run the browser missing-tab scenario.');
  if (scriptError) throw scriptError;

  const rejected = calls.get('missing-tab');
  assert.equal(rejected?.toolName, stateTool);
  assert.equal(rejected.isError, true, 'Pi must mark the missing-tab snapshot as failed');
  assert.equal(rejected.result.details?.status, 'refused');
  assert.equal(rejected.result.details?.code, 'browser_tab_required');
  assert.equal(rejected.result.structuredContent?.error?.code, 'browser_tab_required');
  assert.equal(rejected.result.structuredContent?.error?.cause?.message, missingTabReason);
  const recovered = calls.get('recovered');
  assert.equal(recovered?.toolName, stateTool);
  assert.equal(recovered.isError, false, 'Snapshot with the recovered tab ID must succeed');
  assert.equal(recovered.result.details?.mode, 'snapshot');
  const staleRef = calls.get('stale-ref');
  assert.equal(staleRef?.isError, true, 'A browser action refused by the Driver must fail in Pi');
  assert.equal(staleRef.result.details?.effect, 'refused');
  assert.equal(staleRef.result.details?.code, 'browser_ref_stale');

  // list_sessions reports the default TTL. Time the fixture's configured TTL from discovery.
  const implicitExpiry = implicitStarted + sessionIdleSeconds * 1000;
  await delay(Math.max(0, implicitExpiry - performance.now() - 10_000));
  phase = 'keepalive';
  await session.prompt('Refresh the named browser session.');
  if (scriptError) throw scriptError;
  assert.equal(calls.get('keepalive')?.isError, false, 'The named lease must be refreshed');
  // Refresh only the named lease and wait past the Driver's 30-second sweep interval.
  await delay(Math.max(0, implicitExpiry - performance.now() + 35_000));
  phase = 'expiry';
  await session.prompt('Verify the browser survived implicit expiry and end its named session.');
  if (scriptError) throw scriptError;

  const afterExpiry = calls.get('snapshot-after-expiry');
  assert.equal(afterExpiry?.toolName, stateTool);
  assert.equal(afterExpiry.isError, false,
    `The surviving browser must remain readable (${afterExpiry.result.details?.code ?? 'no refusal code'})`);
  assert.equal(afterExpiry.result.details?.mode, 'snapshot');
  assert.equal(calls.get('end')?.isError, false, 'The test must end its isolated browser session');
  const pid = calls.get('prepare').result.details.prepared_pid;
  for (let attempt = 0; attempt < 40 && isRunning(pid); attempt++) await delay(100);
  assert.equal(isRunning(pid), false, 'Ending the named session must reap its browser');
  const ended = calls.get('ended');
  assert.equal(ended?.isError, true, 'Reading after the session ends must fail');
  assert.equal(ended.result.details?.code, 'session_ended');
  assert(
    ended.result.content.some(
      (item) => item.type === 'text' && item.text.includes('computer_use_start_session'),
    ),
    'The ended-session refusal must explain how to restart the session',
  );
  console.log('Browser refusal recovery and named browser survival across implicit expiry and explicit end verified.');
} finally {
  try {
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  } finally {
    session?.dispose();
    await rm(scenarioDir, { recursive: true, force: true });
  }
}
