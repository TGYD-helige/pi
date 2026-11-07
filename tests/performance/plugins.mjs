import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const extensions = [
  'pi-attachments',
  'pi-browser-use',
  'pi-channels',
  'pi-computer-use',
  'pi-dingtalk',
  'pi-goal',
  'pi-image-gen',
  'pi-lark',
  'pi-memory',
  'pi-memory-mem0',
  'pi-security',
  'pi-task-scheduler',
  'pi-teamwork',
  'pi-telemetry',
  'pi-video-gen',
  'pi-web-access',
  'pi-wecom',
];

const cases = [
  ['pi-attachments.render20FilesMs', 3],
  ['pi-attachments.directory200FilesMs', 5],
  ['pi-browser-use.snapshotConversionMs', 2],
  ['pi-computer-use.accessibility1000NodesMs', 3],
  ['pi-channels.renderTable100RowsMs', 1],
  ['pi-channels.routeAndDispatch100Ms', 3],
  ['pi-dingtalk.unconfiguredSessionMs', 1],
  ['pi-lark.unconfiguredSessionMs', 1],
  ['pi-wecom.unconfiguredSessionMs', 1],
  ['pi-goal.transcript1000MessagesMs', 1],
  ['pi-image-gen.read4LocalImagesMs', 3],
  ['pi-image-gen.bound10ResultsMs', 1],
  ['pi-memory-mem0.recall100MemoriesMs', 2],
  ['pi-memory-mem0.redact64KiBMs', 1],
  ['pi-security.evaluate100RulesMs', 1],
  ['pi-task-scheduler.load100TasksMs', 3],
  ['pi-task-scheduler.persistRoundtripMs', 3],
  ['pi-task-scheduler.scope100TasksMs', 1],
  ['pi-teamwork.map100IssuesMs', 1],
  ['pi-video-gen.validate100SegmentsMs', 1],
  ['pi-video-gen.hash4MiBMs', 3],
  ['pi-video-gen.persistManifestMs', 3],
  ['pi-web-access.bound100SearchResultsMs', 2],
  ['pi-web-access.bound1MiBPageMs', 2],
];

export const pluginMetrics = Object.fromEntries([
  ...extensions.map((name) => [`${name}.coldImportMs`, { plugin: name, unit: 'ms', slack: 50 }]),
  ...cases.map(([name, slack]) => [name, { plugin: name.split('.')[0], unit: 'ms', slack }]),
]);

