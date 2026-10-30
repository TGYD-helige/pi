import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertModelPhase } from './browser-session-model-e2e.mjs';

const fixture = { phase: 'resume', url: 'about:blank#unique-test', script: '() => ({ marker: globalThis.marker, ticks: globalThis.ticks })', marker: 'hidden-nonce' };
function trace() {
  let id = 0;
  const events = [];
  const tool = (toolName, args, output) => {
    const toolCallId = String(++id);
    events.push({ type: 'tool_execution_start', toolName, toolCallId, args });
    events.push({ type: 'tool_execution_end', toolName, toolCallId, result: { content: [{ type: 'text', text: output }] } });
  };
  tool('browser_session', { action: 'status' }, '{"state":"retained","resumed":true}');
  tool('browser_list_pages', {}, '2: about:blank#unique-test');
  tool('browser_evaluate_script', { pageId: 2, function: fixture.script }, '```json\n{"marker":"hidden-nonce","ticks":37}\n```');
  tool('browser_session', { action: 'release' }, '{"state":"active","resumed":true}');
  return events;
}

test('accepts real tool-backed continuation and release evidence', () => {
  assert.deepEqual(assertModelPhase(trace(), fixture), { phase: 'resume', markerMatched: true, ticks: 37, toolCalls: 4 });
});

test('rejects assistant claims without tool evidence', () => {
  assert.throws(() => assertModelPhase([{ type: 'message_end', message: { content: [{ type: 'text', text: 'Everything passed' }] } }], fixture), /execute tools/);
});

test('reports only allowlisted tool names and error categories', () => {
  const events = trace();
  events[5].isError = true;
  events[5].result.content[0].text = 'Connection closed wss://private.example/?token=secret';
  assert.throws(() => assertModelPhase(events, fixture), error => error.message === 'Browser tool failed: browser_evaluate_script (connect, closed)');
});

test('rejects replaced pages, stopped polling, fake evaluation scripts, missing release and provider errors', () => {
  for (const mutate of [
    events => { events[5].result.content[0].text = '```json\n{"marker":"replacement","ticks":37}\n```'; },
    events => { events[5].result.content[0].text = '```json\n{"marker":"hidden-nonce","ticks":0}\n```'; },
    events => { events[4].args.function = '() => ({ marker: "hidden-nonce", ticks: 37 })'; },
    events => { events.splice(-2); },
    events => { events[5].isError = true; },
    events => { events.push({ type: 'message_end', message: { stopReason: 'error' } }); },
  ]) {
    const events = trace();
    mutate(events);
    assert.throws(() => assertModelPhase(events, fixture));
  }
});
