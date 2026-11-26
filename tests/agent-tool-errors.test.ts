import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type ToolResultMessage,
} from '../packages/pi-computer-use/node_modules/@earendil-works/pi-ai/dist/index.js';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '../packages/pi-channels/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { expect, it, vi } from 'vitest';
import channels from '../packages/pi-channels/src/index.js';

it('sends the same sanitized error to Pi events and the model on the next turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-agent-tool-errors-'));
  const agentDir = join(cwd, 'agent');
  vi.stubEnv('PI_AGENT_HOME', agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.stubEnv('PI_CHANNELS_DISABLE_SESSION_AUTOSTART', '');
  const fetch = vi.fn(() => {
    throw new Error('Unexpected network request');
  });
  vi.stubGlobal('fetch', fetch);
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;

  try {
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        'pi-channels': {
          adapters: { webhook: { type: 'webhook' } },
          routes: { fixture: { adapter: 'webhook', recipient: 'https://example.invalid/hook' } },
          bridge: { enabled: false },
        },
      }),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const secret = 'fixture-private-payload';
    const request = { action: 'send', adapter: 'fixture', payloadMode: 'raw', method: 'POST' };
    const observed = new Map<string, ToolResultMessage>();
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    runtime.registerProvider('tool-error-fixture', {
      api: 'tool-error-fixture',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'fixture',
      models: [
        {
          id: 'scripted',
          name: 'Scripted',
          reasoning: false,
          input: ['text'],
          contextWindow: 8192,
          maxTokens: 1024,
          cost,
        },
      ],
      streamSimple(model, context) {
        for (const message of context.messages) {
          if (message.role === 'toolResult') observed.set(message.toolCallId, message);
        }
        const stopReason = observed.size ? 'stop' : 'toolUse';
        const content: AssistantMessage['content'] = observed.size
          ? [{ type: 'text', text: 'Fixture complete.' }]
          : [
              { type: 'toolCall', id: 'missing-body', name: 'notify', arguments: request },
              {
                type: 'toolCall',
                id: 'invalid-json',
                name: 'notify',
                arguments: { ...request, json: secret },
              },
            ];
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: 'done',
          reason: stopReason,
          message: {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason,
            content,
            usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
          },
        });
        stream.end();
        return stream;
      },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [channels],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model: runtime.getModel('tool-error-fixture', 'scripted'),
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    }));
    await session.bindExtensions({ mode: 'rpc' });
    const finished = new Map<string, unknown>();
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') finished.set(event.toolCallId, event);
    });

    await session.prompt('Run the tool error fixtures.');
    for (const [id, code, message] of [
      [
        'missing-body',
        'invalid_request',
        'The request was rejected before sending. Set json for a webhook raw payload or use envelope mode.',
      ],
      [
        'invalid-json',
        'invalid_payload_json',
        'The request was rejected before sending. Provide valid JSON in the json field.',
      ],
    ]) {
      const content = [{ type: 'text', text: `[${code}] ${message}` }];
      expect(finished.get(id)).toMatchObject({
        isError: true,
        result: { content },
      });
      expect(finished.get(id)).toHaveProperty('result.structuredContent.error', { code, message });
      expect(observed.get(id)).toMatchObject({ isError: true, content });
    }
    expect(JSON.stringify([...finished.values(), ...observed.values()])).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    try {
      await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    } finally {
      session?.dispose();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(cwd, { recursive: true, force: true });
    }
  }
}, 15_000);
