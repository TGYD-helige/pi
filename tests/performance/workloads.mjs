import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { measurePlugins, pluginMetrics } from './plugins.mjs';

export const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// shortcut: hosted-runner noise margins are provisional; calibrate using collected CI samples.
export const metrics = Object.fromEntries(
  [
    ['coldImportMs', 5],
    ['scanMs', 0.2],
    ['scanLargeMs', 1],
    ['boundOutputMs', 0.2],
    ['boundLargeOutputMs', 1],
    ['settingsSyncMs', 0.2],
    ['settingsAsyncMs', 1],
    ['settingsConcurrent8Ms', 3],
    ['policy32FilesMs', 5],
    ['memoryLoadMs', 1],
    ['memoryReadMs', 1],
    ['memoryPromptMs', 0.02],
    ['memoryWriteRoundtripMs', 3],
    ['memoryConcurrent4Ms', 50],
    ['telemetryDisabledSessionMs', 2],
    ['telemetryDisabledPromptMs', 0.02],
    ['telemetryProject100MessagesMs', 1],
    ['telemetrySerialize100MessagesMs', 1],
    ['telemetryRejectOversizedMs', 0.2],
    ['telemetryMaskHeadersMs', 0.2],
    ['telemetryRedactMs', 1],
    ['telemetryTruncate1MiBMs', 1],
    ['telemetryPublish100EventsMs', 5],
    ['telemetryLifecycleMs', 3],
  ]
    .map(([name, slack]) => [name, { unit: 'ms', slack }])
    .concat([['telemetryRetainedHeapMiB', { unit: 'MiB', slack: 8 }]]),
);

Object.assign(metrics, pluginMetrics);

