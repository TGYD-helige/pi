import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { fullMatrix, selectIntegrationMatrix } from './integration-matrix.mjs';

test('uses non-thinking tool integration while retaining the reasoning smoke check', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const matrix = workflow.slice(workflow.indexOf('  extension-tool-matrix:'));
  const smoke = workflow.slice(workflow.indexOf('  pi-runtime-smoke:'), workflow.indexOf('  extension-tool-matrix:'));
  assert.equal(matrix.match(/--thinking off/g)?.length, 2);
  assert.doesNotMatch(matrix, /--thinking high/);
  assert.match(smoke, /--thinking xhigh/);
  const child = await readFile(new URL('./telemetry-subagent.sh', import.meta.url), 'utf8');
  assert.match(child, /--thinking off/);
});

const expectedComputerUseScenarios = [
  ['pi-computer-use', 'linux'],
  ['pi-computer-use', 'macos'],
  ['pi-computer-use', 'windows'],
];

const expectedVideoGenScenarios = [
  ['pi-video-gen', 'linux'],
  ['pi-video-gen', 'macos'],
  ['pi-video-gen', 'windows'],
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
  assert.equal(workflow.match(/allow-unsafe-pr-checkout:/g)?.length, 6);
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 6);
  assert.equal(workflow.match(/ref: \$\{\{ env\.INTEGRATION_CHECKOUT_REF \}\}/g)?.length, 6);
  assert.match(workflow, /browserless-session-e2e:[\s\S]*?needs: \[detect-extension-matrix, integration-approval, extension-tool-matrix\]/);
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
  assert.match(job, /node \.github\/scripts\/computer-use-driver-e2e\.mjs/);
});

test('verifies perception installation and real inference on every supported target', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('  computer-use-platform-e2e:'), workflow.indexOf('  integration-approval:'));
  for (const target of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
    assert.ok(job.includes(`perception_target: ${target}`));
  }
  assert.match(job, /node packages\/pi-computer-use\/scripts\/fetch-perception\.mjs \$\{\{ matrix\.perception_target \}\}/);
  assert.match(job, /node \.github\/scripts\/computer-use-perception-e2e\.mjs/);
  assert.match(job, /xvfb-run -a/);
});

test('keeps the base workflow Perception fetch command callable without a destination', () => {
  const script = new URL('../../packages/pi-computer-use/scripts/fetch-perception.mjs', import.meta.url);
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '--eval', `
    process.argv[2] = 'darwin-arm64';
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await import(${JSON.stringify(script.href)});
  `], { stdio: 'pipe' }), (error) => {
    assert.match(error.stderr.toString(), /Cua Perception download failed \(503\)/);
    return true;
  });
});

test('runs model-backed computer-use E2E on Linux, macOS, and Windows', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const matrixJob = workflow.slice(workflow.indexOf('  extension-tool-matrix:'));
  const scenarios = selectIntegrationMatrix(['packages/pi-computer-use/src/index.ts'])
    .map(({ extension, scenario }) => [extension, scenario]);

  assert.deepEqual(scenarios, expectedComputerUseScenarios);
  const macos = fullMatrix.find(({ extension, scenario }) => extension === 'pi-computer-use' && scenario === 'macos');
  // No tools allowlist: deferred-group narrowing keeps the target invisible
  // until the model activates diagnostics via computer_use_tools.
  assert.equal(macos.tools, undefined);
  assert.equal(fullMatrix.find(({ extension, scenario }) => extension === 'pi-computer-use' && scenario === 'linux').tools, undefined);
  assert.match(macos.prompt, /computer_use_tools with group=diagnostics/);
  assert.match(macos.prompt, /prompt=false/);
  assert.equal(macos.assert_tool, 'computer_use_check_permissions');
  assert.equal(macos.assert_tool_count, 1);
  assert.equal(macos.allow_tool_error, true);
  assert.equal(macos.assert_pattern, 'permissions_pending');
  assert.doesNotMatch(matrixJob, /matrix\.runner/);
  assert.match(matrixJob, /matrix\.scenario == 'macos' && 'macos-15'/);
  assert.match(matrixJob, /matrix\.scenario == 'windows' && 'windows-2025'/);
  assert.match(matrixJob, /defaults:\s+run:\s+shell: bash/);
  assert.match(matrixJob, /build: \$\{\{ matrix\.extension != 'pi-computer-use' && 'true' \|\| 'false' \}\}/);
  assert.match(matrixJob, /pnpm --filter @amaster\.ai\/pi-shared build/);
  assert.match(matrixJob, /pnpm --filter @amaster\.ai\/pi-computer-use build/);
  assert.match(matrixJob, /RUNNER_TEMP="\$\{RUNNER_TEMP\/\/\\\\\/\/\}"/);
  assert.match(matrixJob, /matrix\.allow_tool_error.*!= "true"/);
  assert.match(matrixJob, /Run extension prompt \(Stage C\)/);
  // --tools is conditional so entries without an allowlist get the full surface.
  assert.match(matrixJob, /if \[ -n '\$\{\{ matrix\.tools \}\}' \]/);
  // bash 3.2 (macOS runner) rejects empty-array expansion under set -u.
  assert.match(matrixJob, /\$\{tools_args\[@\]\+"\$\{tools_args\[@\]\}"\}/);
});

