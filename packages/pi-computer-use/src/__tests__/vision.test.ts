import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { describe, expect, it, test, vi } from 'vitest';
import { createPiVisionCaller, VISUAL_SYSTEM_PROMPT } from '../vision.js';

describe('vision', () => {
  describe('VISUAL_SYSTEM_PROMPT', () => {
    test('contains key instructions for computer-use analysis', () => {
      expect(VISUAL_SYSTEM_PROMPT).toContain('Visual Analysis Agent');
      expect(VISUAL_SYSTEM_PROMPT).toContain('pixel coordinates');
      expect(VISUAL_SYSTEM_PROMPT).toContain('clickable elements');
      expect(VISUAL_SYSTEM_PROMPT).toContain('CENTER point');
      expect(VISUAL_SYSTEM_PROMPT).toContain('Do NOT perform actions');
    });
  });

  describe('createPiVisionCaller()', () => {
    it.each([
      ['error', 'http_error'],
      ['aborted', 'cancelled'],
      ['empty', 'invalid_response'],
    ])('rejects %s model results instead of returning partial or empty success', async (kind, category) => {
      const provider = registerFauxProvider({ provider: 'pi-computer-vision-error' });
      const model = provider.getModel();
      provider.setResponses([
        () =>
          fauxAssistantMessage(kind === 'empty' ? '   ' : 'partial analysis', {
            stopReason: kind === 'empty' ? 'stop' : kind === 'error' ? 'error' : 'aborted',
            errorMessage: kind === 'error' ? 'HTTP 403: test-token' : 'test-token',
          }),
      ]);
      try {
        const caller = createPiVisionCaller({ provider: model.provider, model: model.id }, {
          modelRegistry: {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
          },
        } as never);
        await expect(caller('describe', 'image', 'image/png')).rejects.toMatchObject({
          errorCategory: category,
          message: expect.not.stringContaining('test-token'),
        });
      } finally {
        provider.unregister();
      }
    });

    test('throws when model is not found in registry', async () => {
      const mockCtx = {
        modelRegistry: {
          find: vi.fn(() => null),
          getApiKeyAndHeaders: vi.fn(),
        },
      };

      const caller = createPiVisionCaller({ provider: 'openai', model: 'gpt-4o' }, mockCtx as any);

      await expect(caller('describe', 'base64data', 'image/png')).rejects.toThrow(
        'not found in model registry',
      );
    });

    test('throws when auth fails', async () => {
      const mockCtx = {
        modelRegistry: {
          find: vi.fn(() => ({ id: 'gpt-4o', provider: 'openai' })),
          getApiKeyAndHeaders: vi.fn(() => ({ ok: false, error: 'No API key configured' })),
        },
      };

      const caller = createPiVisionCaller({ provider: 'openai', model: 'gpt-4o' }, mockCtx as any);

      await expect(caller('describe', 'base64data', 'image/png')).rejects.toThrow(
        'Auth failed for vision model',
      );
    });
  });
});
