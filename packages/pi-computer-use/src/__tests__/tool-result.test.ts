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

  it.each([1996, 1997, 1998])('counts separators between text blocks after %i rows', (rows) => {
    const result = toPiToolResult({
      content: [
        { type: 'text', text: 'row\n'.repeat(rows) },
        { type: 'text', text: 'tail\n'.repeat(100) },
      ],
    });
    const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
    expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  });

  it.each([
    'browser_requires_setup',
    'browser_consent_required',
  ])('keeps vetted setup recovery for %s without raw payloads', (code) => {
    const result = toPiToolResult(
      {
        isError: true,
        content: [{ type: 'text', text: `${code}: test-token` }],
        structuredContent: {
          code,
          hint: 'test-token',
          detail: {
            next_call: {
              tool: 'browser_prepare',
              arguments: {
                pid: 123,
                window_id: 456,
                strategy: { kind: 'existing_profile', private: 'test-token' },
                session: 'test-token',
                allow_launch: true,
              },
            },
          },
        },
      },
      'get_browser_state',
    );
    expect(JSON.stringify(result)).toContain('browser_prepare');
    expect(JSON.stringify(result)).not.toContain('test-token');
    expect(result.details).toMatchObject({
      code,
      next_call: {
        tool: 'browser_prepare',
        arguments: { pid: 123, window_id: 456, strategy: { kind: 'existing_profile' } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('allow_launch');
  });

  it('reads a bounded JSON setup refusal while removing its private fields', () => {
    const payload = {
      error: {
        code: 'browser_requires_setup',
        detail: {
          next_call: {
            tool: 'browser_prepare',
            arguments: { pid: 1, window_id: 2, strategy: { kind: 'existing_profile' } },
          },
          private: 'test-token',
        },
      },
    };
    const result = toPiToolResult(
      { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] },
      'get_browser_state',
    );
    expect(result.details).toMatchObject({
      code: 'browser_requires_setup',
      next_call: { tool: 'browser_prepare' },
    });
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it('uses a fixed browser guide when suggested setup arguments are unsafe', () => {
    const result = toPiToolResult(
      {
        isError: true,
        content: [{ type: 'text', text: 'test-token' }],
        structuredContent: {
          code: 'browser_requires_setup',
          detail: {
            next_call: {
              tool: 'run_script',
              arguments: { pid: 'test-token', script: 'test-token' },
            },
          },
        },
      },
      'get_browser_state',
    );
    expect(result.details).toMatchObject({
      next_call: { tool: 'get_guide', arguments: { topic: 'browser' } },
    });
    expect(JSON.stringify(result)).not.toContain('test-token');
    expect(JSON.stringify(result)).not.toContain('run_script');
  });

  it('counts text block wrappers within the aggregate byte limit', () => {
    const result = toPiToolResult(
      {
        content: Array.from({ length: 1990 }, () => ({ type: 'text', text: 'x' })),
        structuredContent: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`field${i}`, 'x'.repeat(2500)]),
        ),
      },
      'get_config',
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  describe('model-visible enrichment', () => {
    it.each([
      false,
      true,
    ])('exposes action delivery and verification evidence with isError=%s', (isError) => {
      const structuredContent = {
        effect: 'unverifiable',
        delivery: { mode: 'background', delivered_count: 1 },
        evidence: [{ kind: 'value_readback', detail: 'Readback unavailable.' }],
        escalation: { target: 'page', reason: 'effect_unconfirmed' },
      };
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Action dispatched.' }],
          structuredContent,
          isError,
        },
        'type_text',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');

      expect(text).toContain('unverifiable');
      expect(text).toContain('"delivered_count":1');
      if (isError) expect(text).not.toContain('Readback unavailable.');
      else expect(text).toContain('Readback unavailable.');
      expect(text).toContain('effect_unconfirmed');
      if (isError)
        expect(result.details).toMatchObject({
          effect: 'unverifiable',
          delivery: { delivered_count: 1 },
        });
      else expect(result.details).toEqual(structuredContent);
      expect(Boolean(result.isError)).toBe(isError);
    });

    it('keeps action evidence bounded and visible after oversized driver text', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Action dispatched.\n'.repeat(8_000) }],
          structuredContent: {
            effect: 'partial',
            delivery: { mode: 'background', delivered_count: 1 },
            evidence: Array.from({ length: 2_000 }, () => ({
              kind: 'value_readback',
              detail: 'x'.repeat(200),
            })),
            hint: 'Read current state before repeating.',
          },
        },
        'type_text',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');

      expect(text).toContain('partial');
      expect(text).toContain('"delivered_count":1');
      expect(text).toContain('Read current state before repeating.');
      expect(text).toContain('evidence truncated');
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    });

    it('includes recovery guidance only once when enriching all structured fields', () => {
      const result = toPiToolResult(
        { structuredContent: { hint: 'Read the window again.' } },
        'verify_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text.match(/Read the window again\./g)).toHaveLength(1);
    });

    it.each([false, true])('exposes upstream recovery guidance with isError=%s', (isError) => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Action could not be confirmed.' }],
          structuredContent: {
            hint: 'Read the page before repeating the action.',
            next_call: {
              tool: 'get_browser_state',
              arguments: { target_id: 'bt-123', tab_id: 'tab-456' },
            },
          },
          isError,
        },
        'browser_select',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      if (isError) {
        expect(text).toContain('Read the current target state');
        expect(text).not.toContain('bt-123');
      } else {
        expect(text).toContain('Read the page before repeating the action.');
        expect(text).toContain('get_browser_state');
        expect(text).toContain('bt-123');
        expect(text).toContain('tab-456');
      }
    });

    it.each([
      {
        snapshot_id: 'p7',
        refs: [{ ref: 'p7:0', node: 'BUTTON', label: 'Pay', frame: 'main' }],
      },
      {
        snapshot: { id: 'p7', format: 'semantic_v2', complete: false, continuation: 'bc-next' },
        refs: [{ ref: 'p7:0', role: 'button', name: 'Pay', actions: ['click'] }],
        content_refs: [{ ref: 'p7:1', role: 'paragraph', name: 'Order summary' }],
        outline: 'Order summary: total 12.00',
      },
    ])('exposes browser snapshot references and semantic content: %j', (snapshot) => {
      const structuredContent = {
        status: 'ok',
        mode: 'snapshot',
        target_id: 'bt-123',
        tab_id: 'tab-456',
        ...snapshot,
      };
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'snapshot p7: 1 interactive element(s)' }],
          structuredContent,
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('tab-456');
      expect(text).toContain('p7:0');
      expect(text).toContain('Pay');
      if ('content_refs' in snapshot) {
        expect(text).toContain('p7:1');
        expect(text).toContain('Order summary: total 12.00');
        expect(text).toContain('bc-next');
      }
      expect(result.details).toEqual(structuredContent);
    });

    it.each([
      [
        'install_extension',
        {
          version: '0.2.1',
          target: 'aarch64-apple-darwin',
          trust: 'publisher-verified',
          license: 'LicenseRef-Mixed',
          download_size: 426075949,
          installed: false,
        },
        ['0.2.1', 'aarch64-apple-darwin', 'publisher-verified', 'LicenseRef-Mixed', '426075949'],
      ],
      [
        'browser_dialog',
        { present: true, dialog_id: 'dialog-12', kind: 'confirm' },
        ['dialog-12', 'confirm'],
      ],
      [
        'browser_prepare',
        {
          prepared_pid: 12345,
          attachment: { next_action: 'retry_browser_prepare', relaunch_required: true },
        },
        ['12345', 'retry_browser_prepare'],
      ],
      [
        'parse_visual_regions',
        {
          capture: {
            capture_id: 'capture-123',
            action_coordinate_space: { type: 'affine', m11: 0.5, m22: 0.5, tx: 4, ty: 8 },
          },
          regions: [
            {
              id: 'r1',
              kind: 'text',
              text: 'Submit',
              bounds: { x: 10, y: 20, width: 30, height: 40 },
            },
          ],
          warnings: ['low confidence'],
        },
        ['capture-123', 'Submit', 'bounds', 'action_coordinate_space', 'low confidence'],
      ],
      [
        'get_session',
        { session: 'checkout', state: 'active', expires_in_seconds: 120, recording_active: true },
        ['checkout', 'expires_in_seconds', 'recording_active'],
      ],
      [
        'get_session_state',
        { session: 'checkout', desktop_unlocked: false },
        ['checkout', 'desktop_unlocked', 'false'],
      ],
      [
        'list_sessions',
        { sessions: [{ session: 'checkout', state: 'active' }], next_cursor: 'o:1' },
        ['checkout', 'o:1'],
      ],
      [
        'get_config',
        { version: '0.34.0', max_image_dimension: 1560, agent_cursor: { enabled: false } },
        ['1560', 'agent_cursor', 'false'],
      ],
      [
        'get_agent_cursor_state',
        { enabled: false, theme: { id: 'my-theme' }, position: { x: 5, y: 8 } },
        ['my-theme', 'position', 'false'],
      ],
      [
        'verify_state',
        {
          status: 'unknown',
          stable: false,
          predicates: [{ index: 0, status: 'unknown', unknown_reason: 'stability_unproven' }],
        },
        ['stable', 'predicates', 'stability_unproven'],
      ],
    ] as const)('exposes structured results from %s', (toolName, structuredContent, expected) => {
      const result = toPiToolResult(
        { content: [{ type: 'text', text: 'Summary only.' }], structuredContent },
        toolName,
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      for (const value of expected) expect(text).toContain(value);
      expect(result.details).toEqual(structuredContent);
    });

    it('preserves opaque capabilities and all snapshot sections under large output', () => {
      const continuation = `bc-${'opaque'.repeat(100)}`;
      const structuredContent = {
        mode: 'snapshot',
        target_id: 'bt-123',
        tab_id: 'tab-456',
        snapshot: { id: 'p7', format: 'semantic_v2', complete: false, continuation },
        refs: Array.from({ length: 100 }, (_, index) => ({
          ref: `p7:${index}`,
          name: '界'.repeat(10_000),
          actions: ['click'],
        })),
        content_refs: [{ ref: 'p7:100', name: 'Article content' }],
        outline: 'Readable page text',
      };
      const result = toPiToolResult(
        {
          content: [
            { type: 'text', text: 'row\n'.repeat(4000) },
            { type: 'image', data: 'image-base64', mimeType: 'image/png' },
          ],
          structuredContent,
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      for (const value of [continuation, 'p7:0', 'p7:100', 'Readable page text', 'truncated'])
        expect(text).toContain(value);
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            ...result,
            content: result.content.filter((item) => item.type === 'text'),
          }),
        ),
      ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(result.content.some((item) => item.type === 'image')).toBe(true);
    });

    it('preserves visual transforms and later regions when OCR text is long', () => {
      const result = toPiToolResult(
        {
          structuredContent: {
            capture: {
              capture_id: 'capture-123',
              action_coordinate_space: { type: 'affine', m11: 0.5, m22: 0.5, tx: 4, ty: 8 },
            },
            regions: [
              {
                id: 'r1',
                text: '界'.repeat(10_000),
                bounds: { x: 10, y: 20, width: 30, height: 40 },
              },
              { id: 'r2', label: 'Submit', bounds: { x: 50, y: 60, width: 30, height: 40 } },
            ],
          },
        },
        'parse_visual_regions',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      for (const value of ['action_coordinate_space', '0.5', 'r1', 'r2', 'Submit', 'bounds'])
        expect(text).toContain(value);
    });

    it('warns against skipping locally omitted session records', () => {
      const result = toPiToolResult(
        {
          structuredContent: {
            next_cursor: 'o:100',
            sessions: Array.from({ length: 100 }, (_, index) => ({
              session: `session-${index}`,
              state: 'active',
            })),
          },
        },
        'list_sessions',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('o:100');
      expect(text).toContain('session-0');
      expect(text).toContain('smaller limit');
      expect(text).toContain('do not use next_cursor');
    });

    it('keeps structured fields visible when matching original text is truncated away', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: `${'row\n'.repeat(4000)}max_image_dimension:\n1560` }],
          structuredContent: { max_image_dimension: 1560 },
        },
        'get_config',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('1560');
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    });

    it('does not duplicate already visible JSON configuration', () => {
      const structuredContent = { max_image_dimension: 1560, agent_cursor: { enabled: false } };
      const text = `✅ ${JSON.stringify(structuredContent, null, 2)}`;
      const result = toPiToolResult(
        { content: [{ type: 'text', text }], structuredContent },
        'get_config',
      );
      expect(result.content).toEqual([{ type: 'text', text }]);
    });

    it('does not expose structured error diagnostics through new enrichment', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'Request refused.' }],
          isError: true,
          structuredContent: { raw: 'private diagnostic' },
        },
        'get_config',
      );
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Computer tool failed'),
      });
      expect(JSON.stringify(result)).not.toContain('private diagnostic');
      expect(result.isError).toBe(true);
    });

    it('exposes browser target and tab IDs from a bind response to the model', () => {
      const structuredContent = {
        status: 'ok',
        mode: 'bind',
        target_id: 'bt-123',
        tabs: [
          { tab_id: 'tab-456', title: 'Example', url: 'https://example.com', active: true },
          { tab_id: 'tab-789', title: 'Other', url: 'https://other.example', active: false },
        ],
      };
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'bound target bt-123 (exact) with 2 tab(s)' }],
          structuredContent,
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('target_id=bt-123');
      expect(text).toContain('tab_id=tab-456');
      expect(text).toContain('tab_id=tab-789');
      expect(text).toContain('https://example.com');
      expect(result.details).toEqual(structuredContent);
    });

    it('keeps later tab IDs visible when an earlier tab has a long title and URL', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'bound target bt-123' }],
          structuredContent: {
            target_id: 'bt-123',
            tabs: [
              { tab_id: 'tab-long', title: 'x'.repeat(10_000), url: 'y'.repeat(10_000) },
              { tab_id: 'tab-later', title: 'Example', url: 'https://example.com' },
            ],
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('tab_id=tab-long');
      expect(text).toContain('tab_id=tab-later');
    });

    it('does not duplicate browser IDs already included in driver text', () => {
      const text = 'target_id=bt-123 tab_id=tab-456';
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text }],
          structuredContent: { target_id: 'bt-123', tabs: [{ tab_id: 'tab-456' }] },
        },
        'get_browser_state',
      );
      expect(result.content).toEqual([{ type: 'text', text }]);
    });

    it('bounds large browser tab lists and ignores malformed tab records', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'bound target bt-123' }],
          structuredContent: {
            target_id: 'bt-123',
            tabs: [
              null,
              {},
              { tab_id: 42 },
              ...Array.from({ length: 200 }, (_, index) => ({
                tab_id: `tab-${index}`,
                title: 'Example'.repeat(30),
                url: 'https://example.com',
                active: index === 199,
              })),
            ],
          },
        },
        'get_browser_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('target_id=bt-123');
      expect(text).toContain('tab_id=tab-199');
      expect(text).not.toContain('tab_id=42');
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES,
      );
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    });

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

    it('does not report a missing tree for an unchanged incremental read', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'no change since s1' }],
          structuredContent: {
            snapshot_id: 's2',
            element_count: 10,
            tree_diff: 'no change since s1',
          },
        },
        'get_window_state',
      );
      expect(JSON.stringify(result.content)).not.toContain('AX tree is not in the text above');
    });

    it('does not report a missing tree when a large tree is fully retained', () => {
      const tree = Array.from({ length: 300 }, (_, i) => `- [${i}] AXButton`).join('\n');
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: tree }],
          structuredContent: { element_count: 300 },
        },
        'get_window_state',
      );
      const text = result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain('- [299] AXButton');
      expect(text).not.toContain('AX tree is not in the text above');
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

    it('surfaces degraded_reason without guessing a foreground recovery', () => {
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
      expect(text).toContain('get_guide');
      expect(text).not.toContain('bring_to_front');
      expect(text).not.toContain('delivery_mode');
    });

    it('does not suggest foreground actions when the screen is locked', () => {
      const result = toPiToolResult(
        {
          content: [{ type: 'text', text: 'window_id=7825 pid=9229 elements=0' }],
          structuredContent: { degraded: true, degraded_reason: 'screen_locked' },
        },
        'get_window_state',
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('screen_locked');
      expect(text).toContain('wake and unlock');
      expect(text).not.toContain('bring_to_front');
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
