import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensions } from './plugins.mjs';

export const sessionMetrics = Object.fromEntries(
  [
    ['cliEmptyReadyMs', 50],
    ['cliMemoryReadyMs', 50],
    ['cliCommonReadyMs', 50],
    ['hooksEmpty1000Ms', 1],
    ['hooksMemory1000Ms', 1],
    ['hooksCommon1000Ms', 1],
    ['hooksCommon10000Ms', 3],
    ['concurrentHooks4BatchMs', 3],
    ['concurrentHooks4P95Ms', 3],
    ['concurrentHooks4P99Ms', 5],
    ['cancel32PrefetchMs', 2],
    ['uncancellableSingleFlightMs', 1],
    ['captureDrain16Ms', 3],
    ['sessionLifecycle500Ms', 50],
  ]
    .map(([name, slack]) => [name, { unit: 'ms', slack }])
    .concat([
      ['sessionRetainedHeapMiB', { unit: 'MiB', slack: 8 }],
      ['sessionRssGrowthMiB', { unit: 'MiB', slack: 16 }],
      ['sessionFdGrowth', { unit: 'count', slack: 1 }],
      ['sessionActiveResourceGrowth', { unit: 'count', slack: 1 }],
      ['sessionChildGrowth', { unit: 'count', slack: 0 }],
    ]),
);

export const profileMetrics = Object.fromEntries(
  [...extensions, 'all'].flatMap((name) =>
    ['startupMs', 'hooks1000Ms', 'shutdownMs'].map((metric) => [
      `profile.${name}.${metric}`,
      { unit: 'ms', slack: metric === 'startupMs' ? 20 : 0.2 },
    ]),
  ),
);

export const soakMetrics = Object.fromEntries(
  [
    ['soakCycleMedianMs', 3],
    ['soakCycleP95Ms', 5],
    ['soakCycleP99Ms', 10],
  ]
    .map(([name, slack]) => [name, { unit: 'ms', slack }])
    .concat([
      ['soakHeapGrowthMiB', { unit: 'MiB', slack: 16 }],
      ['soakRssGrowthMiB', { unit: 'MiB', slack: 32 }],
      ['soakFdGrowth', { unit: 'count', slack: 1 }],
      ['soakActiveResourceGrowth', { unit: 'count', slack: 1 }],
      ['soakChildGrowth', { unit: 'count', slack: 0 }],
    ]),
);

const common = ['pi-memory', 'pi-attachments', 'pi-security', 'pi-goal', 'pi-telemetry'];
export const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

