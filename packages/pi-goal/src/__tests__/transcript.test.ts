import { describe, expect, it } from 'vitest';
import { buildTranscript, buildTranscriptWithMeta, extractText } from '../transcript.js';

describe('extractText', () => {
  it('returns trimmed string content', () => {
    expect(extractText('  hello  ')).toBe('hello');
  });

  it('joins text blocks and ignores non-text blocks', () => {
    const content = [
      { type: 'text', text: 'line one' },
      { type: 'tool_use', name: 'read' },
      { type: 'text', text: 'line two' },
    ];
    expect(extractText(content)).toBe('line one\nline two');
  });

  it('returns empty string for unsupported content', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText(42)).toBe('');
  });
});

describe('buildTranscript', () => {
  it('formats messages with role tags, oldest first', () => {
    const messages = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'working on it' },
    ];
    expect(buildTranscript(messages, 1000)).toBe(
      '[user] do the thing\n\n[assistant] working on it',
    );
  });

  it('skips messages with no extractable text', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] },
    ];
    expect(buildTranscript(messages, 1000)).toBe('[user] hi');
  });

  it('caps by chars, keeping the newest messages', () => {
    const messages = [
      { role: 'user', content: 'AAAAAAAAAA' },
      { role: 'assistant', content: 'BBBBBBBBBB' },
      { role: 'user', content: 'CCCCCCCCCC' },
    ];
    // Small cap forces dropping the oldest; newest must survive.
    const out = buildTranscript(messages, 30);
    expect(out).toContain('CCCCCCCCCC');
    expect(out).not.toContain('AAAAAAAAAA');
  });

  it('bounds the newest message even when it alone exceeds the cap', () => {
    const messages = [{ role: 'user', content: 'X'.repeat(100) }];
    const result = buildTranscriptWithMeta(messages, 10);
    expect(result.text.length).toBe(10);
    expect(result.text).toContain('[user]');
    expect(result.omitted).toBe(1);
  });
});

describe('buildTranscriptWithMeta', () => {
  it('reports zero omitted when everything fits', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const result = buildTranscriptWithMeta(messages, 1000);
    expect(result.omitted).toBe(0);
    expect(result.text).toContain('[user] a');
  });

  it('counts text-bearing messages dropped by the cap', () => {
    const messages = [
      { role: 'user', content: 'AAAAAAAAAA' },
      { role: 'assistant', content: 'BBBBBBBBBB' },
      { role: 'user', content: 'CCCCCCCCCC' },
    ];
    const result = buildTranscriptWithMeta(messages, 30);
    // Newest survives; at least one older text message is dropped.
    expect(result.text).toContain('CCCCCCCCCC');
    expect(result.omitted).toBeGreaterThan(0);
  });

  it('includes separators in the budget', () => {
    const result = buildTranscriptWithMeta(
      [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
      16,
    );
    expect(result.text.length).toBeLessThanOrEqual(16);
    expect(result.omitted).toBe(1);
  });

  it('does not count text-less messages as omitted', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] },
      { role: 'user', content: 'hi' },
    ];
    const result = buildTranscriptWithMeta(messages, 1000);
    expect(result.omitted).toBe(0);
  });
});
