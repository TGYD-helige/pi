import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  complete: vi.fn(),
}));

import { complete } from '@earendil-works/pi-ai/compat';
import { summarizeContent } from '../summary.js';
import type { SummaryModelConfig } from '../types.js';

const mockComplete = vi.mocked(complete);

describe('summarizeContent', () => {
  const config: SummaryModelConfig = { provider: 'openai', model: 'gpt-4o-mini' };

  const mockCtx = {
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(),
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects resolved provider errors without exposing raw details', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true });
    mockComplete.mockResolvedValue({
      content: [],
      stopReason: 'error',
      errorMessage: 'Bearer private-token',
    } as any);
    await expect(summarizeContent('content', 'prompt', config, mockCtx)).rejects.toThrow(
      'Summary model request failed.',
    );
  });

  it('passes caller cancellation to the summary request', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true });
    mockComplete.mockResolvedValue({ content: [] } as any);
    const controller = new AbortController();
    await summarizeContent('content', 'prompt', config, mockCtx, controller.signal);
    expect(mockComplete.mock.calls[0]![2]!.signal).toBe(controller.signal);
  });

  it('calls complete with content and prompt, returns text', async () => {
    const mockModel = { id: 'gpt-4o-mini', provider: 'openai' };
    mockCtx.modelRegistry.find.mockReturnValue(mockModel);
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'key' });
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'Summarized content here' }],
    } as any);

    const result = await summarizeContent(
      '# Full page\nLots of content...',
      'What is this page about?',
      config,
      mockCtx,
    );

    expect(result).toBe('Summarized content here');
    expect(mockCtx.modelRegistry.find).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(mockComplete).toHaveBeenCalledOnce();

    const [model, messages, options] = mockComplete.mock.calls[0]!;
    expect(model).toBe(mockModel);
    expect(options!.apiKey).toBe('key');
    expect(options!.temperature).toBe(0);

    const userContent = (messages as any).messages[0].content[0].text;
    expect(userContent).toContain('Full page');
    expect(userContent).toContain('What is this page about?');
  });

  it('truncates content exceeding 100k chars', async () => {
    const mockModel = { id: 'model' };
    mockCtx.modelRegistry.find.mockReturnValue(mockModel);
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'k' });
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    } as any);

    const longContent = 'x'.repeat(150_000);
    await summarizeContent(longContent, 'summarize', config, mockCtx);

    const userText = (mockComplete.mock.calls[0]![1] as any).messages[0].content[0].text;
    expect(userText).toContain('[Content truncated due to length...]');
    expect(userText.length).toBeLessThan(150_000);
  });

  it('throws when model not found in registry', async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);

    await expect(summarizeContent('content', 'prompt', config, mockCtx)).rejects.toThrow(
      'not found in model registry',
    );
  });

  it('throws when auth fails', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: 'no key' });

    await expect(summarizeContent('content', 'prompt', config, mockCtx)).rejects.toThrow(
      'Auth failed',
    );
  });

  it('passes headers from auth to complete options', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: 'k',
      headers: { 'X-Custom': 'val' },
    });
    mockComplete.mockResolvedValue({ content: [{ type: 'text', text: 'r' }] } as any);

    await summarizeContent('c', 'p', config, mockCtx);

    const options = mockComplete.mock.calls[0]![2];
    expect(options!.headers).toEqual({ 'X-Custom': 'val' });
  });

  it('joins multiple text blocks from response', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'k' });
    mockComplete.mockResolvedValue({
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: ' Part 2' },
      ],
    } as any);

    const result = await summarizeContent('c', 'p', config, mockCtx);
    expect(result).toBe('Part 1 Part 2');
  });

  it("uses Pi's registry so providers registered by extensions work", async () => {
    const model = { id: 'claude-opus', provider: 'claude-sdk', api: 'claude-agent-sdk' };
    // Like Pi's ModelRegistry, complete is a method that needs its receiver.
    const registry = {
      result: { content: [{ type: 'text', text: 'From the registry' }] },
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'resolved-once' }),
      complete: vi.fn(function (this: { result: unknown }, _m: unknown, _c: unknown, _o?: object) {
        return Promise.resolve(this.result);
      }),
    };
    const result = await summarizeContent('c', 'p', config, { modelRegistry: registry } as any);
    expect(result).toBe('From the registry');
    expect(mockComplete).not.toHaveBeenCalled();
    // The registry resolves credentials per request.
    expect(registry.complete.mock.calls[0]![2]).not.toHaveProperty('apiKey');
  });
});
