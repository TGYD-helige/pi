import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtractionRunner, type TurnEndEvent } from '../background-extraction.js';
import { MemoryStore } from '../store.js';

const event: TurnEndEvent = {
  turnIndex: 0,
  message: { role: 'user', content: 'Remember this preference', timestamp: 0 },
  toolResults: [],
};

describe('background extraction Agent boundary', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pi-memory-extraction-agent-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['TimeoutError', 'request timed out: test-token', 'timed out'],
    ['AbortError', 'The operation was aborted: test-token', 'was cancelled'],
    ['AbortError', 'This operation was aborted', 'was cancelled'],
    ['NetworkError', 'fetch failed', 'network error'],
  ])('retains %s after the real Agent converts the error', async (name, message, expected) => {
    const provider = registerFauxProvider({ provider: 'pi-memory-extraction-errors' });
    const model = provider.getModel();
    const store = new MemoryStore({ dir });
    await store.loadFromDisk();
    const onNotify = vi.fn();
    if (name === 'NetworkError')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('test-token'), { code: 'ECONNRESET' }),
          }),
        ),
      );
    provider.setResponses([
      async (_context, options) => {
        if (name === 'NetworkError')
          await (options?.fetch ?? globalThis.fetch)('https://example.com');
        throw new DOMException(message, name);
      },
    ]);
    const runner = createExtractionRunner({
      store,
      interval: 1,
      modelConfig: { provider: model.provider, model: model.id },
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
      },
      onNotify,
    });
    try {
      runner.onTurnEnd(event);
      await vi.waitFor(() =>
        expect(onNotify).toHaveBeenCalledWith(expect.stringContaining(expected), 'warning'),
      );
      expect(JSON.stringify(onNotify.mock.calls)).not.toContain('test-token');
    } finally {
      runner.shutdown();
      provider.unregister();
    }
  });

  it('cancels its running Agent before a late response writes memory', async () => {
    const prompt = vi.spyOn(Agent.prototype, 'prompt');
    const provider = registerFauxProvider({ provider: 'pi-memory-extraction-cancel' });
    const model = provider.getModel();
    const store = new MemoryStore({ dir });
    await store.loadFromDisk();
    let entered!: () => void;
    let release!: () => void;
    let providerSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.setResponses([
      async (_context, options) => {
        providerSignal = options?.signal;
        entered();
        await blocked;
        return fauxAssistantMessage(
          fauxToolCall('memory_add', { target: 'memory', content: 'late mutation' }),
          { stopReason: 'toolUse' },
        );
      },
      () => fauxAssistantMessage('Saved.'),
    ]);
    const runner = createExtractionRunner({
      store,
      interval: 1,
      modelConfig: { provider: model.provider, model: model.id },
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
      },
    });
    try {
      runner.onTurnEnd(event);
      await started;
      runner.shutdown();
      const cancelled = providerSignal?.aborted;
      release();
      await prompt.mock.results[0]!.value;
      await expect(readFile(path.join(dir, 'MEMORY.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(cancelled).toBe(true);
    } finally {
      release();
      runner.shutdown();
      provider.unregister();
    }
  });
});
