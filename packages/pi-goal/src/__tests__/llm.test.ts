import { createServer } from 'node:http';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getModel,
  registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { describe, expect, it, vi } from 'vitest';
import { completeOnce } from '../llm.js';

describe('completeOnce', () => {
  it('retains a network reset after HTTP 200 and an actual SSE delta', async () => {
    const chunk = {
      id: 'local-sse',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'local-model',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'first delta' }, finish_reason: null },
      ],
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      setTimeout(() => response.destroy(), 100);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server port');
    const model = {
      ...getModel('openai', 'gpt-4o-mini'),
      api: 'openai-completions',
      provider: 'local-sse-test',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    const prompt = vi.spyOn(Agent.prototype, 'prompt');
    const onError = vi.fn();
    try {
      expect(
        await completeOnce(
          {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          },
          { provider: model.provider, model: model.id },
          'system',
          'user',
          undefined,
          onError,
        ),
      ).toBeNull();
      const agent = prompt.mock.contexts[0];
      if (!(agent instanceof Agent)) throw new Error('Expected the real Agent');
      const assistant = agent.state.messages.filter((m) => m.role === 'assistant').at(-1);
      expect(JSON.stringify(assistant?.content)).toContain('first delta');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCategory: 'network_error' }),
      );
    } finally {
      prompt.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps resolution failures observable without changing the null fallback', async () => {
    const onError = vi.fn();
    const result = await completeOnce(
      { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
      { provider: 'fixture', model: 'fixture' },
      'system',
      'user',
      undefined,
      onError,
    );
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCategory: 'configuration_error',
        error: expect.stringContaining('model'),
      }),
    );
  });

  it.each([
    'default abort',
    'network cause',
  ])('keeps %s classification before the provider flattens errors', async (kind) => {
    const provider = registerFauxProvider({ provider: 'pi-goal-transport-errors' });
    const model = provider.getModel();
    const controller = new AbortController();
    controller.abort();
    const error =
      kind === 'default abort'
        ? controller.signal.reason
        : new TypeError('fetch failed', {
            cause: Object.assign(new Error('private host test-token'), { code: 'ECONNRESET' }),
          });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    provider.setResponses([
      async (_context, options) => {
        if (kind === 'default abort') throw controller.signal.reason;
        await (options?.fetch ?? globalThis.fetch)('https://example.com');
        return fauxAssistantMessage('unreachable');
      },
    ]);
    const onError = vi.fn();
    try {
      expect(
        await completeOnce(
          {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          },
          { provider: model.provider, model: model.id },
          'system',
          'user',
          undefined,
          onError,
        ),
      ).toBeNull();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCategory: kind === 'default abort' ? 'cancelled' : 'network_error',
        }),
      );
      expect(JSON.stringify(onError.mock.calls)).not.toContain('test-token');
    } finally {
      vi.unstubAllGlobals();
      provider.unregister();
    }
  });

  it('cancels the active request when its caller aborts', async () => {
    const provider = registerFauxProvider({ provider: 'pi-goal-caller-cancel' });
    const model = provider.getModel();
    const controller = new AbortController();
    let cancelled = false;
    provider.setResponses([
      (_context, options) => {
        controller.abort();
        cancelled = options?.signal?.aborted ?? false;
        return fauxAssistantMessage('Late response.');
      },
    ]);
    try {
      expect(
        await completeOnce(
          {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          },
          { provider: model.provider, model: model.id },
          'system',
          'user',
          controller.signal,
        ),
      ).toBeNull();
      expect(cancelled).toBe(true);
    } finally {
      provider.unregister();
    }
  });

  it.each([
    ['TimeoutError', 'request timed out: test-token', 'timeout'],
    ['AbortError', 'The operation was aborted: test-token', 'cancelled'],
  ])('retains %s classification through the real Agent', async (name, message, category) => {
    const provider = registerFauxProvider({ provider: 'pi-goal-error-test' });
    const model = provider.getModel();
    const onError = vi.fn();
    provider.setResponses([
      () => {
        throw new DOMException(message, name);
      },
    ]);
    try {
      expect(
        await completeOnce(
          {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          },
          { provider: model.provider, model: model.id },
          'system',
          'user',
          undefined,
          onError,
        ),
      ).toBeNull();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errorCategory: category }));
      expect(JSON.stringify(onError.mock.calls)).not.toContain('test-token');
    } finally {
      provider.unregister();
    }
  });

  it('uses the Agent aborted stop reason when no typed error survives', async () => {
    const provider = registerFauxProvider({ provider: 'pi-goal-aborted-test' });
    const model = provider.getModel();
    const onError = vi.fn();
    provider.setResponses([
      () => fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'test-token' }),
    ]);
    try {
      expect(
        await completeOnce(
          {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          },
          { provider: model.provider, model: model.id },
          'system',
          'user',
          undefined,
          onError,
        ),
      ).toBeNull();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errorCategory: 'cancelled' }));
      expect(JSON.stringify(onError.mock.calls)).not.toContain('test-token');
    } finally {
      provider.unregister();
    }
  });

  it('preserves instructions and authentication through the real Agent and compat stream', async () => {
    const provider = registerFauxProvider({ provider: 'pi-goal-test' });
    const model = provider.getModel();
    provider.setResponses([
      (context, options) => {
        expect(getCurrentSystemPrompt(context.messages)).toBe('Evaluate the goal.');
        expect(getCurrentTools(context.messages)).toEqual([]);
        expect(context.messages.at(-1)).toMatchObject({
          role: 'user',
          content: [{ type: 'text', text: 'Check progress.' }],
        });
        expect(options).toMatchObject({ apiKey: 'test-key', headers: { 'x-test': 'goal' } });
        return fauxAssistantMessage('Goal completed.');
      },
    ]);
    try {
      const result = await completeOnce(
        {
          find: () => model,
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: 'test-key',
            headers: { 'x-test': 'goal' },
          }),
        },
        { provider: model.provider, model: model.id },
        'Evaluate the goal.',
        'Check progress.',
      );
      expect(result).toBe('Goal completed.');
      expect(provider.state.callCount).toBe(1);
    } finally {
      provider.unregister();
    }
  });
});
