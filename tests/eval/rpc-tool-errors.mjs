import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const timeoutMs = 15_000;
const usage = 'Usage: node tests/eval/rpc-tool-errors.mjs <0.79.1-package-dir> <1.6.0-package-dir>';
const inputs = process.argv.slice(2);
assert.equal(inputs.length, 2, usage);

const runtimes = await Promise.all(
  ['0.79.1', '1.6.0'].map(async (version, index) => {
    const directory = resolve(inputs[index]);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@earendil-works/pi-coding-agent', directory);
    assert.equal(manifest.version, version, `${directory}: expected Pi ${version}`);
    const cli = resolve(directory, manifest.bin.pi);
    await access(cli);
    return { version, cli };
  }),
);

async function collectRpcEvents(child) {
  const events = [];
  let partial = '';
  let bytes = 0;
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    bytes += Buffer.byteLength(chunk);
    assert.ok(bytes <= 256 * 1024, 'RPC output exceeded the fixture budget');
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'agent_end') child.stdin.end();
    }
  }
  assert.equal(partial.trim(), '', 'Incomplete RPC record');
  return events;
}

async function runProbe({ version, cli }) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-tool-errors-'));
  try {
    const agentDir = join(directory, 'agent');
    const fixture = join(directory, 'fixture.ts');
    await mkdir(agentDir);
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
        '--no-approve',
        '--provider',
        'rpc-fixture',
        '--model',
        'scripted',
        '-e',
        fixture,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          PI_CODING_AGENT_DIR: agentDir,
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
    const closed = new Promise((finish) => child.once('close', finish));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    try {
      child.stdin.write(
        `${JSON.stringify({ id: 'probe', type: 'prompt', message: 'Exercise both fixture tools.' })}\n`,
      );
      const events = await collectRpcEvents(child);
      const exitCode = await closed;
      if (processError) throw processError;
      assert.ok(!timedOut, `Pi ${version} RPC timed out after ${timeoutMs} ms`);
      assert.equal(exitCode, 0, `Pi ${version} RPC exited with ${exitCode}\n${stderr}`);
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
  const { version } = runtime;
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
  assert.equal(toolEnds.length, 2, `Pi ${version} RPC tool results`);
  assert.equal(toolResults.length, 2, `Pi ${version} model-facing tool results`);

  for (const [name, text, expected] of [
    ['resolved_failure', 'SAFE-RESOLVED', version === '1.6.0'],
    ['thrown_failure', 'SAFE-THROWN', true],
  ]) {
    const end = toolEnds.find((event) => event.toolName === name);
    const result = toolResults.find((event) => event.message.toolName === name)?.message;
    const context = `Pi ${version} ${name}`;
    assert.equal(end?.isError, expected, `${context} RPC error flag`);
    assert.equal(result?.isError, expected, `${context} model-facing error flag`);
    assert.equal(result.toolCallId, end.toolCallId, `${context} tool call ID`);
    if (name === 'resolved_failure')
      assert.equal(end.result.isError, true, `${context} raw tool return`);
    assert.deepEqual(end.result.content, [{ type: 'text', text }], `${context} RPC content`);
    assert.deepEqual(result.content, [{ type: 'text', text }], `${context} model-facing content`);
    console.log(
      `${context}: tool_execution_end.isError=${end.isError}, toolResult.isError=${result.isError}`,
    );
  }
}
