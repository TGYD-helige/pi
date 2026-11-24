import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'resolved_failure',
    label: 'Resolved failure',
    description: 'Resolve with an error result.',
    parameters: Type.Object({}),
    async execute() {
      return { isError: true, content: [{ type: 'text', text: 'SAFE-RESOLVED' }], details: {} };
    },
  });
  pi.registerTool({
    name: 'thrown_failure',
    label: 'Thrown failure',
    description: 'Throw a sanitized error.',
    parameters: Type.Object({}),
    async execute() {
      throw new Error('SAFE-THROWN');
    },
  });
  pi.registerProvider('rpc-fixture', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture-placeholder',
    api: 'rpc-fixture-api',
    models: [
      {
        id: 'scripted',
        name: 'Scripted',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const afterTools = context.messages.some((message) => message.role === 'toolResult');
      const stopReason = afterTools ? 'stop' : 'toolUse';
      const output: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: afterTools
          ? [{ type: 'text', text: 'FIXTURE-DONE' }]
          : [
              { type: 'toolCall', id: 'call-resolved', name: 'resolved_failure', arguments: {} },
              { type: 'toolCall', id: 'call-thrown', name: 'thrown_failure', arguments: {} },
            ],
      };
      stream.push({ type: 'done', reason: stopReason, message: output });
      stream.end();
      return stream;
    },
  });
}
