import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it, vi } from 'vitest';

const run = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

async function withGateway(output, verify) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ output }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await verify(baseUrl, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertResponses(request) {
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.body.store, false);
  assert(request.body.max_output_tokens > 0);
  assert.equal(request.body.messages, undefined);
  assert.equal(request.body.input[0].role, 'system');
}

describe('CI Responses API entry points', () => {
  it.each([true, false])('runs the full labeler entry and handles text=%s', async (hasText) => {
    const output = [{ type: 'reasoning', summary: [] }, ...(hasText ? [{ type: 'message', content: [
      { type: 'output_text', text: '{"priority":"P2",' },
      { type: 'output_text', text: '"reason":"Normal feature"}' },
    ] }] : [])];
    await withGateway(output, async (baseUrl, requests) => {
      vi.stubEnv('PI_INTEGRATION_BASE_URL', baseUrl);
      vi.stubEnv('PI_INTEGRATION_API_KEY', 'fixture');
      const workflow = await readFile(new URL('../.github/workflows/labeler.yml', import.meta.url), 'utf8');
      const script = workflow.split('          script: |\n')[1].split('\n').map((line) => line.slice(12)).join('\n');
      const addLabels = vi.fn(async () => {});
      const github = {
        rest: {
          issues: { createLabel: async () => {}, addLabels, removeLabel: async () => {} },
          pulls: { get: async () => ({ data: { number: 1, title: 'feat: fixture', labels: [], head: { repo: { full_name: 'fixture/repo' } } } }), listFiles: () => {} },
        },
        paginate: async () => [{ filename: '.github/workflows/labeler.yml', additions: 1, deletions: 0 }],
      };
      const context = { repo: { owner: 'fixture', repo: 'repo' }, eventName: 'pull_request_target', payload: { pull_request: { number: 1 } } };
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction('github', 'context', 'core', script)(github, context, { info: () => {}, warning: () => {} });
      assert.equal(requests.length, 1);
      assertResponses(requests[0]);
      assert.equal(addLabels.mock.calls.some(([call]) => call.labels.includes('P2')), hasText);
    });
  });

  it.each([true, false])('runs the release CLI and handles text=%s', async (hasText) => {
    const output = [{ type: 'reasoning', summary: [] }, ...(hasText ? [{ type: 'message', content: [
      { type: 'output_text', text: '## Fixture\n\n' }, { type: 'output_text', text: 'Responses summary.' },
    ] }] : [])];
    await withGateway(output, async (baseUrl, requests) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'pi-ci-responses-'));
      try {
        const outputFile = path.join(directory, 'release.md');
        await run(process.execPath, ['.github/scripts/generate-release-summary.mjs', '--version', '0.0.0-fixture', '--channel', 'beta', '--output', outputFile], {
          env: { ...process.env, PI_INTEGRATION_BASE_URL: baseUrl, PI_INTEGRATION_API_KEY: 'fixture', GH_TOKEN: '', GITHUB_REPOSITORY: '' }, timeout: 10_000,
        });
        assert.equal(requests.length, 1);
        assertResponses(requests[0]);
        const content = await readFile(outputFile, 'utf8');
        assert.equal(content.includes('## Fixture\n\nResponses summary.'), hasText);
        assert(content.includes(hasText ? 'Responses summary.' : '## Changes'));
        assert(content.includes('## Release details'));
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  });
});
