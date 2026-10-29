import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { OpenAILLM } from 'mem0ai/oss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const messages = [{ role: 'user', content: 'Extract facts.' }];
const tools = [
  { type: 'function', function: { name: 'remember', parameters: { type: 'object' } } },
];

describe('OpenAILLM extraBody dependency patch', () => {
  let server: Server;
  let baseURL: string;
  let bodies: Record<string, unknown>[];

  beforeEach(async () => {
    bodies = [];
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local server address');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it.each([
    'ESM',
    'CommonJS',
  ])('forwards extra parameters in %s extraction and chat requests', async (format) => {
    const LLM: typeof OpenAILLM = format === 'ESM' ? OpenAILLM : require('mem0ai/oss').OpenAILLM;
    const llm = new LLM({
      apiKey: 'test-only',
      baseURL,
      model: 'test-model',
      extraBody: {
        enable_thinking: false,
        temperature: 0,
        max_tokens: 128,
        reasoning_effort: 'low',
        chat_template_kwargs: { enable_thinking: false },
      },
    });

    expect(await llm.generateResponse(messages, { type: 'json_object' }, tools)).toBe('ok');
    expect(await llm.generateChat(messages)).toEqual({ role: 'assistant', content: 'ok' });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({
        model: 'test-model',
        messages,
        enable_thinking: false,
        temperature: 0,
        max_tokens: 128,
        reasoning_effort: 'low',
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(body).not.toHaveProperty('extraBody');
    }
    expect(bodies[0]).toMatchObject({
      response_format: { type: 'json_object' },
      tools,
      tool_choice: 'auto',
    });
    expect(bodies[1]).not.toHaveProperty('tools');
  });

  it.each(
    [
      null,
      false,
      'invalid',
      [],
      { messages: [] },
      { model: 'other' },
      { tools: [] },
      { tool_choice: 'none' },
      { response_format: {} },
      { stream: true },
    ].map((extraBody) => ({ extraBody })),
  )('rejects invalid or reserved extraBody: $extraBody', ({ extraBody }) => {
    for (const LLM of [OpenAILLM, require('mem0ai/oss').OpenAILLM]) {
      expect(() => Reflect.construct(LLM, [{ apiKey: 'test-only', baseURL, extraBody }])).toThrow(
        /extraBody/,
      );
    }
    expect(bodies).toEqual([]);
  });

  it.each([undefined, {}])('preserves default requests with extraBody: %j', async (extraBody) => {
    const llm = new OpenAILLM({
      apiKey: 'test-only',
      model: 'test-model',
      baseURL,
      ...(extraBody === undefined ? {} : { extraBody }),
    });
    await llm.generateResponse(messages, { type: 'json_object' });
    await llm.generateChat(messages);
    expect(bodies).toEqual([
      { model: 'test-model', messages, response_format: { type: 'json_object' } },
      { model: 'test-model', messages },
    ]);
  });
});
