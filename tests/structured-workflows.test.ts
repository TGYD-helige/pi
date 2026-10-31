import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import imageExtension from '../packages/pi-image-gen/src/index.js';
import videoExtension from '../packages/pi-video-gen/src/index.js';
import { MemoryStore } from '../packages/pi-memory/src/store.js';
import { createMemoryTools } from '../packages/pi-memory/src/tools.js';
import { createMem0MemoryTool } from '../packages/pi-memory-mem0/src/tools.js';
import { PersistentTaskScheduler } from '../packages/pi-task-scheduler/src/index.js';
import { FileSchedulerLock, JsonScheduledTaskStore } from '../packages/pi-task-scheduler/src/stores.js';
import { createSchedulerTools } from '../packages/pi-task-scheduler/src/tools.js';
import teamworkExtension from '../packages/pi-teamwork/src/index.js';

const requireVideo = createRequire(new URL('../packages/pi-video-gen/package.json', import.meta.url));
const sharp = requireVideo('sharp');
const { Value } = requireVideo('typebox/value');

// Fixed provider output exercises the real image tool and local compositor without paid calls.
vi.mock('../packages/pi-image-gen/src/generate.js', () => ({
  generateImage: async (_params: unknown, { cwd }: { cwd: string }) => {
    const path = join(cwd, 'fixture.png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#2077aa' } }).png().toFile(path);
    return { model: 'fixture', provider: 'fixture', images: [{ path, mimeType: 'image/png' }] };
  },
}));

vi.mock('../packages/pi-teamwork/src/adapters/multica.js', () => ({
  initMulticaProvider: async () => {
    let issue = { id: 'ISS-1', title: 'fixture', status: 'todo' };
    return {
      installResult: { installed: true },
      adapter: {
        withExecution() { return this; },
        name: 'fixture', listIssues: async () => [issue],
        updateIssue: async (id: string, update: object) => id === issue.id ? (issue = { ...issue, ...update }) : undefined,
      },
    };
  },
}));

