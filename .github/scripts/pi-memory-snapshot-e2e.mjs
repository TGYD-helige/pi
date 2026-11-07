#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'pi-memory-snapshot-e2e-'));
const agentDir = path.join(root, 'agent');
const sessionDir = path.join(root, 'sessions');
const memoryFile = path.join(agentDir, 'memories', 'MEMORY.md');
const extension = path.resolve('packages/pi-memory/dist/index.js');
const piCli = path.resolve('packages/pi-memory/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  assert.equal(request.url, '/v1/responses');
  requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`event: response.completed
data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp-memory-test', object: 'response', created_at: 0, status: 'completed', model: 'memory-test',
      output: [{ id: 'msg-memory-test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    },
  })}\n\n`);
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await mkdir(path.dirname(memoryFile), { recursive: true });
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'memory-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-responses',
        apiKey: 'test-key',
        models: [{ id: 'memory-test', name: 'Memory test', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  await writeFile(memoryFile, 'cobalt memory');

  const baseArgs = [
    '--provider', 'memory-test', '--model', 'memory-test', '--api-key', 'test-key',
    '--session-dir', sessionDir, '--extension', extension, '--no-extensions',
    '--no-context-files', '--no-skills', '--no-tools', '--no-approve', '--mode', 'json', '-p', 'hello',
  ];
  const env = { ...process.env, PI_AGENT_HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '0' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[key];
  const runPi = (args) => {
    const task = run(process.execPath, [piCli, ...args], { cwd: root, env, timeout: 15_000 });
    task.child.stdin.end();
    return task;
  };
  await runPi(baseArgs);
  const [sessionFile] = await readdir(sessionDir);
  assert(sessionFile?.endsWith('.jsonl'), 'Pi did not persist the session');

  await writeFile(memoryFile, 'amber memory');
  await runPi(['--session', path.join(sessionDir, sessionFile), ...baseArgs]);
  await runPi(['--fork', path.join(sessionDir, sessionFile), ...baseArgs]);

  assert.equal(requests.length, 3);
  const systems = requests.map(({ input, instructions }) => JSON.stringify({ instructions, input: input.filter(({ role }) => role === 'system' || role === 'developer') }));
  assert.match(systems[0], /cobalt memory/);
  assert.equal(systems[1], systems[0], 'resumed system prompt changed before compaction');
  assert.match(systems[2], /amber memory/, 'fork did not load current memory');
  assert.doesNotMatch(systems[2], /cobalt memory/);
  process.stdout.write('pi-memory system snapshot: initial, resume, fork verified\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
