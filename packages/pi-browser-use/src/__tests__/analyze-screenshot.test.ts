import { describe, expect, it, test, vi } from 'vitest';
import {
  createFetchVisionCaller,
  handleAnalyzeScreenshot,
  type VisionCaller,
} from '../analyze-screenshot.js';

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  const mockModel = { id: 'gpt-4o', provider: 'openai', reasoning: false };
  const mockReasoningModel = {
    id: 'kimi-k2.6',
    provider: 'deepseek-integration',
    reasoning: true,
  };
  const mockRegistry = {
    find: vi.fn((provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-4o') return mockModel;
      if (provider === 'deepseek-integration' && model === 'kimi-k2.6') {
        return mockReasoningModel;
      }
      return undefined;
    }),
    getApiKeyAndHeaders: vi.fn(() =>
      Promise.resolve({ ok: true, apiKey: 'resolved-key', headers: {} }),
    ),
  };
  return {
    ...actual,
    ModelRuntime: { create: vi.fn(() => Promise.resolve({})) },
    ModelRegistry: class {
      find = mockRegistry.find;
      getApiKeyAndHeaders = mockRegistry.getApiKeyAndHeaders;
    },
    __mockRegistry: mockRegistry,
  };
});

vi.mock('@earendil-works/pi-ai/compat', () => ({
  complete: vi.fn(() =>
    Promise.resolve({
      content: [{ type: 'text', text: 'Analysis result' }],
    }),
  ),
}));

function createMockClient(screenshotContent?: any[]) {
  return {
    callTool: vi.fn((_name: string, _args: Record<string, unknown>) =>
      Promise.resolve({
        content: screenshotContent ?? [
          { type: 'image', data: 'aW1hZ2VkYXRh', mimeType: 'image/png' },
        ],
      }),
    ),
    connect: vi.fn(() => Promise.resolve()),
    listAllTools: vi.fn(() => Promise.resolve([])),
    close: vi.fn(() => Promise.resolve()),
  } as any;
}

/** Mock VisionCaller that returns a fixed analysis string. */
function mockVisionCaller(response: string): VisionCaller {
  return vi.fn(() => Promise.resolve(response));
}

/** Mock VisionCaller that throws an error. */
function failingVisionCaller(error: string): VisionCaller {
  return vi.fn(() => Promise.reject(new Error(error)));
}

