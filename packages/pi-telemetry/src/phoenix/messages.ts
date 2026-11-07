import type { Attributes } from '@opentelemetry/api';
import { isInlineImage } from '../observations.js';

// Raw I/O remains available; semantic duplication has its own aggregate budget.
const MAX_BYTES = 250_000;
const MAX_ATTRIBUTES = 512;
const MAX_ITEMS = 100;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function expandMessages(values: unknown[], attributes: Attributes): unknown[] {
  return values.flatMap((value) => {
    const msg = record(value);
    const blocks = items(msg.content ?? msg.parts);
    if (blocks.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
    if (
      !blocks.some(
        (block) => record(block).type === 'tool_result' || record(block).functionResponse,
      )
    )
      return [value];
    const messages: unknown[] = [];
    let content: unknown[] = [];
    for (const raw of blocks.slice(-MAX_ITEMS)) {
      const block = record(raw);
      if (block.type === 'tool_result' || block.functionResponse) {
        if (content.length) {
          messages.push({ ...msg, content });
          content = [];
        }
        const response = record(block.functionResponse);
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? response.id,
          ...(typeof response.name === 'string' ? { name: response.name } : {}),
          content: block.type === 'tool_result' ? block.content : JSON.stringify(response.response),
        });
      } else content.push(raw);
    }
    if (content.length) messages.push({ ...msg, content });
    return messages;
  });
}

