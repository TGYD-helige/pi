import type { RuntimeEventExporter } from '../index.js';

export const phoenixTestContext = {
  traceId: '11111111111111111111111111111111',
  sessionId: 'session-1',
  conversationId: 'conversation-1',
};
export const phoenixTestModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };

export async function publishPromptTrace(
  exporter: RuntimeEventExporter,
  input = 'hello',
  toolError = 'command failed',
  traceId = phoenixTestContext.traceId,
): Promise<void> {
  const context = { ...phoenixTestContext, traceId };
  const model = phoenixTestModel;
  await exporter.publish({
    ...context,
    id: 'turn-start',
    type: 'chat_turn_started',
    createdAt: '2026-05-02T00:00:00.000Z',
    details: { input },
  });
  await exporter.publish({
    ...context,
    id: 'generation-1-start',
    llmGenerationId: 'generation-1',
    status: 'started',
    createdAt: '2026-05-02T00:00:00.100Z',
    model,
    input: { messages: ['hello'] },
    displayInput: [{ role: 'user', content: 'hello' }],
  });
  await exporter.publish({
    ...context,
    id: 'generation-1-end',
    llmGenerationId: 'generation-1',
    status: 'completed',
    createdAt: '2026-05-02T00:00:00.500Z',
    model,
    displayOutput: [{ role: 'assistant', content: 'Use the tool' }],
    completionStartTime: '2026-05-02T00:00:00.300Z',
    usage: {
      input: 100,
      output: 40,
      reasoning: 10,
      cacheRead: 20,
      cacheWrite: 30,
      totalTokens: 190,
      costSource: 'provided',
      cost: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0.3, total: 5.5 },
    },
  });
  await exporter.publish({
    ...context,
    id: 'tool-start',
    toolCallId: 'call-1',
    toolName: 'bash',
    status: 'started',
    createdAt: '2026-05-02T00:00:00.600Z',
    args: { command: 'echo hi' },
  });
  await exporter.publish({
    ...context,
    id: 'tool-end',
    toolCallId: 'call-1',
    toolName: 'bash',
    status: 'failed',
    createdAt: '2026-05-02T00:00:00.700Z',
    error: toolError,
  });
  await exporter.publish({
    ...context,
    id: 'generation-2-start',
    llmGenerationId: 'generation-2',
    status: 'started',
    createdAt: '2026-05-02T00:00:00.800Z',
    model,
    displayInput: [{ role: 'user', content: 'Tool failed; respond briefly' }],
  });
  await exporter.publish({
    ...context,
    id: 'generation-2-end',
    llmGenerationId: 'generation-2',
    status: 'completed',
    createdAt: '2026-05-02T00:00:00.900Z',
    model,
    displayOutput: [{ role: 'assistant', content: 'done' }],
    usage: { input: 5, output: 2, totalTokens: 7 },
  });
  await exporter.publish({
    ...context,
    id: 'turn-end',
    type: 'chat_turn_completed',
    createdAt: '2026-05-02T00:00:01.000Z',
    details: { output: 'done' },
  });
}
