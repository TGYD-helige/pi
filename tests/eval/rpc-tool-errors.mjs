import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const timeoutMs = 15_000;
const usage = 'Usage: node tests/eval/rpc-tool-errors.mjs <0.79.1-package-dir> <current-package-dir>';
const inputs = process.argv.slice(2);
assert.equal(inputs.length, 2, usage);

const channels = fileURLToPath(new URL('../../packages/pi-channels/dist/index.js', import.meta.url));
await access(channels);

const runtimes = await Promise.all(
  inputs.map(async (input, index) => {
    const directory = resolve(input);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@earendil-works/pi-coding-agent', directory);
    const version = manifest.version;
    const legacy = index === 0;
    if (legacy) {
      assert.equal(version, '0.79.1', `${directory}: expected Pi 0.79.1`);
    } else {
      const [major, minor] = version.split('.').map(Number);
      assert(major > 0 || (major === 0 && minor >= 99), `${directory}: expected Pi 0.99 or newer`);
    }
    const cli = resolve(directory, manifest.bin.pi);
    await access(cli);
    return { version, cli, legacy };
  }),
);

async function collectRpcEvents(child) {
  const events = [];
  let partial = '';
  let bytes = 0;
  let framingError;
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    bytes += Buffer.byteLength(chunk);
    assert.ok(bytes <= 256 * 1024, 'RPC output exceeded the fixture budget');
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
        assert.equal(typeof event?.type, 'string', 'Expected an RPC record with a type');
      } catch (error) {
        framingError ??= error;
        continue;
      }
      events.push(event);
      if (event.type === 'agent_end') child.stdin.end();
    }
  }
  if (partial.trim()) framingError ??= new Error('Incomplete RPC record');
  return { events, framingError };
}

async function runProbe({ version, cli }) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-tool-errors-'));
  try {
    const agentDir = join(directory, 'agent');
    const fixture = join(directory, 'fixture.ts');
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      'pi-channels': {
        adapters: { webhook: { type: 'webhook' } },
        routes: { probe: { adapter: 'webhook', recipient: 'https://example.invalid/hook' } },
        bridge: { enabled: false },
      },
    }));
    await copyFile(new URL('./rpc-tool-errors.fixture.ts', import.meta.url), fixture);
    const child = spawn(
      process.execPath,
      [
        cli,
        '--mode',
        'rpc',
        '--no-session',
        '--no-context-files',
        '--offline',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--provider',
        'rpc-fixture',
        '--model',
        'scripted',
        '-e',
        fixture,
        '-e',
        channels,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          PI_CODING_AGENT_DIR: agentDir,
          PI_AGENT_HOME: agentDir,
          TERM: 'dumb',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    let processError;
    let stdinError;
    let timedOut = false;
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    child.once('error', (error) => {
      processError = error;
    });
    // A failed spawn also emits 'close' after 'error' and stdio cleanup.
    const closed = new Promise((finish) => child.once('close', finish));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    try {
      child.stdin.write(
        `${JSON.stringify({ id: 'probe', type: 'prompt', message: 'Exercise all fixture tools.' })}\n`,
      );
      const { events, framingError } = await collectRpcEvents(child);
      const exitCode = await closed;
      if (processError) throw processError;
      assert.ok(!timedOut, `Pi ${version} RPC timed out after ${timeoutMs} ms`);
      assert.equal(exitCode, 0, `Pi ${version} RPC exited with ${exitCode}\n${stderr}`);
      if (framingError) throw framingError;
      if (stdinError) throw stdinError;
      return events;
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const runtime of runtimes) {
  const { version, legacy } = runtime;
  const events = await runProbe(runtime);
  const prompt = events.find((event) => event.id === 'probe' && event.type === 'response');
  assert.equal(prompt?.success, true, `Pi ${version} must accept the fixture prompt`);
  assert.ok(
    events.some((event) => event.type === 'agent_end'),
    `Pi ${version} must finish the agent run`,
  );
  const toolEnds = events.filter((event) => event.type === 'tool_execution_end');
  const toolResults = events.filter(
    (event) => event.type === 'message_end' && event.message.role === 'toolResult',
  );
  assert.equal(toolEnds.length, 3, `Pi ${version} RPC tool results`);
  assert.equal(toolResults.length, 3, `Pi ${version} tool-result messages`);

  const expectedProviderResults = {};
  for (const [name, callId, text, expected] of [
    ['resolved_failure', 'call-resolved', 'SAFE-RESOLVED', !legacy],
    ['thrown_failure', 'call-thrown', 'SAFE-THROWN', true],
    [
      'notify',
      'call-notify',
      '[invalid_request] The request was rejected before sending. Set json for a webhook raw payload or use envelope mode.',
      true,
    ],
  ]) {
    const end = toolEnds.find((event) => event.toolName === name);
    const result = toolResults.find((event) => event.message.toolName === name)?.message;
    const context = `Pi ${version} ${name}`;
    assert.equal(end?.isError, expected, `${context} RPC error flag`);
    assert.equal(result?.isError, expected, `${context} tool-result error flag`);
    assert.equal(end.toolCallId, callId, `${context} RPC tool call ID`);
    assert.equal(result.toolCallId, callId, `${context} tool-result call ID`);
    if (name === 'resolved_failure')
      assert.equal(end.result.isError, true, `${context} raw tool return`);
    assert.deepEqual(end.result.content, [{ type: 'text', text }], `${context} RPC content`);
    assert.deepEqual(result.content, [{ type: 'text', text }], `${context} tool-result content`);
    if (name === 'notify' && !legacy) {
      assert.deepEqual(end.result.structuredContent?.error, {
        code: 'invalid_request',
        message: text.slice('[invalid_request] '.length),
      });
    }
    expectedProviderResults[callId] = { isError: expected, content: [{ type: 'text', text }] };
  }

  const finalMessage = events.findLast(
    (event) => event.type === 'message_end' && event.message.role === 'assistant',
  )?.message;
  assert.equal(finalMessage?.stopReason, 'stop', `Pi ${version} final assistant stop reason`);
  assert.equal(finalMessage.content.length, 1, `Pi ${version} provider observations`);
  assert.equal(finalMessage.content[0].type, 'text', `Pi ${version} provider observation type`);
  assert.deepEqual(
    JSON.parse(finalMessage.content[0].text),
    expectedProviderResults,
    `Pi ${version} tool errors received by provider`,
  );
  console.log(
    `Pi ${version}: RPC events and provider input preserve Channels errors and fixture error flags.`,
  );
}
