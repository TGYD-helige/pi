import { describe, expect, it } from 'vitest';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from '../tool-augment.js';

describe('augmentToolDescription', () => {
  it('appends hint for click tool', () => {
    const result = augmentToolDescription('click', 'Click an element.');
    expect(result).toContain('Click an element.');
    expect(result).toContain('uid');
  });

  it('appends hint for fill tool', () => {
    const result = augmentToolDescription('fill', 'Fill a field.');
    expect(result).toContain('canvas');
    expect(result).toContain('type_text');
    expect(result).not.toContain('press_key with individual characters');
  });

  it('appends hint for fill_form tool', () => {
    const result = augmentToolDescription('fill_form', 'Fill form fields.');
    expect(result).toContain('Same limitations as fill');
  });

  it('appends hint for press_key tool', () => {
    const result = augmentToolDescription('press_key', 'Press a key.');
    expect(result).toContain('SINGLE keyboard key');
  });

  it('appends hint for take_snapshot tool', () => {
    const result = augmentToolDescription('take_snapshot', 'Take snapshot.');
    expect(result).toContain('Call this FIRST');
  });

  it('appends hint for navigate_page tool', () => {
    const result = augmentToolDescription('navigate_page', 'Navigate.');
    expect(result).toContain('take_snapshot');
  });

  it('appends hint for new_page tool', () => {
    const result = augmentToolDescription('new_page', 'New page.');
    expect(result).toContain('take_snapshot');
  });

  it('appends hint for click_at tool', () => {
    const result = augmentToolDescription('click_at', 'Click at coordinates.');
    expect(result).toContain('pixel coordinates');
  });

  it('appends hint for hover tool', () => {
    const result = augmentToolDescription('hover', 'Hover over element.');
    expect(result).toContain('uid');
  });

  it('returns description unchanged for unknown tool', () => {
    const result = augmentToolDescription('unknown_tool', 'Some description.');
    expect(result).toBe('Some description.');
  });

  it('returns description unchanged for evaluate_script', () => {
    const result = augmentToolDescription('evaluate_script', 'Evaluate JS.');
    expect(result).toBe('Evaluate JS.');
  });
});

describe('postProcessToolResult', () => {
  it('strips embedded snapshot from non-snapshot tool', () => {
    const input = 'Action result\n## Latest page snapshot\n<tree>...</tree>';
    const result = postProcessToolResult('click', input);
    expect(result).toContain('Action result');
    expect(result).not.toContain('Latest page snapshot');
  });

  it('does NOT strip snapshot from take_snapshot result', () => {
    const input = 'Snapshot\n## Latest page snapshot\n<tree>...</tree>';
    const result = postProcessToolResult('take_snapshot', input);
    expect(result).toContain('Latest page snapshot');
  });

  it('appends overlay hint for click with overlay pattern', () => {
    const patterns = [
      'not interactable',
      'obscured',
      'intercept',
      'blocked',
      'element is not visible',
      'element not found',
    ];
    for (const pattern of patterns) {
      const result = postProcessToolResult('click', `Error: ${pattern}`);
      expect(result).toContain('overlay');
    }
  });

  it('does not append overlay hint for non-click tool', () => {
    const result = postProcessToolResult('fill', 'Error: not interactable');
    expect(result).not.toContain('overlay');
  });

  it('appends stale hint when result contains stale', () => {
    const result = postProcessToolResult('click', 'Error: stale element reference');
    expect(result).toContain('take_snapshot');
    expect(result).toContain('stale');
  });

  it('appends stale hint when result contains detached', () => {
    const result = postProcessToolResult('fill', 'Error: element is detached from DOM');
    expect(result).toContain('take_snapshot');
  });

  it('passes clean result through unchanged', () => {
    const input = 'Successfully clicked element uid="12_3"';
    const result = postProcessToolResult('click', input);
    expect(result).toBe(input);
  });

  it('click_at also gets overlay hint', () => {
    const result = postProcessToolResult('click_at', 'Error: element is not visible');
    expect(result).toContain('overlay');
  });

  it('both overlay and stale patterns trigger both hints', () => {
    const result = postProcessToolResult('click', 'Error: element is stale and not interactable');
    expect(result).toContain('overlay');
    expect(result).toContain('take_snapshot');
  });

  it('preserves original content when no patterns match', () => {
    const input = 'Navigated to https://example.com';
    const result = postProcessToolResult('navigate_page', input);
    expect(result).toBe(input);
  });

  it('strips only snapshot section, preserves preceding content', () => {
    const input = 'First line\nSecond line\n## Latest page snapshot\n<tree>big tree</tree>';
    const result = postProcessToolResult('fill', input);
    expect(result).toBe('First line\nSecond line');
  });
});

describe('extractTextContent', () => {
  it('extracts text from content array', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    expect(extractTextContent(content)).toBe('Hello\nWorld');
  });

  it('filters non-text items', () => {
    const content = [
      { type: 'image', text: undefined },
      { type: 'text', text: 'Only text' },
    ];
    expect(extractTextContent(content as { type: string; text?: string }[])).toBe('Only text');
  });

  it('returns empty string for undefined', () => {
    expect(extractTextContent(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextContent([])).toBe('');
  });
});
