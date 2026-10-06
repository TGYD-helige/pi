import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { toPiToolResult } from '../tool-result.js';

describe('toPiToolResult', () => {
  it('preserves text-only results when structured content is absent', () => {
    expect(
      toPiToolResult({ content: [{ type: 'text', text: 'Action executed with details.' }] })
        .content,
    ).toEqual([{ type: 'text', text: 'Action executed with details.' }]);
  });

  it('bounds text and structured elements without dropping image content', () => {
    const result = toPiToolResult({
      content: [
        { type: 'image', data: 'image-base64', mimeType: 'image/png' },
        { type: 'text', text: `${'tree row\n'.repeat(8_000)}` },
      ],
      structuredContent: {
        tree_markdown: 'tree row\n'.repeat(8_000),
        elements: Array.from({ length: 4_000 }, (_, index) => ({
          element_index: index,
          element_token: `token-${index}`,
          label: 'x'.repeat(40),
        })),
      },
    });

    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'image-base64',
      mimeType: 'image/png',
    });
    expect(result.content[1]?.type).toBe('text');
    expect((result.content[1] as { text: string }).text).toContain('truncated output');
    expect(result.details?.truncated).toBe(true);
    const boundedPayload = {
      content: result.content.filter((item) => item.type === 'text'),
      details: result.details,
    };
    expect(Buffer.byteLength(JSON.stringify(boundedPayload), 'utf8')).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
  });

  describe('model-visible enrichment', () => {
    it('exposes actual element tokens on their matching tree rows', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: '- [0] AXWindow "App"\n  - [7] AXButton "Save"' }],
          structuredContent: {
            elements: [
              { element_index: 0, element_token: 's00000001:0' },
              { element_index: 7, element_token: 's00000001:7' },
            ],
          },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('- [0] element_token=s00000001:0 AXWindow "App"');
      expect(text).toContain('  - [7] element_token=s00000001:7 AXButton "Save"');
    });

    it.each([
      'get_window_state',
      'get_desktop_state',
    ])('exposes the source capture ID from %s', (toolName) => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Screenshot captured.' }],
          structuredContent: { capture_id: 'capture-123' },
        },
        toolName,
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('capture_id=capture-123');
    });

    it('preserves snapshot addressing within the total line budget', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: Array(2000).fill('row').join('\n') }],
          structuredContent: { snapshot_id: 's00000001' },
        },
        'get_window_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(text).toContain('snapshot_id=s00000001');
      expect(text).toContain('truncated output');
    });

    it('appends snapshot_id with current token guidance when the driver text lacks it', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=8419 pid=47184 elements=2\n' }],
          structuredContent: { snapshot_id: 's0000000d', element_count: 2 },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('snapshot_id=s0000000d');
      expect(text).toContain('use element_token');
      expect(text).not.toContain('pair with element_index');
    });

    it('does not duplicate snapshot_id when the driver text already carries it', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'text',
              text: 'window_id=1234 pid=567 snapshot_id=s00000009 elements=148\n',
            },
          ],
          structuredContent: { snapshot_id: 's00000009', element_count: 148 },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text.match(/snapshot_id=s00000009/g)?.length).toBe(1);
    });

    it('surfaces degraded_reason with a recovery hint', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=7825 pid=9229 elements=0\n' }],
          structuredContent: {
            degraded: true,
            degraded_reason: 'off_space_or_ax_unresolved',
          },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('off_space_or_ax_unresolved');
      expect(text).toContain('bring_to_front');
      expect(text).not.toContain('delivery_mode');
    });

    it('hints max_elements when the tree is absent from text but elements exist', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'text',
              text: 'window_id=8160 pid=31271 size=1920x1080 elements=245\n\u26a0\ufe0f AX tree truncated at 2000 nodes\n',
            },
          ],
          structuredContent: { element_count: 245, elements: [{ element_index: 0 }] },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('max_elements');
    });

    it('does not hint max_elements when the tree is present in text', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'text',
              text: 'window_id=8419 pid=47184 elements=2\n- [0] AXWindow "Calculator"\n  - [1] AXButton\n',
            },
          ],
          structuredContent: { element_count: 2, elements: [{ element_index: 0 }] },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).not.toContain('max_elements');
    });

    it('hints max_elements when element_count is absent but elements exist', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=1 pid=1 elements=0\n' }],
          structuredContent: { elements: [{ element_index: 0 }] },
        },
        'get_window_state',
      );
      expect(result.content.map((c) => ('text' in c ? c.text : '')).join('\n')).toContain(
        'max_elements',
      );
    });

    it('adds no enrichment when windows is an empty array', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Found 0 window(s).' }],
          structuredContent: { windows: [] },
        },
        'list_windows',
      );
      expect(result.content).toEqual([{ type: 'text', text: 'Found 0 window(s).' }]);
    });

    it('renders list_windows records, on-screen first, capped at 20', () => {
      const windows = Array.from({ length: 30 }, (_, index) => ({
        window_id: 1000 + index,
        pid: 42,
        app_name: 'Google Chrome',
        title: `tab ${index}`,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        // First 25 are off-screen; last 5 are on-screen + current space.
        is_on_screen: index >= 25,
        on_current_space: index >= 25,
      }));
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Found 30 window(s).' }],
          structuredContent: { windows },
        },
        'list_windows',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('window_id=1025');
      expect(text).toContain('window_id=1029');
      expect(text).not.toContain('window_id=1015');
      expect(text).not.toContain('window_id=1024');
      expect(text.match(/window_id=/g)?.length).toBe(20);
    });

    it('passes through unchanged when structuredContent is null', () => {
      const result = toPiToolResult({ content: [{ type: 'text', text: 'plain' }] }, 'list_windows');
      expect(result.content).toEqual([{ type: 'text', text: 'plain' }]);
      expect(result.details).toBeUndefined();
    });

    it('does not throw on schema drift (windows not an array, unknown fields)', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Found 0 window(s).' }],
          structuredContent: { windows: 'oops', extra: { nested: true } },
        },
        'list_windows',
      );
      expect(result.content.map((c) => ('text' in c ? c.text : '')).join(' ')).toBe(
        'Found 0 window(s).',
      );
    });

    it('keeps enrichment within the result budget', () => {
      const result = toPiToolResult(
        {
          content: [
            {
              type: 'image',
              data: 'a'.repeat(30_000),
              mimeType: 'image/png',
            },
            { type: 'text', text: 'Found 30 window(s).' },
          ],
          structuredContent: {
            windows: Array.from({ length: 30 }, (_, index) => ({
              window_id: index + 1,
              pid: 1,
              app_name: 'A'.repeat(60),
              title: 'B'.repeat(120),
              bounds: { x: 0, y: 0, width: 1, height: 1 },
              is_on_screen: true,
              on_current_space: true,
            })),
          },
        },
        'list_windows',
      );
      const payload = {
        content: result.content,
        details: result.details,
      };
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES,
      );
    });
  });
});
