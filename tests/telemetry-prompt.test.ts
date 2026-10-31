import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import telemetryExtension from '../packages/pi-telemetry/src/extension.js';

const { holder } = vi.hoisted(() => ({ holder: { spans: [] as any[], includePayloads: true } }));
vi.mock('../packages/pi-telemetry/src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packages/pi-telemetry/src/config.js')>()),
  loadConfigFromFile: () => ({ includePayloads: holder.includePayloads }),
}));
vi.mock('../packages/pi-telemetry/src/otel.js', async () => {
  const { OtelRuntimeEventExporter } = await import(
    '../packages/pi-telemetry/src/langfuse/exporters.js'
  );
  const requireTelemetry = createRequire(
    new URL('../packages/pi-telemetry/package.json', import.meta.url),
  );
  const { BasicTracerProvider, SimpleSpanProcessor } = requireTelemetry(
    '@opentelemetry/sdk-trace-base',
  );
  return {
    createTelemetryExporter: () =>
      new OtelRuntimeEventExporter(
        {
          enabled: true,
          endpoint: '',
          includePayloads: holder.includePayloads,
          flushAt: 10,
          flushIntervalMs: 60_000,
        },
        {
          provider: new BasicTracerProvider({
            spanProcessors: [
              new SimpleSpanProcessor({
                export: (spans: any[], callback: (result: { code: number }) => void) => {
                  holder.spans.push(...spans);
                  callback({ code: 0 });
                },
                shutdown: async () => {},
              }),
            ],
          }),
        },
      ),
  };
});

describe('telemetry final prompt', () => {
  it.each([true, false])('preserves real Pi request and stream contracts with includePayloads=%s', async (includePayloads) => {
    holder.includePayloads = includePayloads;
    const sdk = await import(
      '../packages/pi-telemetry/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    );
    const cwd = await mkdtemp(join(tmpdir(), 'pi-telemetry-prompt-'));
    const requests: any[] = [];
    holder.spans = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        [
          {
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    let session: Awaited<ReturnType<typeof sdk.createAgentSession>>['session'] | undefined;
    try {
      const runtime = await sdk.ModelRuntime.create({
        authPath: join(cwd, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      });
      runtime.registerProvider('local-fixture', {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey: 'fixture',
        models: [
          {
            id: 'fixture',
            name: 'Fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 100_000,
            maxTokens: 100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: 'Base instructions',
        extensionFactories: [
          telemetryExtension,
          (pi) => {
            pi.on('before_agent_start', (event) => ({
              systemPrompt: `${event.systemPrompt}\nAPPENDED_BY_REAL_EXTENSION`,
            }));
          },
        ],
      });
      await loader.reload();
      ({ session } = await sdk.createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        model: runtime.getModel('local-fixture', 'fixture')!,
        resourceLoader: loader,
        noTools: 'all',
        settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }),
        sessionManager: sdk.SessionManager.inMemory(cwd),
      }));
      await session.bindExtensions({});
      await session.prompt('question');
      expect(requests).toHaveLength(1);
      const generation = holder.spans.find(
        (span) => span.attributes['langfuse.observation.type'] === 'generation',
      );
      const stream = holder.spans.find((span) => span.name === 'llm-stream');
      expect(generation).toBeDefined();
      expect(JSON.stringify(requests[0].messages)).toContain('APPENDED_BY_REAL_EXTENSION');
      expect(holder.spans.filter((span) => span.name === 'llm-stream')).toHaveLength(1);
      if (includePayloads) {
        expect(JSON.parse(generation.attributes['langfuse.observation.input'])).toEqual(requests[0].messages);
        expect(JSON.parse(stream.attributes['langfuse.observation.input'])).toEqual(requests[0]);
        expect(JSON.parse(generation.attributes['langfuse.observation.metadata.rawInput'])).toEqual(requests[0]);
      } else {
        expect(generation.attributes['langfuse.observation.input']).toBeUndefined();
        expect(generation.attributes['langfuse.observation.metadata.rawInput']).toBeUndefined();
        expect(stream.attributes['langfuse.observation.input']).toBeUndefined();
        expect(JSON.parse(stream.attributes['langfuse.observation.output'])).toEqual([]);
      }
      expect(stream.parentSpanContext.spanId).toBe(generation.spanContext().spanId);
    } finally {
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
      delete process.env.PI_TELEMETRY_TRACEPARENT;
    }
  }, 20_000);
});