test('runs browser-use E2E on the full surface with a deferred-group activation step', async () => {
  const basic = fullMatrix.find(
    ({ extension, scenario }) => extension === 'pi-browser-use' && !scenario,
  );
  assert.equal(basic.tools, undefined);
  assert.match(basic.prompt, /browser_tools with group=network/);
  assert.equal(basic.assert_tool, 'browser_list_network_requests');
  assert.equal(basic.assert_tool_pattern, 'example\\.com');

  const screenshot = fullMatrix.find(
    ({ extension, scenario }) => extension === 'pi-browser-use' && scenario === 'screenshot',
  );
  assert.equal(screenshot.tools, undefined);
});

test('runs video composition E2E on Linux, macOS, and Windows', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../actions/setup-pi-build/action.yml', import.meta.url), 'utf8');
  const matrixJob = workflow.slice(workflow.indexOf('  extension-tool-matrix:'));
  const scenarios = selectIntegrationMatrix(['packages/pi-video-gen/src/index.ts'])
    .map(({ extension, scenario }) => [extension, scenario]);

  assert.deepEqual(scenarios, expectedVideoGenScenarios);
  assert.match(matrixJob, /matrix\.scenario == 'macos' && 'macos-15'/);
  assert.match(matrixJob, /matrix\.scenario == 'windows' && 'windows-2025'/);
  assert.match(matrixJob, /name: pi-video-gen-preview-promo-\$\{\{ matrix\.scenario \}\}/);
  assert.match(setup, /if \[ "\$RUNNER_OS" = "Windows" \]; then/);
  assert.match(setup, /"\$BIN_DIR\/ffmpeg\$EXE_SUFFIX"/);
  assert.match(setup, /"\$BIN_DIR\/ffprobe\$EXE_SUFFIX"/);
  assert.match(matrixJob, /PI_E2E_CLI="\$\(npm root --global\)\/@earendil-works\/pi-coding-agent\/dist\/cli\.js"/);
  assert.match(matrixJob, /const child = spawn\(\s*process\.execPath,\s*\[\s*process\.env\.PI_E2E_CLI,/);
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

test('routes browser lifecycle scripts and shared fixtures to browser integration', () => {
  for (const file of ['.github/scripts/browserless-session-e2e.mjs', 'tests/browser-session-e2e.mjs', 'tests/fixtures/browser-session-harness.mjs']) {
    assert.ok(selectIntegrationMatrix([file]).some(({ extension }) => extension === 'pi-browser-use'), file);
  }
});

test('can isolate manual Browserless session runs while preserving the shared approval gate', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+browser_session_only:[\s\S]*?type: boolean/);
  for (const name of ['computer-use-platform-e2e', 'pi-runtime-smoke', 'extension-tool-matrix']) {
    const job = workflow.slice(workflow.indexOf(`  ${name}:`)).split(/\n  [\w-]+:/)[0];
    assert.match(job, /!inputs\.browser_session_only/);
  }
  const job = workflow.slice(workflow.indexOf('  browserless-session-e2e:'), workflow.indexOf('  pi-runtime-smoke:'));
  assert.match(job, /needs: \[detect-extension-matrix, integration-approval, extension-tool-matrix\]/);
  assert.match(job, /always\(\) && !cancelled\(\)/);
  assert.match(job, /needs\.integration-approval\.result == 'success'/);
  assert.match(job, /needs\.detect-extension-matrix\.result == 'success'/);
  assert.doesNotMatch(job, /!inputs\.browser_session_only/);
});

test('checks screenshot tool results even when stderr diagnostics are mixed into the event stream', async () => {
  const workflow = await readFile(new URL('../workflows/integration.yml', import.meta.url), 'utf8');
  const scenario = fullMatrix.find(({ extension, scenario }) => extension === 'pi-browser-use' && scenario === 'screenshot');
  assert.equal(scenario.assert_tool, 'browser_analyze_screenshot');
  assert.equal(scenario.assert_tool_count, 1);
  assert.notEqual(scenario.assert_visual_analysis, true);
  const assertion = workflow.slice(workflow.indexOf('          # Cases with assert_tool'), workflow.indexOf('          # Image generation may'))
    .replace(/\$\{\{ matrix\.(assert_tool_pattern \|\| matrix\.assert_pattern|assert_tool_count \|\| 0|assert_tool_count|allow_tool_error|assert_tool) \}\}/g, (_, key) => String(scenario[key.split(' || ')[0]] ?? ''));
  const result = { type: 'tool_execution_end', toolName: 'browser_analyze_screenshot', isError: false,
    result: { content: [{ type: 'text', text: 'Large heading: VISUAL CHECK 7391\nDominant background: bright blue (#1E50E0)' }] } };
  for (const text of [result.result.content[0].text, 'Heading: VISUAL CHECK 7391 only', 'Background: blue only']) {
    const event = { ...result, result: { content: [{ type: 'text', text }] } };
    const events = JSON.stringify({ type: 'tool_execution_start', toolName: scenario.assert_tool }) + '\n' + JSON.stringify(event);
    const run = () => execFileSync('bash', ['-c', assertion], { encoding: 'utf8', stdio: 'pipe', env: {
      PATH: process.env.PATH, output: `[pi-telemetry] export completed\n${events}\nstartup diagnostic`, EVENTS_JSON: events,
    } });
    if (text === result.result.content[0].text) assert.doesNotThrow(run);
    else assert.throws(run);
  }
});

test('uses configured Seedream defaults without inventing unsupported size or model parameters', () => {
  const scenario = fullMatrix.find(({ extension, provider }) => extension === 'pi-image-gen' && provider === 'seedream-lite');
  assert.match(scenario.prompt, /omit.*size.*model/i);
  assert.equal(scenario.assert_tool, 'image_generate');
  assert.equal(scenario.assert_tool_count, 1);
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
  assert.deepEqual(
    selectIntegrationMatrix(['.github/scripts/pi-memory-snapshot-e2e.mjs']).map(({ extension }) => extension),
    ['pi-memory'],
  );
  for (const file of ['tests/computer-use-owner-exit.mjs', 'tests/computer-use-driver-e2e.mjs', '.github/scripts/computer-use-driver-e2e.mjs', '.github/scripts/computer-use-owner-exit.mjs', '.github/scripts/computer-use-perception-e2e.mjs', '.github/scripts/fixtures/computer-use-perception.png', 'packages/pi-computer-use/scripts/fetch-perception.mjs', '.github/scripts/fixtures/computer-use-perception-release.json']) {
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
    const visionModels = configs.filter(([kind]) => kind === 'models')[1][1].providers['deepseek-integration'].models;
    assert.deepEqual(visionModels.find((entry) => entry.id === 'deepseek-flash').input, ['text', 'image']);
    assert.equal(settings['pi-goal'].model.model, model);
    assert.equal(settings['pi-memory-mem0'].oss.llm.config.model, model);
    assert.equal(settings['pi-memory-mem0'].oss.embedder.config.model, 'text-embedding-v4');
    assert.equal(settings['pi-browser-use'].visionModel.model, 'deepseek-flash');
    // Non-redacted legs keep payloads on; the redacted scenario flips this to
    // false in the workflow before the heredoc runs.
    assert.equal(settings['pi-telemetry'].includePayloads, true);
  }
});