async function cliReady(root, fixture, names) {
  const sdkRoot = path.join(
    root,
    'packages/pi-memory/node_modules/@earendil-works/pi-coding-agent',
  );
  const args = [
    '--import',
    fileURLToPath(new URL('./no-network.mjs', import.meta.url)),
    path.join(sdkRoot, 'dist/cli.js'),
    '--mode',
    'rpc',
    '--no-session',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
  ];
  for (const name of names) {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8'),
    );
    for (const entry of manifest.pi.extensions)
      args.push('-e', path.join(root, 'packages', name, entry));
  }
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: fixture,
    env: { ...process.env, PI_AGENT_HOME: fixture, PI_CODING_AGENT_DIR: fixture, PI_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  let bytes = 0;
  let pending = '';
  let duration;
  let failure;
  const timer = setTimeout(() => {
    failure = 'CLI startup/shutdown exceeded 20 seconds';
    child.kill('SIGKILL');
  }, 20_000);
  const stop = (message) => {
    failure = message;
    child.kill('SIGKILL');
  };
  child.stderr.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) stop('CLI diagnostics exceeded limit');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2 * 1024 * 1024) return stop('CLI output exceeded limit');
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.id === 'performance-ready') {
        if (event.success !== true) return stop('CLI readiness failed');
        duration = performance.now() - started;
        child.stdin.end();
      }
    }
  });
  child.stdin.on('error', () => {
    failure ??= 'CLI stdin closed before readiness';
  });
  child.stdin.write(`${JSON.stringify({ id: 'performance-ready', type: 'get_state' })}\n`);
  try {
    const exit = await closed;
    assert.ok(!failure, failure);
    assert.equal(exit.code, 0);
    assert.ok(duration > 0);
    return duration;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

export async function measureSessions(
  root,
  { profiles = false, soakMinutes = 0, progressPath } = {},
) {
  root = path.resolve(root);
  assert.equal(typeof global.gc, 'function', 'Run performance workers with --expose-gc');
  const fixture = await mkdtemp(path.join(tmpdir(), 'pi-performance-sessions-'));
  const previous = {
    PI_AGENT_HOME: process.env.PI_AGENT_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_OFFLINE: process.env.PI_OFFLINE,
    PI_CHANNELS_DISABLE_SESSION_AUTOSTART: process.env.PI_CHANNELS_DISABLE_SESSION_AUTOSTART,
  };
  const open = new Set();
  const result = {};
  try {
    process.env.PI_AGENT_HOME = fixture;
    process.env.PI_CODING_AGENT_DIR = fixture;
    process.env.PI_OFFLINE = '1';
    const memoryDir = path.join(fixture, 'memories');
    await mkdir(memoryDir);
    await writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      'Performance lifecycle fixture uses TypeScript.',
    );
    await writeFile(
      path.join(fixture, 'settings.json'),
      JSON.stringify({
        cacheWarming: 'off',
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultProjectTrust: 'never',
        'pi-memory': { dataDir: memoryDir, extractionModel: null, dreaming: { enabled: false } },
        'pi-telemetry': {
          langfuse: { enabled: false },
          otel: { enabled: false },
          phoenix: { enabled: false },
        },
        'pi-goal': { model: null },
      }),
    );
    if (!profiles && !soakMinutes) {
      result.cliEmptyReadyMs = await cliReady(root, fixture, []);
      result.cliMemoryReadyMs = await cliReady(root, fixture, ['pi-memory']);
      result.cliCommonReadyMs = await cliReady(root, fixture, common);
    }
    let transportHits;
    const fixtureTransports = profiles || soakMinutes > 0;
    if (fixtureTransports) {
      delete process.env.PI_CHANNELS_DISABLE_SESSION_AUTOSTART;
      ({ transportHits } = await import('./transports.mjs'));
      const settingsPath = path.join(fixture, 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      Object.assign(settings, {
        'pi-browser-use': {
          sessionMode: 'isolated',
          userDataDir: path.join(fixture, 'chrome'),
          session: { enabled: false },
          toolProfile: 'full',
        },
        'pi-computer-use': { toolProfile: 'full' },
        'pi-security': { enabled: true, profile: 'default' },
        'pi-channels': { adapters: { fixture: { type: 'webhook' } }, bridge: { enabled: false } },
        'pi-dingtalk': { clientId: 'fixture', clientSecret: 'fixture' },
        'pi-lark': { appId: 'fixture', appSecret: 'fixture' },
        'pi-wecom': { botId: 'fixture', botSecret: 'fixture' },
        'pi-teamwork': {
          enabled: true,
          multica: {
            serverUrl: 'https://fixture.invalid',
            appUrl: 'https://fixture.invalid',
            token: 'fixture',
          },
        },
        'pi-memory-mem0': {
          mode: 'platform',
          apiKey: 'fixture',
          userId: 'fixture',
          userIdScope: 'exact',
          autoCapture: true,
          autoRecall: true,
          toolEnabled: true,
        },
        'pi-scheduler': { dataDir: path.join(fixture, 'scheduler') },
        'pi-web-access': { search: { provider: 'parallel' }, fetch: { provider: 'jina' } },
        'pi-telemetry': {
          includePayloads: true,
          otel: { enabled: true, endpoint: 'https://fixture.invalid' },
        },
      });
      await writeFile(settingsPath, JSON.stringify(settings));
    }
    const load = (relative) => import(pathToFileURL(path.join(root, 'packages', relative)).href);
    const sdk = await load('pi-memory/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const factories = new Map();
    for (const name of fixtureTransports ? extensions : common)
      factories.set(
        name,
        (
          await load(
            `${name}/dist/${['pi-security', 'pi-task-scheduler'].includes(name) ? 'extension' : 'index'}.js`,
          )
        ).default,
      );
    const errors = [];
    async function create(names) {
      const loader = new sdk.DefaultResourceLoader({
        cwd: fixture,
        agentDir: fixture,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: names.map((name) => factories.get(name)),
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await sdk.createAgentSession({
        cwd: fixture,
        agentDir: fixture,
        resourceLoader: loader,
        settingsManager: sdk.SettingsManager.inMemory({
          cacheWarming: 'off',
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        sessionManager: sdk.SessionManager.inMemory(fixture),
      });
      open.add(session);
      session.extensionRunner.onError((error) => errors.push(error.extensionPath));
      await session.bindExtensions({ mode: 'rpc' });
      if (names.includes('pi-memory'))
        assert.ok(session.getActiveToolNames().includes('memory_read'));
      assert.deepEqual(errors, []);
      return session;
    }
    async function close(session) {
      await session.abort();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
      session.dispose();
      open.delete(session);
      assert.deepEqual(errors, []);
    }
    const histories = new Map(
      [1000, 10000].map((count) => [
        count,
        Array.from({ length: count }, (_, i) => ({
          role: 'user',
          content: `Context ${i}: ${'fixture '.repeat(20)}`,
          timestamp: i,
        })),
      ]),
    );
    async function round(session, count = 1000) {
      const runner = session.extensionRunner;
      const input = await runner.emitInput('Performance fixture', undefined, 'rpc');
      assert.notEqual(input.action, 'handled');
      const before = await runner.emitBeforeAgentStart(
        { messageType: 'user', prompt: 'Performance fixture' },
        { cwd: fixture, selectedTools: session.getActiveToolNames() },
      );
      assert.ok(before.systemPromptOptions);
      if (session.getActiveToolNames().includes('memory_read')) {
        assert.match(before.systemPromptOptions.forceSystemPrompt, /Performance lifecycle fixture/);
      }
      await runner.emit({ type: 'agent_start' });
      await runner.emit({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
      const messages = await session.agent.transformContext(
        histories.get(count),
        new AbortController().signal,
      );
      assert.ok(messages.length >= count);
      assert.ok(
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.startsWith(`Context ${count - 1}:`),
        ),
      );
      const payload = {
        messages,
        tools: session.agent.state.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      };
      assert.ok(await runner.emitBeforeProviderRequest(payload));
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Static engineering fixture' }],
        timestamp: 0,
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture',
        stopReason: 'stop',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      await runner.emitMessageEnd({ type: 'message_end', message });
      await runner.emit({ type: 'turn_end', turnIndex: 0, message, toolResults: [] });
      await runner.emit({ type: 'agent_end', messages: [message] });
      await runner.emit({ type: 'agent_settled', aborted: false });
      assert.deepEqual(errors, []);
    }
    async function time(name, operation, iterations = 20) {
      for (let i = 0; i < 3; i++) await operation();
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const started = performance.now();
        await operation();
        samples.push(performance.now() - started);
      }
      result[name] = percentile(samples, 0.5);
      return samples;
    }
    if (profiles) {
      const expectedTools = {
        'pi-browser-use': 'browser_list_pages',
        'pi-computer-use': 'computer_use_health_report',
        'pi-memory-mem0': 'mem0_memory',
        'pi-image-gen': 'image_generate',
        'pi-task-scheduler': 'scheduler_list',
        'pi-channels': 'notify',
        'pi-teamwork': 'workspace_list',
      };
      for (const name of [...extensions, 'all']) {
        const names = name === 'all' ? extensions : [name];
        const started = performance.now();
        const session = await create(names);
        result[`profile.${name}.startupMs`] = performance.now() - started;
        const tools = session.agent.state.tools.map((tool) => tool.name);
        for (const plugin of names)
          if (expectedTools[plugin])
            assert.ok(tools.includes(expectedTools[plugin]), `Missing enabled tool: ${plugin}`);
        await time(`profile.${name}.hooks1000Ms`, () => round(session));
        const closing = performance.now();
        await close(session);
        result[`profile.${name}.shutdownMs`] = performance.now() - closing;
      }
      for (const key of [
        'browser.catalog',
        'mem0.init',
        'mem0.search',
        'dingtalk.init',
        'lark.init',
        'wecom.ready',
        'teamwork.init',
        'channels.adapter',
        'telemetry.export',
      ])
        assert.ok(transportHits[key] > 0, `Transport fixture did not execute: ${key}`);
      if (process.platform !== 'darwin') assert.ok(transportHits['computer.catalog'] > 0);
      assert.deepEqual(Object.keys(result).sort(), Object.keys(profileMetrics).sort());
      return { ...result, observations: { transportHits } };
    }
    if (soakMinutes) {
      assert.ok(Number.isFinite(soakMinutes) && soakMinutes > 0 && soakMinutes <= 120);
      for (let i = 0; i < 100; i++) {
        const session = await create(extensions);
        await round(session);
        await close(session);
      }
      const before = await resources();
      if (progressPath)
        await writeFile(progressPath, `${JSON.stringify({ phase: 'before', ...before })}\n`);
      const checkpoints = [];
      async function checkpoint() {
        const point = {
          cycle: cycles,
          elapsedMs: performance.now() - started,
          ...(await resources()),
        };
        checkpoints.push(point);
        if (progressPath) await appendFile(progressPath, `${JSON.stringify(point)}\n`);
      }
      const window = [];
      const started = performance.now();
      let cycles = 0;
      let nextSnapshot = Math.min(60_000, soakMinutes * 60_000);
      while (performance.now() - started < soakMinutes * 60_000) {
        const cycleStart = performance.now();
        const session = await create(extensions);
        await round(session);
        await close(session);
        window.push(performance.now() - cycleStart);
        if (window.length > 256) window.shift();
        cycles++;
        if (performance.now() - started >= nextSnapshot) {
          await checkpoint();
          nextSnapshot += 60_000;
        }
        await delay(100);
      }
      await checkpoint();
      const growth = (key) => Math.max(0, ...checkpoints.map((point) => point[key] - before[key]));
      const measured = {
        soakCycleMedianMs: percentile(window, 0.5),
        soakCycleP95Ms: percentile(window, 0.95),
        soakCycleP99Ms: percentile(window, 0.99),
        soakHeapGrowthMiB: growth('heapUsed') / 1024 / 1024,
        soakRssGrowthMiB: growth('rss') / 1024 / 1024,
        soakFdGrowth: growth('fds'),
        soakActiveResourceGrowth: growth('resources'),
        soakChildGrowth: growth('children'),
      };
      assert.equal(open.size, 0);
      assert.equal(measured.soakChildGrowth, 0);
      assert.ok(cycles > 0);
      return {
        ...measured,
        observations: {
          durationMinutes: soakMinutes,
          extensions,
          transportHits,
          elapsedMs: performance.now() - started,
          cycles,
          before,
          checkpoints,
          recentLatenciesMs: window,
        },
      };
    }
    for (const [label, names] of [
      ['Empty', []],
      ['Memory', ['pi-memory']],
      ['Common', common],
    ]) {
      const session = await create(names);
      await time(`hooks${label}1000Ms`, () => round(session));
      if (label === 'Common') await time('hooksCommon10000Ms', () => round(session, 10000));
      await close(session);
    }
    const sessions = await Promise.all(Array.from({ length: 4 }, () => create(common)));
    const latencies = [];
    try {
      await time(
        'concurrentHooks4BatchMs',
        () =>
          Promise.all(
            sessions.map(async (session) => {
              const started = performance.now();
              await round(session);
              latencies.push(performance.now() - started);
            }),
          ),
        30,
      );
      latencies.splice(0, 12);
      assert.equal(latencies.length, 120);
      result.concurrentHooks4P95Ms = percentile(latencies, 0.95);
      result.concurrentHooks4P99Ms = percentile(latencies, 0.99);
    } finally {
      for (const session of sessions) await close(session);
    }

    const { Prefetch } = await load('pi-memory-mem0/dist/prefetch.js');
    await time('cancel32PrefetchMs', async () => {
      let cancelled = 0;
      const calls = Array.from({ length: 32 }, () => {
        const prefetch = new Prefetch(
          {
            supportsSearchCancellation: true,
            search: (_query, { signal }) =>
              new Promise((_resolve, reject) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    cancelled++;
                    reject(signal.reason);
                  },
                  { once: true },
                ),
              ),
          },
          'fixture',
          { topK: 5 },
        );
        assert.equal(prefetch.queue('fixture'), true);
        const pending = prefetch.consume();
        prefetch.cancel();
        return pending.then((value) => {
          assert.equal(value, undefined);
          assert.equal(prefetch.hasPending, false);
        });
      });
      await Promise.all(calls);
      assert.equal(cancelled, 32);
    });
    await time('uncancellableSingleFlightMs', async () => {
      let finish;
      let calls = 0;
      const prefetch = new Prefetch(
        {
          supportsSearchCancellation: false,
          search: () => {
            calls++;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        },
        'fixture',
        { topK: 5 },
      );
      prefetch.queue('fixture');
      const pending = prefetch.consume();
      prefetch.cancel();
      await pending;
      assert.equal(prefetch.queue('blocked'), false);
      assert.equal(calls, 1);
      finish([]);
      await tick();
      assert.equal(prefetch.queue('recovered'), true);
      finish([]);
      await prefetch.consume();
    });
    const { CaptureQueue } = await load('pi-memory-mem0/dist/capture.js');
    await time(
      'captureDrain16Ms',
      async () => {
        let release;
        let calls = 0;
        let active = 0;
        let maximum = 0;
        let saved = [];
        const state = {};
        const queue = new CaptureQueue(
          {
            supportsObservationDates: true,
            add: async () => {
              calls++;
              maximum = Math.max(maximum, ++active);
              if (calls === 1)
                await new Promise((resolve) => {
                  release = resolve;
                });
              else await tick();
              active--;
              return { results: [] };
            },
          },
          { userId: 'fixture' },
          state,
          (value) => {
            saved = value;
          },
        );
        try {
          const turn = {
            observedAt: new Date().toISOString(),
            messages: [
              { role: 'user', content: 'fixture' },
              { role: 'assistant', content: 'fixture' },
            ],
          };
          for (let i = 0; i < 16; i++) assert.equal(queue.enqueue(turn), true);
          assert.equal(queue.enqueue(turn), false);
          assert.equal(saved.length, 16);
          release();
          const deadline = performance.now() + 2000;
          while (saved.length) {
            assert.ok(performance.now() < deadline, 'Capture drain exceeded deadline');
            await tick();
          }
          assert.equal(calls, 16);
          assert.equal(maximum, 1);
        } finally {
          queue.close();
          if (state.active) await state.active;
        }
      },
      5,
    );

    async function resources() {
      await delay(25);
      global.gc();
      const ps = spawnSync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(ps.status, 0);
      const children = ps.stdout
        .trim()
        .split('\n')
        .filter((line) => {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          return ppid === process.pid && pid !== ps.pid;
        }).length;
      return {
        ...process.memoryUsage(),
        fds: (await readdir(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')).length,
        resources: process.getActiveResourcesInfo().length,
        children,
      };
    }
    for (let i = 0; i < 10; i++) {
      const session = await create(common);
      await round(session);
      await close(session);
    }
    const before = await resources();
    const checkpoints = [];
    let lifecycleMs = 0;
    for (let i = 0; i < 500; i++) {
      const started = performance.now();
      const session = await create(common);
      await round(session);
      await close(session);
      lifecycleMs += performance.now() - started;
      if ((i + 1) % 100 === 0) checkpoints.push({ cycle: i + 1, ...(await resources()) });
    }
    result.sessionLifecycle500Ms = lifecycleMs;
    const growth = (key) => Math.max(0, ...checkpoints.map((point) => point[key] - before[key]));
    result.sessionRetainedHeapMiB = growth('heapUsed') / 1024 / 1024;
    result.sessionRssGrowthMiB = growth('rss') / 1024 / 1024;
    result.sessionFdGrowth = growth('fds');
    result.sessionActiveResourceGrowth = growth('resources');
    result.sessionChildGrowth = growth('children');
    assert.equal(open.size, 0);
    assert.equal(result.sessionChildGrowth, 0);
    assert.deepEqual(Object.keys(result).sort(), Object.keys(sessionMetrics).sort());
    return { ...result, observations: { before, checkpoints, concurrentLatenciesMs: latencies } };
  } finally {
    for (const session of open) {
      await session.abort();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
      session.dispose();
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}
