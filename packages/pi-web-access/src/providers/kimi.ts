import { readResponseBytes } from '@amaster.ai/pi-shared';
import {
  BaseProvider,
  getEnvironmentContext,
  SEARCH_SYSTEM_PROMPT,
  timeoutSignal,
} from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse } from './index.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS_PER_ROUND = 4;
const MAX_BILLABLE_FORMULA_CALLS = 16;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FORMULA_OUTPUT_BYTES = 256 * 1024;
const MAX_ACCUMULATED_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_FORMULA_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOTAL_ELAPSED_MS = 2 * 60_000;
const WEB_SEARCH_FORMULA = 'moonshot/web-search:latest';

interface KimiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface KimiResponse {
  choices: Array<{ finish_reason: string; message: KimiMessage }>;
}

interface KimiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface FormulaFiberResponse {
  status: string;
  context?: {
    output?: string;
    encrypted_output?: string;
  };
}

export class KimiProvider extends BaseProvider {
  readonly id = 'kimi' as const;

  override async search(
    params: SearchParams,
    provider: ResolvedProvider,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Kimi API key not configured. Set MOONSHOT_API_KEY env var or configure in settings.json.',
      );
    }

    const messages: KimiMessage[] = [
      { role: 'system', content: SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: `${getEnvironmentContext()}\n\n${params.query}` },
    ];

    const deadline = Date.now() + MAX_TOTAL_ELAPSED_MS;
    const tools = await this.loadTools(provider, deadline, signal);
    let totalToolCalls = 0;
    let accumulatedOutputBytes = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.callApi(messages, tools, provider, deadline, signal);
      const choice = response.choices[0];
      if (!choice) throw new Error('Kimi API returned empty response');

      const toolCalls = choice.message.tool_calls ?? [];
      if (choice.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
        return {
          provider: provider.id,
          query: params.query,
          answer: choice.message.content ?? '',
          results: [],
        };
      }
      if (
        toolCalls.length > MAX_TOOL_CALLS_PER_ROUND ||
        totalToolCalls + toolCalls.length > MAX_BILLABLE_FORMULA_CALLS
      ) {
        throw new Error('Kimi Formula web search exceeded the tool-call budget and billing limit');
      }
      totalToolCalls += toolCalls.length;

      messages.push(choice.message);
      for (const toolCall of toolCalls) {
        const fiber = await this.executeFormula(toolCall.function, provider, deadline, signal);
        const content = fiber.context?.output || fiber.context?.encrypted_output;
        if (!content) throw new Error('Kimi Formula web search returned no output');
        const contentBytes = Buffer.byteLength(content);
        accumulatedOutputBytes += contentBytes;
        if (
          contentBytes > MAX_FORMULA_OUTPUT_BYTES ||
          accumulatedOutputBytes > MAX_ACCUMULATED_OUTPUT_BYTES
        ) {
          throw new Error('Kimi Formula web search exceeded the output-size budget');
        }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content,
        });
      }
    }
    throw new Error(`Kimi Formula web search exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
  }

  private async callApi(
    messages: KimiMessage[],
    tools: KimiTool[],
    provider: ResolvedProvider,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<KimiResponse> {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: provider.model ?? 'kimi-k3',
      messages,
      tools,
    };

    const encodedBody = JSON.stringify(body);
    if (Buffer.byteLength(encodedBody) > MAX_PROMPT_BYTES) {
      throw new Error('Kimi Formula web search exceeded the prompt-size budget');
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(provider),
      body: encodedBody,
      signal: this.requestSignal(provider, deadline, signal),
    });
    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
    }
    return this.readJson<KimiResponse>(response);
  }

  private async loadTools(
    provider: ResolvedProvider,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<KimiTool[]> {
    const baseUrl = provider.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/formulas/${WEB_SEARCH_FORMULA}/tools`, {
      headers: this.headers(provider),
      signal: this.requestSignal(provider, deadline, signal),
    });
    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
    }
    const data = await this.readJson<{ tools: KimiTool[] }>(response);
    if (!Array.isArray(data.tools) || data.tools.length === 0 || data.tools.length > 8) {
      throw new Error('Kimi Formula web search returned no tools');
    }
    return data.tools;
  }

  private async executeFormula(
    toolCall: { name: string; arguments: string },
    provider: ResolvedProvider,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<FormulaFiberResponse> {
    const baseUrl = provider.baseUrl.replace(/\/$/, '');
    const encodedBody = JSON.stringify(toolCall);
    if (Buffer.byteLength(encodedBody) > MAX_FORMULA_ARGUMENT_BYTES) {
      throw new Error('Kimi Formula web search exceeded the prompt-size budget');
    }
    const response = await fetch(`${baseUrl}/formulas/${WEB_SEARCH_FORMULA}/fibers`, {
      method: 'POST',
      headers: this.headers(provider),
      body: encodedBody,
      signal: this.requestSignal(provider, deadline, signal),
    });
    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
    }
    const fiber = await this.readJson<FormulaFiberResponse>(response);
    if (fiber.status !== 'succeeded') throw new Error('Kimi Formula web search failed');
    return fiber;
  }

  private headers(provider: ResolvedProvider): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    };
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.body || !response.headers) return (await response.json()) as T;
    const bytes = await readResponseBytes(response, MAX_RESPONSE_BYTES);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  private requestSignal(
    provider: ResolvedProvider,
    deadline: number,
    signal?: AbortSignal,
  ): AbortSignal {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Kimi Formula web search exceeded the elapsed-time budget');
    }
    return timeoutSignal(Math.min(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingMs), signal);
  }
}
