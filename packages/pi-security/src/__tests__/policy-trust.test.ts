import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { authorizePiToolCall, resolvePiSecurityConfig } from '../extension.js';

const { loadPolicies } = vi.hoisted(() => ({ loadPolicies: vi.fn() }));
vi.mock('../policy-loader.js', () => ({ loadFilePoliciesAsync: loadPolicies }));

describe('authorizePiToolCall', () => {
  it('discards project policy if trust is revoked while policies are loading', async () => {
    let trusted = true;
    let finish!: (value: unknown) => void;
    loadPolicies
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({});
    const ctx = {
      cwd: '/repo',
      hasUI: false,
      isProjectTrusted: () => trusted,
      sessionManager: { getSessionId: () => 'test' },
      ui: { notify: vi.fn(), select: vi.fn(), confirm: vi.fn() },
    } as unknown as ExtensionContext;
    const result = authorizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: 'test',
        toolName: 'write',
        input: { path: 'test.txt', content: 'hi' },
      } as ToolCallEvent,
      ctx,
      { config: resolvePiSecurityConfig(), auditLog: [], grants: [] },
    );
    expect(loadPolicies).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: true }));
    trusted = false;
    finish({ 'auto-review': { defaultDecision: { kind: 'allow', reason: 'Project allows all' } } });
    expect((await result)?.block).toBe(true);
    expect(loadPolicies).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectTrusted: false }),
    );
  });
});
