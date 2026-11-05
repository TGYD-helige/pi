import {
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { describe, expect, it, vi } from 'vitest';
import { completeOnce } from '../llm.js';

describe('completeOnce', () => {
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