describe('structured codemode workflows', () => {
  it.each(['on', 'only'] as const)('chains records and image/video artifacts in real Pi codemode %s', async (mode) => {
    const sdk = await import('../packages/pi-video-gen/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const cwd = await mkdtemp(join(tmpdir(), 'pi-structured-workflows-'));
    vi.stubEnv('HOME', cwd);
    vi.stubEnv('USERPROFILE', cwd);
    expect(homedir()).toBe(cwd);
    const fetchMock = vi.fn(() => { throw new Error('Network calls are forbidden in the local fixture'); });
    vi.stubGlobal('fetch', fetchMock);
    const agentDir = join(cwd, 'agent');
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ 'pi-video-gen': {} }));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    vi.stubEnv('PI_AGENT_HOME', agentDir);
    const store = new MemoryStore({ dir: join(cwd, 'memory') });
    await store.loadFromDisk();
    const scheduler = new PersistentTaskScheduler({
      store: new JsonScheduledTaskStore(join(cwd, 'tasks.json')),
      lock: new FileSchedulerLock(join(cwd, 'scheduler.lock')),
      runner: async () => {},
    });
    const schemas = new Map<string, unknown>();
    const schemaErrors: string[] = [];
    const loader = new sdk.DefaultResourceLoader({
      cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        sdk.createCodemodeExtension({ models: false, mode }),
        (pi) => {
          const api = { ...pi, registerTool: (tool: Parameters<typeof pi.registerTool>[0]) => {
            schemas.set(tool.name, tool.outputSchema); pi.registerTool(tool);
          } };
          imageExtension(api); videoExtension(api); teamworkExtension(api);
          pi.on('tool_result', (event) => {
            const schema = schemas.get(event.toolName);
            if (schema && !Value.Check(schema, event.structuredContent)) schemaErrors.push(event.toolName);
          });
          for (const tool of [...createMemoryTools(store), ...createSchedulerTools(scheduler)]) api.registerTool(tool);
          api.registerTool(createMem0MemoryTool({
            getProvider: () => ({ search: async () => [{ id: 'm1', memory: 'uses TypeScript' }], delete: async () => {} }) as never,
            getUserId: () => 'fixture', getAgentId: () => undefined, isEnabled: () => true,
          }));
        },
      ],
    });
    let session: Awaited<ReturnType<typeof sdk.createAgentSession>>['session'] | undefined;
    try {
      await loader.reload();
      ({ session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader,
        settingsManager: sdk.SettingsManager.inMemory({ defaultTools: ['+codemode'] }),
        sessionManager: sdk.SessionManager.inMemory(cwd),
      }));
      await session.bindExtensions({});
      const code = `
        await tools.memory_add({target: 'memory', content: 'project uses TypeScript'});
        const memory = await tools.memory_read({target: 'memory'});
        const entry = memory.entries.find(e => e.includes('TypeScript'));
        const changed = await tools.memory_replace({target: 'memory', oldText: entry, newContent: 'project uses strict TypeScript'});
        const recalled = await tools.mem0_memory({action: 'search', query: 'language'});
        const removed = await tools.mem0_memory({action: 'delete', memory_id: recalled.memories[0].id});
        const issues = await tools.issue_list({});
        const issue = await tools.issue_update({id: issues.issues.find(i => i.status === 'todo').id, status: 'done'});
        const prompt = 'Keep all task context. '.repeat(12);
        const created = await tools.scheduler_create({type: 'interval', schedule: '1h', prompt, enabled: false});
        const tasks = await tools.scheduler_list({});
        const task = tasks.tasks.find(t => t.id === created.task.id);
        if (task.prompt !== prompt) throw new Error('task prompt was clipped');
        const updated = await tools.scheduler_update({taskId: task.id, name: 'updated fixture'});
        const large = await tools.scheduler_create({type: 'interval', schedule: '1h', prompt: 'x'.repeat(13000), enabled: false});
        if (large.error || !large.task.id || !large.task.truncated || 'prompt' in large.task) throw new Error('large task lost recovery metadata');
        const largeList = await tools.scheduler_list({});
        if (!largeList.tasks.some(t => t.id === large.task.id)) throw new Error('large task missing from list');
        await tools.scheduler_delete({taskId: large.task.id});
        const image = await tools.image_generate({prompt: 'fixture'});
        const specPath = '.video-gen/fixture/timeline-input.json';
        await tools.write({path: specPath, content: JSON.stringify({output: {resolution: '640x360', fps: 25}, segments: [{id: 's1', image: image.images[0].path, durationSec: 1, motion: 'static'}]})});
        const video = await tools.video_compose({composeSpecPath: specPath});
        if (video.error) throw new Error(video.error);
        await tools.write({path: '.video-gen/renderfixture/render-input.json', content: JSON.stringify({shots: [{id: 'local', videoPath: video.finalVideoPath}]})});
        const rendered = await tools.video_render({renderSpecPath: '.video-gen/renderfixture/render-input.json'});
        if (rendered.error) throw new Error(rendered.error);
        text({memory: changed.entries[0], deletedId: removed.deletedId, issueStatus: issue.issue.status,
          taskName: updated.task.name, videoPath: video.finalVideoPath, state: video.state,
          qcStatus: video.qcStatus, qcFrame: video.qcFrames[0], qcReport: rendered.qcReportPath});
      `;
      session.agent.state.messages.push({
        role: 'assistant', content: [{ type: 'toolCall', id: 'fixture-call', name: 'codemode', arguments: { code } }],
        api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      const codemode = session.agent.state.tools.find(tool => tool.name === 'codemode')!;
      const result = await codemode.execute('fixture-call', { code });
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      expect(text).toContain('project uses strict TypeScript');
      expect(text).toContain('updated fixture');
      expect(text).toContain('"deletedId":"m1"');
      expect(text).toContain('"issueStatus":"done"');
      expect(text).toContain('"state":"done"');
      expect(text).toContain('"qcStatus":"recorded"');
      expect(schemaErrors).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      const output = JSON.parse(text.slice(text.indexOf('{')));
      expect((await readFile(output.videoPath)).byteLength).toBeGreaterThan(0);
      expect((await readFile(output.qcFrame)).byteLength).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(output.qcReport, 'utf8'))).toHaveProperty('final');
    } finally {
      session?.dispose(); await scheduler.stop(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
