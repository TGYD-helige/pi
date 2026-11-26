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
const missingTabReason =
  'refused (browser_tab_required): snapshot mode requires a tab_id from a prior bind';
const { binaryPath } = resolveDriverLayout({ mode: 'bundled' });
const scenarioDir = await mkdtemp(join(tmpdir(), 'pi-computer-use-refusal-'));
process.env.PI_CODING_AGENT_DIR = scenarioDir;
process.env.CUA_DRIVER_RS_HOME = join(scenarioDir, 'driver');
process.env.CUA_DRIVER_BROWSER_PROFILE_ROOT = join(scenarioDir, 'profiles');

const calls = new Map();
let bindingAttempts = 0;
function toolCall(id, name, args) {
  return { type: 'toolCall', id, name, arguments: { ...args, session: browserSession } };
}

async function nextCall(messages) {
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
    assert(text.startsWith(missingTabReason), 'The model must receive the original refusal reason');
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
  if (!calls.has('end')) return toolCall('end', 'computer_use_end_session', {});
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
    if (event.type === 'tool_execution_end') calls.set(event.toolCallId, event);
  });
  await session.prompt('Run the browser missing-tab scenario.');
  if (scriptError) throw scriptError;

  const rejected = calls.get('missing-tab');
  assert.equal(rejected?.toolName, stateTool);
  assert.equal(rejected.isError, true, 'Pi must mark the missing-tab snapshot as failed');
  assert.equal(rejected.result.details?.status, 'refused');
  assert.equal(rejected.result.details?.code, 'browser_tab_required');
  const recovered = calls.get('recovered');
  assert.equal(recovered?.toolName, stateTool);
  assert.equal(recovered.isError, false, 'Snapshot with the recovered tab ID must succeed');
  assert.equal(recovered.result.details?.mode, 'snapshot');
  const staleRef = calls.get('stale-ref');
  assert.equal(staleRef?.isError, true, 'A browser action refused by the Driver must fail in Pi');
  assert.equal(staleRef.result.details?.effect, 'refused');
  assert.equal(staleRef.result.details?.code, 'browser_ref_stale');
  assert.equal(calls.get('end')?.isError, false, 'The test must end its isolated browser session');
  const ended = calls.get('ended');
  assert.equal(ended?.isError, true, 'Reading after the session ends must fail');
  assert.equal(ended.result.details?.code, 'session_ended');
  assert(
    ended.result.content.some(
      (item) => item.type === 'text' && item.text.includes('computer_use_start_session'),
    ),
    'The ended-session refusal must explain how to restart the session',
  );
  console.log('Browser refusal codes, recovery, and lifecycle verified.');
} finally {
  try {
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  } finally {
    session?.dispose();
    await rm(scenarioDir, { recursive: true, force: true });
  }
}
