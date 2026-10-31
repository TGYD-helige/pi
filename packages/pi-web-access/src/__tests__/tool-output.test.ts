import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  boundText,
  fetchOutput,
  fetchOutputSchema,
  searchOutput,
  searchOutputSchema,
} from '../tool-output.js';

describe('tool-output', () => {
  it('retains a partial body line after short heading lines', () => {
    const result = boundText(`Heading\nSource\n\n${'fetch '.repeat(10000)}`, 1024);
    expect(result).toContain('fetch fetch');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
  });

  it('still bounds the number of lines', () => {
    const result = boundText('line\n'.repeat(1100));
    expect(result.split('\n').length).toBeLessThanOrEqual(1000);
    expect(result).toMatch(/^line\nline/);
  });

  it('retains long single-line search text rather than dropping each field', () => {
    const result = searchOutput({
      provider: 'provider',
      query: 'query',
      answer: 'answer '.repeat(1000),
      results: [
        {
          title: 'title '.repeat(100),
          url: 'https://example.com',
          content: 'snippet '.repeat(300),
        },
      ],
    });
    expect(result.answer).toMatch(/^answer /);
    expect(result.results[0]!.title).toMatch(/^title /);
    expect(result.results[0]!.content).toMatch(/^snippet /);
    expect(result.truncated).toBe(true);
  });
  it.each([
    '中文🙂'.repeat(1000),
    '\u0000"\\'.repeat(1000),
  ])('retains a valid prefix within serialized budgets', (text) => {
    const result = boundText(text, 100);
    expect(result.length).toBeGreaterThan(0);
    expect(text.startsWith(result)).toBe(true);
    expect(Buffer.from(result).toString('utf8')).toBe(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(100);
  });

  it('bounds escaped external results and keeps retained source URLs intact', () => {
    const url = 'https://example.com/source';
    const result = searchOutput({
      provider: 'provider',
      query: 'query',
      answer: '\u0000'.repeat(50000),
      results: Array.from({ length: 100 }, () => ({
        title: 'Title',
        url,
        content: '中文\u0000'.repeat(50000),
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.answer!.length).toBeGreaterThan(0);
    expect(result.results[0]!.content.startsWith('中文\u0000')).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((item) => item.url === url)).toBe(true);
    expect(Value.Check(searchOutputSchema, result)).toBe(true);
  });
  it('keeps source truncation visible after a short summary', () => {
    expect(
      fetchOutput({
        url: 'https://example.com',
        title: 'Title',
        content: 'Short summary',
        truncated: true,
      }).truncated,
    ).toBe(true);
  });

  it('bounds fetched data without changing the source URL', () => {
    const result = fetchOutput({
      url: 'https://example.com',
      title: 'Title',
      content: '\u0000'.repeat(50000),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.url).toBe('https://example.com');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
    expect(Value.Check(fetchOutputSchema, result)).toBe(true);
  });
});
