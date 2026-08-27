import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { fullMatrix, selectIntegrationMatrix } from './integration-matrix.mjs';

test('runs secret-free integration stages for fork pull requests', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const secretFreeStages = workflow.slice(0, workflow.indexOf('  pi-runtime-smoke:'));
  assert.doesNotMatch(secretFreeStages, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.equal(
    workflow.match(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/g)?.length,
    2,
  );
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
    ],
  );
});

test('routes companion packages and package-specific integration tests', () => {
  assert.deepEqual(
    selectIntegrationMatrix(['packages/pi-memory-mem0/src/index.ts']).map(({ extension }) => extension),
    ['pi-memory', 'pi-memory-mem0'],
  );
  assert.deepEqual(
    selectIntegrationMatrix(['tests/computer-use-owner-exit.mjs']).map(({ extension }) => extension),
    ['pi-computer-use'],
  );
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
    ['pi-telemetry', 'pi-telemetry'],
  );
  assert.deepEqual(
    selectIntegrationMatrix(['.github/scripts/telemetry-langfuse-verify.mjs']).map(({ extension }) => extension),
    ['pi-telemetry', 'pi-telemetry'],
  );
});