export async function measure(root) {
  const load = (relative) => import(pathToFileURL(path.resolve(root, 'packages', relative)).href);
  const result = {};
  const start = performance.now();
  const { boundStructuredContent } = await load('shared/dist/index.js');
  const { scanForThreats } = await load('shared/dist/threat-patterns.js');
  result.coldImportMs = performance.now() - start;
  const { default: telemetryExtension } = await load('pi-telemetry/dist/index.js');
  const { loadPiSettings, loadPiSettingsAsync, loadPiPolicyProfilesAsync } =
    await load('shared/dist/settings.js');
  const { MemoryStore } = await load('pi-memory/dist/store.js');
  const { captureProviderHeaders, providerDisplayInput, serializeTelemetryValue } = await load(
    'pi-telemetry/dist/observations.js',
  );
  const { redactTelemetryValue, truncateAttributePayload } = await load(
    'pi-telemetry/dist/otel/utils.js',
  );
  const { MAX_ATTRIBUTE_VALUE_BYTES } = await load('pi-telemetry/dist/otel/types.js');
  const { OtelRuntimeEventExporter } = await load('pi-telemetry/dist/otel/exporters.js');
  const require = createRequire(path.resolve(root, 'packages/pi-telemetry/package.json'));
  const {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
  } = require('@opentelemetry/sdk-trace-base');

  function sync(name, operation, iterations = 50) {
    for (let i = 0; i < 5; i++) operation();
    const samples = [];
    for (let batch = 0; batch < 5; batch++) {
      const started = performance.now();
      for (let i = 0; i < iterations; i++) operation();
      samples.push((performance.now() - started) / iterations);
    }
    result[name] = median(samples);
  }
  async function asyncTime(name, operation, iterations = 5) {
    await operation();
    const samples = [];
    for (let batch = 0; batch < 5; batch++) {
      const started = performance.now();
      for (let i = 0; i < iterations; i++) await operation();
      samples.push((performance.now() - started) / iterations);
    }
    result[name] = median(samples);
  }

  const fixture = await mkdtemp(path.join(tmpdir(), 'pi-performance-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousAgentHome = process.env.PI_AGENT_HOME;
  try {
    const project = path.join(fixture, 'project');
    const agentDir = path.join(fixture, 'agent');
    const policyDir = path.join(project, '.pi/policy');
    await mkdir(policyDir, { recursive: true });
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_HOME = agentDir;
    await writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ 'performance-fixture': { source: 'agent', size: 10 } }),
    );
    await writeFile(
      path.join(project, '.pi/settings.json'),
      JSON.stringify({
        'performance-fixture': { source: 'project', value: '$UNEXPANDED' },
        'pi-telemetry': {
          langfuse: { enabled: false },
          otel: { enabled: false },
          phoenix: { enabled: false },
        },
      }),
    );
    for (let i = 0; i < 32; i++)
      await writeFile(
        path.join(policyDir, `performance-${i}.json`),
        JSON.stringify({ allow: ['read'], index: i }),
      );
    const options = { cwd: project, configDir: agentDir, projectTrusted: true };
    const expected = { source: 'project', size: 10, value: '$UNEXPANDED' };
    assert.deepEqual(loadPiSettings('performance-fixture', options), expected);
    assert.deepEqual(await loadPiSettingsAsync('performance-fixture', options), expected);
    assert.equal(
      (await loadPiSettingsAsync('performance-fixture', { ...options, projectTrusted: false }))
        .source,
      'agent',
    );
    const policies = await loadPiPolicyProfilesAsync(options);
    for (let i = 0; i < 32; i++)
      assert.deepEqual(policies[`performance-${i}`], { allow: ['read'], index: i });
    sync('settingsSyncMs', () => loadPiSettings('performance-fixture', options));
    await asyncTime('settingsAsyncMs', () => loadPiSettingsAsync('performance-fixture', options));
    await asyncTime('settingsConcurrent8Ms', () =>
      Promise.all(
        Array.from({ length: 8 }, () => loadPiSettingsAsync('performance-fixture', options)),
      ),
    );
    await asyncTime('policy32FilesMs', () => loadPiPolicyProfilesAsync(options), 2);

    const context =
      'The project uses TypeScript and pnpm. Review the extension lifecycle.\n'.repeat(500);
    assert.deepEqual(scanForThreats(context), []);
    assert.ok(scanForThreats('hidden\u200btext').length > 0);
    sync('scanMs', () => scanForThreats(context));
    sync('scanLargeMs', () => scanForThreats(context.repeat(16)), 10);
    const payload = {
      records: Array.from({ length: 100 }, (_, i) => ({
        id: `record-${i}`,
        content: 'x'.repeat(1000),
      })),
    };
    const largePayload = {
      records: Array.from({ length: 1000 }, (_, i) => ({
        id: `record-${i}`,
        content: 'x'.repeat(4000),
      })),
    };
    for (const input of [payload, largePayload]) {
      const bounded = boundStructuredContent(input);
      assert.equal(bounded.truncated, true);
      assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 12 * 1024);
      assert.equal(bounded.records[0].id, 'record-0');
    }
    sync('boundOutputMs', () => boundStructuredContent(payload), 10);
    sync('boundLargeOutputMs', () => boundStructuredContent(largePayload), 3);

    const memoryDir = path.join(fixture, 'memory');
    const store = new MemoryStore({ dir: memoryDir });
    await store.loadFromDisk();
    for (let i = 0; i < 12; i++)
      assert.equal(
        (await store.add('memory', `Project ${i} uses TypeScript and pnpm.`)).success,
        true,
      );
    await store.loadFromDisk();
    assert.equal(store.getEntries('memory').length, 12);
    assert.match(store.formatAllForSystemPrompt(), /Project 11/);
    await asyncTime('memoryLoadMs', () => new MemoryStore({ dir: memoryDir }).loadFromDisk());
    await asyncTime('memoryReadMs', () => store.read('memory'));
    sync('memoryPromptMs', () => store.formatAllForSystemPrompt());
    await asyncTime(
      'memoryWriteRoundtripMs',
      async () => {
        assert.equal((await store.add('memory', 'Temporary performance record')).success, true);
        assert.equal((await store.remove('memory', 'Temporary performance record')).success, true);
      },
      2,
    );
    await asyncTime(
      'memoryConcurrent4Ms',
      async () => {
        const added = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            store.add('memory', `Concurrent performance record ${i}`),
          ),
        );
        assert.ok(added.every((entry) => entry.success));
        assert.equal((await store.read('memory')).entryCount, 16);
        for (let i = 0; i < 4; i++)
          assert.equal(
            (await store.remove('memory', `Concurrent performance record ${i}`)).success,
            true,
          );
      },
      1,
    );
    assert.equal((await store.read('memory')).entryCount, 12);
    assert.ok(!(await readdir(memoryDir)).some((name) => /\.lock|\.tmp/.test(name)));

    const handlers = new Map();
    telemetryExtension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand() {},
    });
    let historyReads = 0;
    const ctx = {
      cwd: project,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => 'performance',
        getEntries: () => {
          historyReads++;
          return [];
        },
      },
    };
    await asyncTime('telemetryDisabledSessionMs', async () => {
      await handlers.get('session_start')({}, ctx);
      await handlers.get('session_shutdown')({}, ctx);
    });
    sync('telemetryDisabledPromptMs', () => {
      handlers.get('before_agent_start')({ prompt: context, systemPrompt: context }, ctx);
      handlers.get('agent_start')({}, ctx);
      handlers.get('context')({ messages: [] }, ctx);
    });
    assert.equal(historyReads, 0);

    const request = {
      instructions: 'Performance fixture',
      input: Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `Message ${i}: ${'text '.repeat(100)}`,
      })),
    };
    assert.equal(providerDisplayInput(request).length, 101);
    assert.deepEqual(JSON.parse(serializeTelemetryValue(request, 128 * 1024)), request);
    const oversized = { input: 'x'.repeat(2 * 1024 * 1024) };
    assert.equal(serializeTelemetryValue(oversized, 128 * 1024), undefined);
    const headers = {
      Authorization: 'fixture-secret',
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`x-header-${i}`, 'x'.repeat(1000)]),
      ),
    };
    assert.equal(captureProviderHeaders(headers).Authorization, '[redacted]');
    const redactionConfig = { maskingSecrets: ['fixture-secret'], redactFields: ['password'] };
    const privateRequest = { ...request, password: 'fixture-password', note: 'fixture-secret' };
    const masked = JSON.stringify(redactTelemetryValue(redactionConfig, privateRequest));
    assert.ok(!masked.includes('fixture-secret') && !masked.includes('fixture-password'));
    const multibyte = '中文'.repeat(175_000);
    assert.ok(Buffer.byteLength(truncateAttributePayload(multibyte)) <= MAX_ATTRIBUTE_VALUE_BYTES);
    sync('telemetryProject100MessagesMs', () => providerDisplayInput(request));
    sync('telemetrySerialize100MessagesMs', () => serializeTelemetryValue(request, 128 * 1024), 10);
    sync('telemetryRejectOversizedMs', () => serializeTelemetryValue(oversized, 128 * 1024));
    sync('telemetryMaskHeadersMs', () => captureProviderHeaders(headers));
    sync('telemetryRedactMs', () => redactTelemetryValue(redactionConfig, privateRequest), 10);
    sync('telemetryTruncate1MiBMs', () => truncateAttributePayload(multibyte), 10);

    function exporterFixture() {
      const sink = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(sink)] });
      const exporter = new OtelRuntimeEventExporter(
        {
          enabled: true,
          endpoint: '',
          includePayloads: true,
          flushAt: 100,
          flushIntervalMs: 60_000,
        },
        { provider },
      );
      return { exporter, sink };
    }
    let counter = 0;
    const event = () => ({
      id: `event-${counter++}`,
      traceId: '11111111111111111111111111111111',
      type: 'chat_turn_completed',
      sessionId: 'performance',
      createdAt: new Date().toISOString(),
      details: { input: 'Performance fixture' },
    });
    const active = exporterFixture();
    try {
      await asyncTime(
        'telemetryPublish100EventsMs',
        async () => {
          active.sink.reset();
          await Promise.all(Array.from({ length: 100 }, () => active.exporter.publish(event())));
          await active.exporter.flush();
          assert.equal(active.sink.getFinishedSpans().length, 100);
        },
        1,
      );
    } finally {
      await active.exporter.close();
    }
    const lifecycle = async () => {
      const { exporter, sink } = exporterFixture();
      try {
        await exporter.publish(event());
        await exporter.flush();
        assert.equal(sink.getFinishedSpans().length, 1);
      } finally {
        await exporter.close();
      }
      assert.equal(exporter.getStatus().state, 'closed');
    };
    await asyncTime('telemetryLifecycleMs', lifecycle);
    assert.equal(typeof global.gc, 'function', 'Run the worker with --expose-gc');
    for (let i = 0; i < 10; i++) await lifecycle();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100; i++) await lifecycle();
    global.gc();
    result.telemetryRetainedHeapMiB =
      Math.max(0, process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    await measurePlugins({ root, load, sync, asyncTime, fixture, project, result });
    assert.deepEqual(Object.keys(result).sort(), Object.keys(metrics).sort());
    return result;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousAgentHome;
    await rm(fixture, { recursive: true, force: true });
  }
}