export async function measurePlugins({ root, load, sync, asyncTime, fixture, project, result }) {
  const discovered = [];
  for (const item of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages', item.name, 'package.json'), 'utf8'),
    );
    if (manifest.pi?.extensions?.length) discovered.push(item.name);
  }
  assert.deepEqual(
    discovered.sort(),
    [...extensions].sort(),
    'Update performance coverage when adding or removing an extension',
  );
  for (const name of extensions) {
    const output = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./runtime.mjs', import.meta.url)),
        '--import',
        path.resolve(root, 'packages', name),
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    result[`${name}.coldImportMs`] = JSON.parse(output).durationMs;
  }

  const { renderAttachmentContext, renderAttachmentBlock } = await load(
    'pi-attachments/dist/classify.js',
  );
  const filesDir = path.join(fixture, 'attachments');
  await mkdir(filesDir);
  const text = 'Attachment performance fixture.\n'.repeat(1000);
  for (let i = 0; i < 220; i++)
    await writeFile(path.join(filesDir, `file-${String(i).padStart(3, '0')}.txt`), text);
  const files = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    name: 'fixture.txt',
    path: path.join(filesDir, `file-${String(i).padStart(3, '0')}.txt`),
  }));
  const rendered = await renderAttachmentContext(files, { maxTextChars: 8192 });
  assert.match(rendered, /Attachment performance fixture/);
  assert.match(rendered, /omitted/);
  await asyncTime(
    'pi-attachments.render20FilesMs',
    () => renderAttachmentContext(files, { maxTextChars: 8192 }),
    2,
  );
  const directory = { id: 'dir', name: 'fixtures', path: filesDir, mimeType: 'inode/directory' };
  assert.match(await renderAttachmentBlock(directory, 16_000), /showing 200 of 220/);
  await asyncTime(
    'pi-attachments.directory200FilesMs',
    () => renderAttachmentBlock(directory, 16_000),
    1,
  );

  const { toToolContent } = await load('pi-browser-use/dist/tool-result.js');
  const snapshot = {
    content: [
      {
        type: 'text',
        text: Array.from({ length: 1000 }, (_, i) => `uid=1_${i} button "Button ${i}"`).join('\n'),
      },
    ],
  };
  const browserResult = toToolContent(snapshot, 'take_snapshot');
  assert.match(browserResult.content[0].text, /Button 0/);
  assert.ok(Buffer.byteLength(JSON.stringify(browserResult)) <= 50 * 1024);
  sync('pi-browser-use.snapshotConversionMs', () => toToolContent(snapshot, 'take_snapshot'), 10);
  const { toPiToolResult } = await load('pi-computer-use/dist/tool-result.js');
  const window = {
    content: [{ type: 'text', text: 'Window fixture' }],
    structuredContent: {
      tree_markdown: 'UI node\n'.repeat(10_000),
      elements: Array.from({ length: 1000 }, (_, i) => ({
        element_index: i,
        element_token: `node-${i}`,
        name: `Button ${i}`,
        role: 'button',
      })),
    },
  };
  const computerResult = toPiToolResult(window, 'get_window_state');
  assert.equal(computerResult.details.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(computerResult)) <= 50 * 1024);
  sync(
    'pi-computer-use.accessibility1000NodesMs',
    () => toPiToolResult(window, 'get_window_state'),
    5,
  );

  const { renderFeishuPlainText, buildFeishuPost } = await load(
    'pi-channels/dist/adapters/feishu-render.js',
  );
  const table =
    '| Name | Value |\n| --- | --- |\n' +
    Array.from({ length: 100 }, (_, i) => `| Row ${i} | ${i} |`).join('\n');
  assert.match(renderFeishuPlainText(table), /Row 99/);
  assert.match(JSON.stringify(buildFeishuPost(table)), /Row 99/);
  sync('pi-channels.renderTable100RowsMs', () => [
    renderFeishuPlainText(table),
    buildFeishuPost(table),
  ]);
  const { ChannelRegistry } = await load('pi-channels/dist/registry.js');
  const registry = new ChannelRegistry();
  let sent = 0;
  registry.register('fixture', {
    direction: 'outgoing',
    send: async (message) => {
      assert.equal(message.recipient, 'fixture-recipient');
      sent++;
    },
  });
  registry.loadRoutes({
    routes: { fixture: { adapter: 'fixture', recipient: 'fixture-recipient' } },
  });
  try {
    await asyncTime(
      'pi-channels.routeAndDispatch100Ms',
      async () => {
        const before = sent;
        const responses = await Promise.all(
          Array.from({ length: 100 }, () =>
            registry.send({ adapter: 'fixture', recipient: '', text: 'fixture' }),
          ),
        );
        assert.ok(responses.every((response) => response.ok));
        assert.equal(sent - before, 100);
      },
      1,
    );
  } finally {
    await registry.stopAll();
  }

  // Explicit empty project credentials keep CLI auto-install/login unreachable.
  const settingsPath = path.join(project, '.pi/settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings['pi-dingtalk'] = { clientId: '', clientSecret: '' };
  settings['pi-lark'] = { appId: '', appSecret: '' };
  settings['pi-wecom'] = { botId: '', botSecret: '' };
  await writeFile(settingsPath, JSON.stringify(settings));
  for (const name of ['pi-dingtalk', 'pi-lark', 'pi-wecom']) {
    const { default: extension } = await load(`${name}/dist/index.js`);
    const handlers = new Map();
    extension({ on: (event, handler) => handlers.set(event, handler) });
    const ctx = {
      cwd: project,
      isProjectTrusted: () => true,
      ui: {
        notify() {
          assert.fail('Unconfigured CLI must not initialize');
        },
      },
    };
    await asyncTime(`${name}.unconfiguredSessionMs`, async () => {
      await handlers.get('session_start')({}, ctx);
      assert.deepEqual(handlers.get('resources_discover')(), {});
      await handlers.get('session_shutdown')({}, ctx);
    });
  }

  const { buildTranscriptWithMeta } = await load('pi-goal/dist/transcript.js');
  const messages = Array.from({ length: 1000 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Message ${i}: ${'context '.repeat(100)}`,
  }));
  const transcript = buildTranscriptWithMeta(messages, 16_000);
  assert.ok(transcript.text.length <= 16_000 && transcript.omitted > 0);
  assert.match(transcript.text, /Message 999/);
  sync('pi-goal.transcript1000MessagesMs', () => buildTranscriptWithMeta(messages, 16_000), 10);

  const { resolveImageInputs } = await load('pi-image-gen/dist/image-input.js');
  const { imageOutput } = await load('pi-image-gen/dist/tool-output.js');
  const sharp = createRequire(path.resolve(root, 'packages/pi-video-gen/package.json'))('sharp');
  // Seed-independent noise has a stable size and resists PNG compression.
  const png = await sharp(randomBytes(1024 * 768 * 3), {
    raw: { width: 1024, height: 768, channels: 3 },
  })
    .png()
    .toBuffer();
  const imagePath = path.join(fixture, 'image.png');
  await writeFile(imagePath, png);
  const noFetch = () => {
    throw new Error('Offline image fixture must not fetch');
  };
  const images = await resolveImageInputs(Array(4).fill(imagePath), fixture, noFetch);
  assert.equal(images.length, 4);
  assert.ok(
    images.every((image) => image.mimeType === 'image/png' && Buffer.from(image.bytes).equals(png)),
  );
  await asyncTime('pi-image-gen.read4LocalImagesMs', () =>
    resolveImageInputs(Array(4).fill(imagePath), fixture, noFetch),
  );
  const output = {
    model: 'fixture',
    provider: 'fixture',
    images: Array.from({ length: 10 }, () => ({
      path: imagePath,
      mimeType: 'image/png',
      revisedPrompt: 'image '.repeat(20_000),
    })),
  };
  const boundedImages = imageOutput(output);
  assert.equal(boundedImages.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(boundedImages)) <= 6 * 1024);
  sync('pi-image-gen.bound10ResultsMs', () => imageOutput(output), 10);

  const { Prefetch } = await load('pi-memory-mem0/dist/prefetch.js');
  const { redactMemoryText } = await load('pi-memory-mem0/dist/privacy.js');
  const memories = Array.from({ length: 100 }, (_, i) => ({
    id: `memory-${i}`,
    memory: `Fact ${i}: ${'safe context '.repeat(100)}`,
    created_at: '2026-01-01T00:00:00Z',
  }));
  let searches = 0;
  const prefetch = new Prefetch(
    {
      supportsSearchCancellation: true,
      search: async () => {
        searches++;
        return memories;
      },
    },
    'fixture',
    { topK: 100 },
  );
  await asyncTime('pi-memory-mem0.recall100MemoriesMs', async () => {
    const before = searches;
    assert.equal(prefetch.queue('fixture'), true);
    const recall = await prefetch.consume();
    assert.equal(searches - before, 1);
    assert.ok(prefetch.didComplete && !prefetch.hasPending);
    assert.match(recall, /UNTRUSTED MEMORY DATA/);
    assert.ok(Buffer.byteLength(recall) <= 8 * 1024);
  });
  prefetch.cancel();
  const sensitiveText = 'Context token=fixture-secret-value\n'.repeat(2000);
  assert.ok(!redactMemoryText(sensitiveText).includes('fixture-secret-value'));
  sync('pi-memory-mem0.redact64KiBMs', () => redactMemoryText(sensitiveText), 10);

  const { SecurityPolicyEngine } = await load('pi-security/dist/index.js');
  const engine = new SecurityPolicyEngine({
    rules: Array.from({ length: 100 }, (_, i) => ({
      id: `rule-${i}`,
      tools: [i === 99 ? 'write' : `tool-${i}`],
      decision: { kind: i === 99 ? 'deny' : 'allow', reason: 'Fixture policy' },
    })),
  });
  const sourcePath = path.join(project, 'fixture.ts');
  await writeFile(sourcePath, 'export const fixture = 1;');
  const input = {
    request: {
      sessionId: 'fixture',
      conversationId: 'fixture',
      trigger: 'user',
      senderTrust: 'owner',
      interactive: true,
    },
    workspaceDir: project,
    toolCall: {
      id: 'fixture',
      name: 'write',
      source: 'builtin',
      args: { path: sourcePath, content: 'fixture' },
    },
  };
  assert.equal(engine.evaluate(input).decision.kind, 'deny');
  assert.deepEqual(engine.evaluate(input).matchedRuleIds, ['rule-99']);
  assert.equal(engine.evaluate(input).resources[0].scope, 'workspace');
  sync('pi-security.evaluate100RulesMs', () => engine.evaluate(input));

  const { JsonScheduledTaskStore } = await load('pi-task-scheduler/dist/stores.js');
  const tasks = Array.from({ length: 100 }, (_, i) => ({
    id: `task-${i}`,
    sessionId: i % 2 ? 'other' : 'fixture',
    prompt: 'Fixture',
    type: 'interval',
    schedule: '10m',
    intervalSeconds: 600,
    enabled: true,
    model: { provider: 'fixture', model: 'fixture' },
    toolPolicyProfile: 'default',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    runCount: 0,
  }));
  const taskFile = path.join(fixture, 'tasks.json');
  await writeFile(taskFile, JSON.stringify(tasks));
  await asyncTime('pi-task-scheduler.load100TasksMs', async () => {
    assert.equal((await new JsonScheduledTaskStore(taskFile).list()).length, 100);
  });
  const taskStore = new JsonScheduledTaskStore(taskFile);
  assert.equal((await taskStore.list({ sessionId: 'fixture' })).length, 50);
  await asyncTime('pi-task-scheduler.scope100TasksMs', () =>
    taskStore.list({ sessionId: 'fixture' }),
  );
  await asyncTime(
    'pi-task-scheduler.persistRoundtripMs',
    async () => {
      await taskStore.create({ ...tasks[0], id: 'temporary' });
      assert.equal(await taskStore.delete('temporary', { sessionId: 'other' }), false);
      assert.equal(await taskStore.delete('temporary', { sessionId: 'fixture' }), true);
    },
    2,
  );
  assert.equal((await new JsonScheduledTaskStore(taskFile).list()).length, 100);

  const { MulticaAdapter } = await load('pi-teamwork/dist/adapters/multica.js');
  const issueJson = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({
      id: `issue-${i}`,
      title: `Issue ${i}`,
      status: 'open',
    })),
  );
  let executions = 0;
  const teamwork = new MulticaAdapter({}, async (_binary, args) => {
    assert.deepEqual(args.slice(0, 2), ['issue', 'list']);
    executions++;
    return { stdout: issueJson, stderr: '', code: 0 };
  });
  await asyncTime('pi-teamwork.map100IssuesMs', async () => {
    const before = executions;
    const issues = await teamwork.listIssues({ limit: 100 });
    assert.equal(executions - before, 1);
    assert.equal(issues.length, 100);
    assert.equal(issues[99].id, 'issue-99');
  });

  const { parseTimelineSpec } = await load('pi-video-gen/dist/timeline.js');
  const { hashFileSha256, writeJsonAtomic, readJsonFile } = await load(
    'pi-video-gen/dist/jobs/store.js',
  );
  const timeline = JSON.stringify({
    title: 'Fixture',
    segments: Array.from({ length: 100 }, (_, i) => ({
      id: `shot-${i}`,
      image: imagePath,
      durationSec: 3,
    })),
  });
  assert.equal(parseTimelineSpec(timeline).segments.length, 100);
  assert.throws(() => parseTimelineSpec('{"segments":[]}'));
  sync('pi-video-gen.validate100SegmentsMs', () => parseTimelineSpec(timeline), 10);
  const media = path.join(fixture, 'media.bin');
  await writeFile(media, Buffer.alloc(4 * 1024 * 1024, 42));
  const { createHash } = await import('node:crypto');
  const expectedHash = createHash('sha256')
    .update(Buffer.alloc(4 * 1024 * 1024, 42))
    .digest('hex');
  assert.equal(await hashFileSha256(media), expectedHash);
  await asyncTime('pi-video-gen.hash4MiBMs', () => hashFileSha256(media), 2);
  const manifest = path.join(fixture, 'video-manifest.json');
  const manifestData = {
    jobId: 'fixture',
    kind: 'render',
    shots: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `shot-${i}`,
        { state: 'done', videoPath: `/fixture/${i}.mp4` },
      ]),
    ),
  };
  sync(
    'pi-video-gen.persistManifestMs',
    () => {
      writeJsonAtomic(manifest, manifestData);
      assert.deepEqual(readJsonFile(manifest), manifestData);
    },
    5,
  );

  const { searchOutput, fetchOutput } = await load('pi-web-access/dist/tool-output.js');
  const response = {
    provider: 'fixture',
    query: 'fixture',
    results: Array.from({ length: 100 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: 'result '.repeat(2000),
    })),
  };
  const search = searchOutput(response);
  assert.ok(search.truncated && search.results.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(search)) <= 16 * 1024);
  sync('pi-web-access.bound100SearchResultsMs', () => searchOutput(response), 5);
  const page = {
    url: 'https://example.com',
    title: 'Fixture',
    content: 'page content '.repeat(85_000),
  };
  const fetched = fetchOutput(page);
  assert.equal(fetched.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(fetched)) <= 16 * 1024);
  sync('pi-web-access.bound1MiBPageMs', () => fetchOutput(page), 5);
}
