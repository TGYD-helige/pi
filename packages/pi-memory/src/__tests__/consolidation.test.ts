import { describe, expect, it } from 'vitest';
import {
  buildConsolidationUserPrompt,
  CONSOLIDATION_SYSTEM_PROMPT,
  type DreamTurn,
} from '../consolidation.js';

describe('consolidation', () => {
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