describe('handleAnalyzeScreenshot', () => {
  it.each([
    false,
    true,
  ])('rejects a failed screenshot before vision, even with image=%s', async (withImage) => {
    const client = createMockClient();
    client.callTool.mockResolvedValueOnce({
      isError: true,
      content: [
        { type: 'text', text: 'TimeoutError: test-token' },
        ...(withImage ? [{ type: 'image', data: 'test-token', mimeType: 'image/png' }] : []),
      ],
      structuredContent: { private: 'test-token' },
    });
    const caller = mockVisionCaller('false success');
    const result = await handleAnalyzeScreenshot(client, caller, {});
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { errorCategory: 'timeout', phase: 'capture' },
    });
    expect(caller).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it.each([
    ['429 quota exceeded; token=private-token', 'vision', 'HTTP 429', 'rate limit or quota'],
    ['Auth failed for vision model: private-token', 'authentication', 'credentials', 'credentials'],
    [
      'Vision model "private-token" not found in model registry.',
      'model_lookup',
      'not registered',
      'not registered',
    ],
    ['request timed out; private-token', 'vision', 'timed out', 'timed out'],
  ])('explains %s without returning the underlying response', async (message, phase, marker, reason) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await handleAnalyzeScreenshot(
        createMockClient(),
        failingVisionCaller(message),
        {},
      );
      expect(result.content[0]?.text).toContain(marker);
      expect(log.mock.calls.flat().join('\n')).toContain(`phase=${phase}`);
      expect(log.mock.calls.flat().join('\n')).toContain(reason);
      expect(JSON.stringify([result, log.mock.calls])).not.toContain('private-token');
    } finally {
      log.mockRestore();
    }
  });

  it('identifies screenshot transport failures separately from vision requests', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = createMockClient();
      client.callTool.mockRejectedValueOnce(new TypeError('private-token'));
      const result = await handleAnalyzeScreenshot(client, mockVisionCaller('unused'), {});
      expect(result.content[0]?.text).toContain('capture');
      expect(result.content[0]?.text).toContain('TypeError');
      expect(JSON.stringify([result, log.mock.calls])).not.toContain('private-token');
    } finally {
      log.mockRestore();
    }
  });

  it('logs bounded failure classification without the provider response or credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const caller = failingVisionCaller(
        '400 invalid max_tokens; Bearer private-token; raw response',
      );
      const result = await handleAnalyzeScreenshot(createMockClient(), caller, {});
      expect(result.isError).toBe(true);
      expect(log).toHaveBeenCalledWith(
        '[pi-browser-use] visual analysis failed (phase=vision, status=400, category=http, fields=max_tokens): HTTP 400: Request parameters or input were rejected.',
      );
      expect(JSON.stringify(result)).not.toContain('private-token');
    } finally {
      log.mockRestore();
    }
  });

  test('successful flow returns analysis', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Blue button at (150, 300)');
    const result = await handleAnalyzeScreenshot(client, caller, {
      pageId: 7,
      instruction: 'Find the blue button',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Blue button at (150, 300)');
    expect(client.callTool).toHaveBeenCalledWith('take_screenshot', { pageId: 7 }, undefined);
    expect(caller).toHaveBeenCalledWith(
      'Find the blue button',
      'aW1hZ2VkYXRh',
      'image/png',
      undefined,
    );
  });

  test('no screenshot data returns error', async () => {
    const client = createMockClient([{ type: 'text', text: 'No image' }]);
    const caller = mockVisionCaller('should not be called');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Failed to capture screenshot');
    expect(result.structuredContent?.errorCategory).toBe('invalid_response');
    expect(caller).not.toHaveBeenCalled();
  });

  test('empty screenshot content returns error', async () => {
    const client = createMockClient([]);
    const caller = mockVisionCaller('should not be called');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Failed to capture screenshot');
    expect(caller).not.toHaveBeenCalled();
  });

  test('vision model 404 returns model-not-available', async () => {
    const client = createMockClient();
    const caller = failingVisionCaller('Vision model API error (404): Not Found');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not available');
  });

  test('vision model generic error returns error message', async () => {
    const client = createMockClient();
    const caller = failingVisionCaller('Vision model API error (500): Internal Server Error');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Visual analysis failed');
  });

  test('empty analysis returns error', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('   ');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no analysis');
    expect(result.structuredContent?.errorCategory).toBe('invalid_response');
  });

  test('defaults instruction to empty string', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Full page analysis');
    const result = await handleAnalyzeScreenshot(client, caller, { pageId: 7 });

    expect(result.isError).toBeUndefined();
    expect(caller).toHaveBeenCalledWith('', 'aW1hZ2VkYXRh', 'image/png', undefined);
  });

  it('omits pageId when page ID routing is disabled', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Full page analysis');

    await handleAnalyzeScreenshot(client, caller, {});

    expect(client.callTool).toHaveBeenCalledWith('take_screenshot', {}, undefined);
  });

  it('forwards the abort signal to screenshot capture and vision analysis', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Full page analysis');
    const controller = new AbortController();

    await handleAnalyzeScreenshot(
      client,
      caller,
      { pageId: 7, instruction: 'Find the button' },
      controller.signal,
    );

    expect(client.callTool).toHaveBeenCalledWith(
      'take_screenshot',
      { pageId: 7 },
      controller.signal,
    );
    expect(caller).toHaveBeenCalledWith(
      'Find the button',
      'aW1hZ2VkYXRh',
      'image/png',
      controller.signal,
    );
  });

  it('does not convert cancellation into a visual analysis error', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('should not be called');
    const controller = new AbortController();
    controller.abort();
    client.callTool.mockRejectedValueOnce(controller.signal.reason);

    await expect(
      handleAnalyzeScreenshot(client, caller, { pageId: 7 }, controller.signal),
    ).rejects.toBe(controller.signal.reason);
  });

  test('uses correct mimeType from screenshot response', async () => {
    const client = createMockClient([{ type: 'image', data: 'jpegdata', mimeType: 'image/jpeg' }]);
    const caller = mockVisionCaller('result');
    await handleAnalyzeScreenshot(client, caller, { instruction: 'test' });

    expect(caller).toHaveBeenCalledWith('test', 'jpegdata', 'image/jpeg', undefined);
  });

  test('permission error returns model-not-available', async () => {
    const client = createMockClient();
    const caller = failingVisionCaller('permission denied: insufficient scope');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not available');
  });

  it('rejects late visual analysis after caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const caller = vi.fn(async () => {
      controller.abort(reason);
      return 'late analysis';
    });
    await expect(
      handleAnalyzeScreenshot(createMockClient(), caller, {}, controller.signal),
    ).rejects.toBe(reason);
  });

  it('rejects an oversized single-line analysis when truncation would remove all analysis', async () => {
    const result = await handleAnalyzeScreenshot(
      createMockClient(),
      mockVisionCaller('x'.repeat(100_000)),
      {},
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCategory).toBe('invalid_response');
    expect(result.content[0]!.text).toContain('shorter analysis');
  });

  it('keeps useful analysis when a multiline response is truncated', async () => {
    const result = await handleAnalyzeScreenshot(
      createMockClient(),
      mockVisionCaller('Button at (100, 200)\n'.repeat(3000)),
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Button at (100, 200)');
    expect(result.content[0]!.text).toContain('truncated');
    expect(result.content[0]!.text.split('\n').length).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
  });

  test('prefixes success result with Visual Analysis Result', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Found button at (100, 200)');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find the button',
    });

    expect(result.content[0]!.text).toMatch(/^Visual Analysis Result:/);
    expect(result.content[0]!.text).toContain('Found button at (100, 200)');
  });
});

