import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { fullMatrix, selectIntegrationMatrix } from './integration-matrix.mjs';

const expectedComputerUseScenarios = [
  ['pi-computer-use', 'linux'],
  ['pi-computer-use', 'macos'],
  ['pi-computer-use', 'windows'],
];

test('requires environment approval for secret-backed fork integration', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');

  assert.match(workflow, /pull_request_target:\s+branches: \[master, main\]/);
  assert.doesNotMatch(workflow, /\n  pull_request:\n/);
  assert.doesNotMatch(workflow, /github\.event_name != 'pull_request_target' \|\|/);
  assert.equal(workflow.match(/name: \$\{\{ github\.event_name == 'pull_request_target' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository && 'fork-integration' \|\| 'integration' \}\}/g)?.length, 1);
  assert.equal(workflow.match(/deployment: false/g)?.length, 1);
  assert.match(workflow, /integration-approval:\s+name: Approve secret-backed Integration/);
  assert.match(workflow, /pi-runtime-smoke:[\s\S]*?needs: integration-approval/);
  assert.match(workflow, /extension-tool-matrix:[\s\S]*?needs: \[detect-extension-matrix, integration-approval\]/);
  assert.equal(workflow.match(/allow-unsafe-pr-checkout:/g)?.length, 5);
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 5);
  assert.equal(workflow.match(/ref: \$\{\{ env\.INTEGRATION_CHECKOUT_REF \}\}/g)?.length, 5);
  assert.doesNotMatch(workflow, /integration-approved/);
  assert.match(workflow, /PI_INTEGRATION_BASE_URL and PI_INTEGRATION_API_KEY are required for Stage B/);
  assert.match(workflow, /PI_INTEGRATION_\* secrets are required for Stage C/);
});

test('runs the real Cua Driver MCP lifecycle on macOS and Windows', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const job = workflow.slice(
    workflow.indexOf('  computer-use-platform-e2e:'),
    workflow.indexOf('  integration-approval:'),
  );
  assert.match(job, /runner: macos-15/);
  assert.match(job, /runner: windows-2025/);
  assert.match(job, /node packages\/pi-computer-use\/scripts\/fetch-driver\.mjs/);
  assert.match(job, /pnpm --filter @amaster\.ai\/pi-shared build/);
  assert.match(job, /node tests\/computer-use-driver-e2e\.mjs/);
});

test('runs model-backed computer-use E2E on Linux, macOS, and Windows', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const matrixJob = workflow.slice(workflow.indexOf('  extension-tool-matrix:'));
  const scenarios = selectIntegrationMatrix(['packages/pi-computer-use/src/index.ts'])
    .map(({ extension, scenario }) => [extension, scenario]);

  assert.deepEqual(scenarios, expectedComputerUseScenarios);
  const macos = fullMatrix.find(({ extension, scenario }) => extension === 'pi-computer-use' && scenario === 'macos');
  assert.equal(macos.tools, 'computer_use_check_permissions');
  assert.match(macos.prompt, /prompt=false/);
  assert.doesNotMatch(matrixJob, /matrix\.runner/);
  assert.match(matrixJob, /matrix\.scenario == 'macos' && 'macos-15'/);
  assert.match(matrixJob, /matrix\.scenario == 'windows' && 'windows-2025'/);
  assert.match(matrixJob, /defaults:\s+run:\s+shell: bash/);
  assert.match(matrixJob, /build: \$\{\{ matrix\.extension != 'pi-computer-use' && 'true' \|\| 'false' \}\}/);
  assert.match(matrixJob, /pnpm --filter @amaster\.ai\/pi-shared build/);
  assert.match(matrixJob, /pnpm --filter @amaster\.ai\/pi-computer-use build/);
  assert.match(matrixJob, /RUNNER_TEMP="\$\{RUNNER_TEMP\/\/\\\\\/\/\}"/);
  assert.match(matrixJob, /Run extension prompt \(Stage C\)/);
});

test('loads pi-telemetry for every model-backed integration run', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const smoke = workflow.slice(workflow.indexOf('  pi-runtime-smoke:'), workflow.indexOf('  extension-tool-matrix:'));
  const matrix = workflow.slice(workflow.indexOf('  extension-tool-matrix:'));
  assert.match(smoke, /pi install "\.\/packages\/pi-telemetry"/);
  assert.match(smoke, /LANGFUSE_PUBLIC_KEY: \${{ secrets\.LANGFUSE_PUBLIC_KEY }}/);
  assert.match(matrix, /pi install "\.\/packages\/pi-telemetry"/);
  assert.match(matrix, /LANGFUSE_PUBLIC_KEY: \${{ secrets\.LANGFUSE_PUBLIC_KEY }}/);
  assert.doesNotMatch(matrix, /matrix\.extension == 'pi-telemetry' && secrets\.LANGFUSE/);
});

