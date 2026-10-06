import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConsolidationUserPrompt,
  CONSOLIDATION_SYSTEM_PROMPT,
  type DreamTurn,
  runConsolidation,
} from '../consolidation.js';

describe('consolidation', () => {
  describe('runConsolidation', () => {
    let memoryDir: string;

    beforeEach(async () => {
      memoryDir = await mkdtemp(path.join(tmpdir(), 'pi-memory-consolidation-'));
    });

    afterEach(async () => {
      await rm(memoryDir, { recursive: true, force: true });
    });

    it('executes memory tools and preserves their results through the real Agent loop', async () => {
      const provider = registerFauxProvider({ provider: 'pi-memory-test' });
      const model = provider.getModel();
      provider.setResponses([
        (context, options) => {
          expect(getCurrentSystemPrompt(context.messages)).toBe(CONSOLIDATION_SYSTEM_PROMPT);
          expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain(
            'memory_add',
          );
          expect(options).toMatchObject({ apiKey: 'test-key' });
          return fauxAssistantMessage(
            fauxToolCall('memory_add', { target: 'memory', content: 'The project uses Node 24.' }),
            { stopReason: 'toolUse' },
          );
        },
        (context) => {
          expect(context.messages.at(-1)).toMatchObject({
            role: 'toolResult',
            toolName: 'memory_add',
            isError: false,
          });
          return fauxAssistantMessage('Saved.');
        },
      ]);
      try {
        expect(
          await runConsolidation({
            memoryDir,
            turns: [],
            modelConfig: { provider: model.provider, model: model.id },
            modelRegistry: {
              find: () => model,
              getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
            },
          }),
        ).toBe(true);
        expect(await readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toContain(
          'The project uses Node 24.',
        );
        expect(provider.state.callCount).toBe(2);
      } finally {
        provider.unregister();
      }
    });
  });

  describe('CONSOLIDATION_SYSTEM_PROMPT', () => {
    it('contains all four phases', () => {
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('Phase 1');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('Phase 2');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('Phase 3');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('Phase 4');
    });

    it('mentions memory tool names', () => {
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('memory_read');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('memory_add');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('memory_replace');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('memory_remove');
    });

    it('uses live capacity and preserves factual memory boundaries', () => {
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('memory_read');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('declarative facts');
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('capacity');
      expect(CONSOLIDATION_SYSTEM_PROMPT).not.toMatch(/2200|1375|ZERO information loss/);
    });
  });

  describe('buildConsolidationUserPrompt', () => {
    it('returns fallback message when no turns provided', () => {
      const result = buildConsolidationUserPrompt([]);
      expect(result).toContain('No recent conversations');
      expect(result).toContain('memory_read');
    });

    it('formats turns with session id and timestamps', () => {
      const turns: DreamTurn[] = [
        {
          id: '1',
          sessionId: 'sess-1',
          conversationId: 'conv-1',
          userMessage: 'Hello world',
          assistantMessage: 'Hi there',
          model: { provider: 'test', model: 'test-model' },
          createdAt: '2026-06-20T10:00:00Z',
        },
      ];

      const result = buildConsolidationUserPrompt(turns);
      expect(result).toContain('sess-1');
      expect(result).toContain('2026-06-20T10:00:00Z');
      expect(result).toContain('Hello world');
      expect(result).toContain('Hi there');
    });

    it('respects the 8000 char limit', () => {
      const longMsg = 'x'.repeat(3000);
      const turns: DreamTurn[] = Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        sessionId: `sess-${i}`,
        conversationId: 'conv-1',
        userMessage: longMsg,
        assistantMessage: longMsg,
        model: { provider: 'test', model: 'test-model' },
        createdAt: '2026-06-20T10:00:00Z',
      }));

      const result = buildConsolidationUserPrompt(turns);
      expect(result.length).toBeLessThanOrEqual(8200);
    });

    it('includes instruction to begin with memory_read', () => {
      const turns: DreamTurn[] = [
        {
          id: '1',
          sessionId: 'sess-1',
          conversationId: 'conv-1',
          userMessage: 'test',
          assistantMessage: 'reply',
          model: { provider: 'test', model: 'test-model' },
          createdAt: '2026-06-20T10:00:00Z',
        },
      ];

      const result = buildConsolidationUserPrompt(turns);
      expect(result).toContain('Begin by calling memory_read');
    });
  });
});
