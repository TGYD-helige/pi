import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '../../packages/pi-computer-use/node_modules/@earendil-works/pi-ai/dist/index.js';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '../../packages/pi-computer-use/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import computerUse from '../../packages/pi-computer-use/dist/index.js';

assert(['linux', 'win32'].includes(process.platform), 'Run this probe on Linux or Windows');
const startupOnly = process.argv.includes('--startup-only');
if (startupOnly) {
  assert.equal(process.platform, 'linux');
  assert(!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'Unset display variables');
}

const cwd = await mkdtemp(join(tmpdir(), 'pi-computer-use-start-'));
process.env.HOME = cwd;
process.env.USERPROFILE = cwd;
process.env.PI_CODING_AGENT_DIR = cwd;
process.env.PI_AGENT_HOME = cwd;
process.env.CUA_DRIVER_RS_HOME = join(cwd, 'driver');

const toolName = 'computer_use_get_cursor_position';
const launches = [];
const running = ({ child }) => child.pid && child.exitCode === null && child.signalCode === null;
const spawn = ChildProcess.prototype.spawn;
// Observe real child processes, including ones that exit during session startup.
ChildProcess.prototype.spawn = function (options) {
  const { args, file } = options;
  const [, command] = args;
  if (args.includes('pi-computer-use-lease')) {
    launches.push({ command: 'lease', socket: args.at(-1), child: this });
  } else if (/^cua-driver(?:\.exe)?$/i.test(basename(file)) && ['serve', 'mcp'].includes(command)) {
    launches.push({ command, socket: args[args.indexOf('--socket') + 1], child: this });
  }
  return Reflect.apply(spawn, this, [options]);
};

let sessionRuntime;
try {
  await writeFile(join(cwd, 'settings.json'), JSON.stringify({
    'pi-computer-use': { mode: 'bundled', toolProfile: 'full', extraArgs: [] },
  }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('lifecycle-fixture', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture',
    api: 'lifecycle-fixture',
    models: [{
      id: 'scripted',
      name: 'Scripted',
      reasoning: false,
      input: ['text'],
      contextWindow: 32_768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const done = context.messages.some(({ role }) => role === 'toolResult');
      const stopReason = done ? 'stop' : 'toolUse';
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
          content: done
            ? [{ type: 'text', text: 'Probe finished.' }]
            : ['first', 'second'].map((id) => ({ type: 'toolCall', id, name: toolName, arguments: {} })),
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
      return stream;
    },
  });
  sessionRuntime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [computerUse],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: modelRuntime.getModel('lifecycle-fixture', 'scripted'),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) });
  const { session } = sessionRuntime;
  await session.bindExtensions({ mode: 'rpc' });
  assert(session.getAllTools().some(({ name }) => name === toolName), 'Bundled tool was not registered');
  assert.deepEqual(launches.map(({ command }) => command), [], 'Pi started Cua Driver before the first tool call');

  if (!startupOnly) {
    const toolEnds = [];
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') toolEnds.push(event);
    });
    await session.prompt('Read the cursor position twice.');
    assert.deepEqual(toolEnds.map(({ toolCallId }) => toolCallId).sort(), ['first', 'second']);
    for (const { toolName: actual, isError, result } of toolEnds) {
      assert.equal(actual, toolName);
      assert.equal(isError, false, JSON.stringify(result.content).slice(0, 1024));
      assert(Number.isFinite(result.details?.x) && Number.isFinite(result.details?.y), 'Missing cursor coordinates');
    }
    const expected = process.platform === 'linux' ? ['lease', 'serve', 'mcp'] : ['serve', 'mcp'];
    assert.deepEqual(launches.map(({ command }) => command), expected);
    assert(launches.every(running), 'Driver processes did not stay alive');
    const [{ socket }] = launches;
    assert(socket && launches.every((launch) => launch.socket === socket), 'Driver processes used different endpoints');
    if (process.platform === 'linux') assert(existsSync(socket), 'Driver socket was not created');
  }
} finally {
  try {
    await sessionRuntime?.dispose();
    for (let attempt = 0; attempt < 50 && launches.some(running); attempt++) await delay(100);
    assert(!launches.some(running), 'Driver processes survived session shutdown');
    if (process.platform === 'linux' && launches.length) {
      assert(!existsSync(launches[0].socket), 'Driver socket survived session shutdown');
    }
  } finally {
    ChildProcess.prototype.spawn = spawn;
    for (const launch of launches) {
      if (running(launch)) launch.child.kill('SIGKILL');
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

console.log(startupOnly ? 'Headless Pi registered tools without starting Cua Driver.' :
  'Pi registered tools without starting Cua Driver, reused one daemon and proxy for first calls, and cleaned up on shutdown.');