test('enables the local fetch fallback in the DeepSeek web-access scenario', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const deepseek = workflow.slice(
    workflow.indexOf('if [ "${{ matrix.provider }}" = "deepseek" ]'),
    workflow.indexOf('elif [ "${{ matrix.provider }}" = "dashscope" ]'),
  );
  assert.match(deepseek, /"fetch": \{\s*"summary": \{/);
});

test('selects every scenario for a changed extension', () => {
  const selected = selectIntegrationMatrix(['packages/pi-image-gen/src/index.ts']);
  assert.deepEqual(selected.map(({ extension, provider }) => [extension, provider]), [
    ['pi-image-gen', undefined],
    ['pi-image-gen', 'seedream-lite'],
  ]);
});

test('selects a separate Langfuse hierarchy scenario', () => {
  const selected = selectIntegrationMatrix(['packages/pi-telemetry/src/extension.ts']);
  assert.deepEqual(
    selected.map(({ extension, scenario }) => [extension, scenario]),
    [
      ['pi-telemetry', undefined],
      ['pi-telemetry', 'hierarchy'],
      ['pi-telemetry', 'redacted'],
    ],
  );
});

test('routes companion packages and package-specific integration tests', () => {
  assert.deepEqual(
    selectIntegrationMatrix(['packages/pi-memory-mem0/src/index.ts']).map(({ extension }) => extension),
    ['pi-memory', 'pi-memory-mem0'],
  );
  for (const file of ['tests/computer-use-owner-exit.mjs', 'tests/computer-use-driver-e2e.mjs']) {
    assert.deepEqual(
      selectIntegrationMatrix([file]).map(({ extension, scenario }) => [extension, scenario]),
      expectedComputerUseScenarios,
    );
  }
});

test('runs the full matrix for shared and integration infrastructure changes', () => {
  for (const file of [
    'packages/shared/src/settings.ts',
    '.github/workflows/integration.yml',
    '.github/actions/setup-pi-build/action.yml',
    'pnpm-lock.yaml',
  ]) {
    assert.equal(selectIntegrationMatrix([file]).length, fullMatrix.length, file);
  }
  assert.equal(selectIntegrationMatrix([], { forceAll: true }).length, fullMatrix.length);
});

test('skips Stage C when no tested extension changed', () => {
  assert.deepEqual(selectIntegrationMatrix(['README.md']), []);
  assert.deepEqual(
    selectIntegrationMatrix(['packages/pi-telemetry/src/extension.ts']).map(({ extension }) => extension),
    ['pi-telemetry', 'pi-telemetry', 'pi-telemetry'],
  );
  assert.deepEqual(
    selectIntegrationMatrix(['.github/scripts/telemetry-langfuse-verify.mjs']).map(({ extension }) => extension),
    ['pi-telemetry', 'pi-telemetry', 'pi-telemetry'],
  );
});


test('threads the integration model through generated configs and skill evaluation', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const skillEval = await readFile(new URL('../workflows/skill-eval.yml', import.meta.url), 'utf8');
  for (const source of [workflow, skillEval]) {
    assert.ok(source.includes("vars.PI_INTEGRATION_MODEL || secrets.PI_INTEGRATION_MODEL || 'deepseek-v4-flash'"));
  }
  assert.doesNotMatch(workflow, /--model deepseek-v4-flash|"model": "deepseek-v4-flash"/);
  const documents = [...workflow.matchAll(/cat > "\$PI_CODING_AGENT_DIR\/(models|settings)\.json" <<EOF\n([\s\S]*?)\n          EOF/g)];
  assert.equal(documents.length, 4);
  for (const model of ['deepseek-v4-flash', 'glm-5.3-flash', 'custom-model']) {
    const configs = documents.map(([, kind, body]) => [kind, JSON.parse(execFileSync('bash', ['-c', `cat <<EOF\n${body}\nEOF`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, PI_INTEGRATION_MODEL: model, WEB_ACCESS_SETTINGS: '{}', IMAGE_GEN_MODEL: 'image-model', INCLUDE_PAYLOADS_JSON: 'true', RUNNER_TEMP: '/tmp/pi-integration-config-test' },
    }))]);
    for (const [, config] of configs.filter(([kind]) => kind === 'models')) {
      assert.equal(config.providers['deepseek-integration'].models[0].id, model);
      assert.equal(config.providers['deepseek-integration'].models[0].maxTokens, 131072);
    }
    const settings = configs.filter(([kind]) => kind === 'settings')[1][1];
    assert.equal(settings['pi-goal'].model.model, model);
    assert.equal(settings['pi-memory-mem0'].oss.llm.config.model, model);
    assert.equal(settings['pi-memory-mem0'].oss.embedder.config.model, 'text-embedding-v4');
    assert.equal(settings['pi-browser-use'].visionModel.model, 'kimi-k2.6');
    // Non-redacted legs keep payloads on; the redacted scenario flips this to
    // false in the workflow before the heredoc runs.
    assert.equal(settings['pi-telemetry'].includePayloads, true);
  }
});