export function projectMessages(attributes: Attributes, input: unknown, output: unknown): void {
  let bytes = 0;
  let count = 0;
  const set = (key: string, value: unknown) => {
    if (value === undefined) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const size = Buffer.byteLength(key) + Buffer.byteLength(text);
    if (count >= MAX_ATTRIBUTES || bytes + size > MAX_BYTES) {
      attributes['pi.telemetry.projection.truncated'] = true;
      return;
    }
    attributes[key] = text;
    bytes += size;
    count++;
  };
  function message(prefix: string, value: unknown): void {
    const msg = record(value);
    const role =
      msg.role ??
      (msg.type === 'function_call'
        ? 'assistant'
        : msg.type === 'function_call_output'
          ? 'tool'
          : msg.type === 'reasoning'
            ? 'assistant'
            : undefined);
    if (!role) return;
    set(`${prefix}.role`, role === 'model' ? 'assistant' : role === 'toolResult' ? 'tool' : role);
    set(`${prefix}.name`, msg.name);
    set(
      `${prefix}.tool_call_id`,
      msg.tool_call_id ??
        msg.toolCallId ??
        (msg.type === 'function_call_output' ? msg.call_id : undefined),
    );
    let contentIndex = 0;
    let callIndex = 0;
    const text: string[] = [];
    function content(kind: string, value: unknown) {
      if (typeof value !== 'string') return;
      const key = `${prefix}.contents.${contentIndex++}.message_content`;
      set(`${key}.type`, kind);
      set(`${key}.${kind === 'image' ? 'image.image.url' : 'text'}`, value);
    }
    function call(value: unknown) {
      const item = record(value);
      const fn = record(item.function ?? item.functionCall);
      const key = `${prefix}.tool_calls.${callIndex++}.tool_call`;
      set(
        `${key}.id`,
        item.type === 'function_call' ? (item.call_id ?? item.id) : (item.id ?? item.call_id),
      );
      set(`${key}.function.name`, fn.name ?? item.name);
      set(`${key}.function.arguments`, fn.arguments ?? fn.args ?? item.arguments ?? item.input);
    }
    if (typeof msg.content === 'string') text.push(msg.content);
    if (msg.type === 'function_call_output') text.push(String(msg.output ?? ''));
    if (msg.type === 'function_call') call(msg);
    if (items(msg.thinking).length > MAX_ITEMS)
      attributes['pi.telemetry.projection.truncated'] = true;
    for (const block of items(msg.thinking).slice(0, MAX_ITEMS))
      content('reasoning', record(block).content);
    content('reasoning', msg.reasoning_content);
    const blocks = items(msg.content ?? msg.parts ?? msg.summary).length
      ? items(msg.content ?? msg.parts ?? msg.summary)
      : items(record(msg.content).parts);
    if (blocks.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
    for (const raw of blocks.slice(0, MAX_ITEMS)) {
      const block = record(raw);
      if (typeof block.text === 'string') {
        if (block.thought === true || block.type === 'reasoning' || msg.type === 'reasoning')
          content('reasoning', block.text);
        else text.push(block.text);
      }
      if (block.type === 'thinking') content('reasoning', block.thinking);
      if (block.type === 'redacted_thinking') content('reasoning', '[redacted thinking]');
      if (block.type === 'image_url' || block.type === 'input_image')
        content('image', record(block.image_url).url ?? block.image_url);
      const source = record(block.source);
      if (block.type === 'image' && source.type === 'url') content('image', source.url);
      if (
        block.type === 'image' &&
        source.type === 'base64' &&
        typeof source.media_type === 'string' &&
        typeof source.data === 'string' &&
        isInlineImage(source.media_type, source.data)
      )
        content('image', `data:${source.media_type};base64,${source.data}`);
      const inline = record(block.inlineData);
      if (
        typeof inline.data === 'string' &&
        typeof inline.mimeType === 'string' &&
        isInlineImage(inline.mimeType, inline.data)
      )
        content('image', `data:${inline.mimeType};base64,${inline.data}`);
      if (['tool_use', 'toolCall', 'tool-call'].includes(String(block.type)) || block.functionCall)
        call(block);
    }
    if (text.length) {
      const joined = text.join('\n');
      set(`${prefix}.content`, joined);
      if (contentIndex) content('text', joined);
    }
    const calls = items(msg.tool_calls);
    if (calls.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
    for (const item of calls.slice(0, MAX_ITEMS)) call(item);
  }
  // Output and newest input get first claim on the budget.
  if (
    [...items(input), ...items(output)].some((value) => record(value).telemetryTruncated === true)
  )
    attributes['pi.telemetry.projection.truncated'] = true;
  const outputs = Array.isArray(output)
    ? output
    : [typeof output === 'string' ? { role: 'assistant', content: output } : output];
  if (outputs.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
  const expandedOutput = expandMessages(outputs.slice(-MAX_ITEMS), attributes);
  if (expandedOutput.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
  for (const [index, value] of expandedOutput.slice(-MAX_ITEMS).entries())
    message(`llm.output_messages.${index}.message`, value);
  const inputs = Array.isArray(input) ? input : [];
  if (inputs.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
  const expandedInput = expandMessages(inputs.slice(-MAX_ITEMS), attributes);
  if (expandedInput.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
  const selected = expandedInput.slice(-MAX_ITEMS);
  for (let index = selected.length - 1; index >= 0; index--)
    message(`llm.input_messages.${index}.message`, selected[index]);
  const tools: unknown[] = [];
  for (const value of inputs) {
    if (items(record(value).tools).length > MAX_ITEMS)
      attributes['pi.telemetry.projection.truncated'] = true;
    for (const raw of items(record(value).tools).slice(0, MAX_ITEMS)) {
      const tool = record(raw);
      const declarations = tool.functionDeclarations
        ? items(tool.functionDeclarations)
        : [tool.function ?? tool];
      if (declarations.length > MAX_ITEMS) attributes['pi.telemetry.projection.truncated'] = true;
      for (const declaration of declarations.slice(0, MAX_ITEMS)) {
        if (tools.length >= MAX_ITEMS) {
          attributes['pi.telemetry.projection.truncated'] = true;
          break;
        }
        const schema = record(declaration);
        tools.push(schema.input_schema ? { ...schema, parameters: schema.input_schema } : schema);
      }
    }
  }
  for (const [index, value] of tools.entries()) set(`llm.tools.${index}.tool.json_schema`, value);
}
