import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import piSecurityExtension, { authorizePiToolCall, resolvePiSecurityConfig } from '../extension.js';

const { loadPolicies, settings } = vi.hoisted(() => ({ loadPolicies: vi.fn(), settings: vi.fn() }));
vi.mock('@amaster.ai/pi-shared/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@amaster.ai/pi-shared/settings')>()),
  loadPiSettings: settings,
  loadPiSettingsAsync: settings,
}));
beforeEach(() => {
  loadPolicies.mockReset().mockResolvedValue({});
  settings.mockReset().mockReturnValue({});
});
vi.mock('../policy-loader.js', () => ({ loadFilePoliciesAsync: loadPolicies }));

describe('authorizePiToolCall', () => {
  it.each([
    { profile: 'full-access' },
    {
      profile: 'project-inline',
      security: {
        profiles: {
          'project-inline': {
            extends: 'full-access',
            defaultDecision: { kind: 'allow', reason: 'project setting' },
          },
        },
      },
    },
    { enabled: false },
  ])('revokes cached project inline settings %j', async (projectConfig) => {
    let trusted = true;
    settings.mockImplementation((_key, options) => (options.projectTrusted ? projectConfig : {}));
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
        handlers.set(name, handler),
      registerCommand: vi.fn(),
    };
    piSecurityExtension(pi as never);
    const ctx = {
      cwd: '/repo',
      hasUI: false,
      isProjectTrusted: () => trusted,
      sessionManager: { getSessionId: () => 'test' },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    };
    const event = {
      type: 'tool_call',
      toolCallId: 'test',
      toolName: 'write',
      input: { path: 'test.txt', content: 'hi' },
    };
    await handlers.get('session_start')!({}, ctx);
    expect(await handlers.get('tool_call')!(event, ctx)).toBeUndefined();
    trusted = false;
    expect(await handlers.get('tool_call')!(event, ctx)).toEqual(
      expect.objectContaining({ block: true }),
    );
  });

  it('discards inline permissions when trust is lost during the asynchronous policy read', async () => {
    let trusted = true;
    settings.mockImplementation((_key, options) =>
      options.projectTrusted ? { profile: 'full-access' } : {},
    );
    let finish!: (value: unknown) => void;
    loadPolicies
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue({});
    const ctx = {
      cwd: '/repo',
      hasUI: false,
      isProjectTrusted: () => trusted,
      sessionManager: { getSessionId: () => 'test' },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    const pending = authorizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: 'test',
        toolName: 'write',
        input: { path: 'test.txt', content: 'hi' },
      } as ToolCallEvent,
      ctx,
      {
        settingsBacked: true,
        config: resolvePiSecurityConfig({ profile: 'full-access' }),
        auditLog: [],
        grants: [],
      },
    );
    await vi.waitFor(() => expect(loadPolicies).toHaveBeenCalledTimes(1));
    trusted = false;
    finish({});
    expect((await pending)?.block).toBe(true);
    expect(settings).toHaveBeenLastCalledWith(
      'pi-security',
      expect.objectContaining({ projectTrusted: false }),
    );
  });

  it('does not let overlapping authorizations hide revocation of a project gate', async () => {
    let trusted = true;
    settings.mockImplementation((_key, options) =>
      options.projectTrusted ? { profile: 'full-access' } : {},
    );
    let first!: (value: unknown) => void;
    let second!: (value: unknown) => void;
    loadPolicies
      .mockReturnValueOnce(
        new Promise((resolve) => {
          first = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          second = resolve;
        }),
      );
    const ctx = {
      cwd: '/repo',
      hasUI: false,
      isProjectTrusted: () => trusted,
      sessionManager: { getSessionId: () => 'test' },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    const state = {
      settingsBacked: true,
      config: resolvePiSecurityConfig(),
      auditLog: [],
      grants: [],
    };
    const event = {
      type: 'tool_call',
      toolCallId: 'test',
      toolName: 'write',
      input: { path: 'test.txt', content: 'hi' },
    } as ToolCallEvent;
    const a = authorizePiToolCall(event, ctx, state);
    await vi.waitFor(() => expect(loadPolicies).toHaveBeenCalledTimes(1));
    trusted = false;
    const b = authorizePiToolCall({ ...event, toolCallId: 'other' }, ctx, state);
    await new Promise((resolve) => setImmediate(resolve));
    expect(loadPolicies).toHaveBeenCalledTimes(1);
    first({});
    await vi.waitFor(() => expect(loadPolicies).toHaveBeenCalledTimes(2));
    second({});
    expect((await a)?.block).toBe(true);
    expect((await b)?.block).toBe(true);
  });

  it('blocks tool execution if policy reading exceeds a limit', async () => {
    loadPolicies.mockRejectedValueOnce(new Error('Policy file count limit exceeded.'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ctx = {
        cwd: '/repo',
        hasUI: false,
        sessionManager: { getSessionId: () => 'test' },
      } as unknown as ExtensionContext;
      expect(
        (
          await authorizePiToolCall(
            {
              type: 'tool_call',
              toolCallId: 'test',
              toolName: 'write',
              input: { path: 'test.txt' },
            } as ToolCallEvent,
            ctx,
            {
              config: resolvePiSecurityConfig({ profile: 'full-access' }),
              auditLog: [],
              grants: [],
            },
          )
        )?.block,
      ).toBe(true);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

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
    await vi.waitFor(() =>
      expect(loadPolicies).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: true })),
    );
    trusted = false;
    finish({ 'auto-review': { defaultDecision: { kind: 'allow', reason: 'Project allows all' } } });
    expect((await result)?.block).toBe(true);
    expect(loadPolicies).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectTrusted: false }),
    );
  });
});