describe('createFetchVisionCaller', () => {
  test('resolves model from registry and calls complete()', async () => {
    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    const result = await caller('Find button', 'aW1hZ2VkYXRh', 'image/png');

    expect(result).toBe('Analysis result');

    const { complete } = await import('@earendil-works/pi-ai/compat');
    expect(complete).toHaveBeenCalled();
  });

  it('initializes the registry only on demand and retries failed initialization safely', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const create = vi.mocked(ModelRuntime.create);
    create.mockClear();
    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(create).not.toHaveBeenCalled();
    create.mockRejectedValueOnce(new Error('test-token'));
    await expect(caller('describe', 'image', 'image/png')).rejects.toThrow(
      'Initialize vision registry',
    );
    await expect(caller('describe', 'image', 'image/png')).resolves.toBe('Analysis result');
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('throws when model not found in registry', async () => {
    const caller = createFetchVisionCaller({ provider: 'unknown', model: 'no-model' });
    await expect(caller('test', 'data', 'image/png')).rejects.toThrow(
      'not found in model registry',
    );
  });

  test('throws when auth fails', async () => {
    const { __mockRegistry } = (await import('@earendil-works/pi-coding-agent')) as any;
    __mockRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: false,
      error: 'no key configured',
    });

    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await expect(caller('test', 'data', 'image/png')).rejects.toThrow('Auth failed');
  });

  test('passes image data and mimeType to complete()', async () => {
    const piAi = await import('@earendil-works/pi-ai/compat');
    (piAi.complete as any).mockClear();
    const controller = new AbortController();

    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await caller('Describe this', 'aW1hZ2U=', 'image/jpeg', controller.signal);

    const callArgs = (piAi.complete as any).mock.calls[0];
    const messages = callArgs[1].messages;
    const imageContent = messages[0].content[1];
    expect(imageContent.type).toBe('image');
    expect(imageContent.data).toBe('aW1hZ2U=');
    expect(imageContent.mimeType).toBe('image/jpeg');
    expect(callArgs[2].signal).toBe(controller.signal);
    expect(callArgs[2]).not.toHaveProperty('temperature');
  });

  it('omits temperature for reasoning vision models too', async () => {
    const piAi = await import('@earendil-works/pi-ai/compat');
    (piAi.complete as any).mockClear();

    const caller = createFetchVisionCaller({
      provider: 'deepseek-integration',
      model: 'kimi-k2.6',
    });
    await caller('Describe this', 'aW1hZ2U=', 'image/png');

    const options = (piAi.complete as any).mock.calls[0][2];
    expect(options).toMatchObject({ maxTokens: 2048 });
    expect(options).not.toHaveProperty('temperature');
  });

  it.each([
    ['error', 'request_failed'],
    ['aborted', 'cancelled'],
    ['empty', 'invalid_response'],
  ])('rejects %s model output safely', async (kind, category) => {
    const piAi = await import('@earendil-works/pi-ai/compat');
    (piAi.complete as any).mockResolvedValueOnce({
      content: [{ type: 'text', text: kind === 'empty' ? '   ' : 'partial analysis' }],
      stopReason: kind === 'empty' ? 'stop' : kind,
      errorMessage: 'test-token',
    });
    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await expect(caller('Describe this', 'aW1hZ2U=', 'image/png')).rejects.toMatchObject({
      errorCategory: category,
      message: expect.not.stringContaining('test-token'),
    });
  });
});
