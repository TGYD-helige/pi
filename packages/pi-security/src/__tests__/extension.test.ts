import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import piSecurityExtension, {
  authorizePiToolCall,
  type PiSecurityExtensionState,
  resolvePiSecurityConfig,
} from '../extension.js';

describe('pi security extension', () => {
  it('resolves conservative extension defaults', () => {
    expect(resolvePiSecurityConfig()).toEqual({
      enabled: true,
      profile: 'auto-review',
      auditLimit: 200,
      allowSessionGrants: true,
    });
  });

  it('blocks denied approvals before a Pi tool executes', async () => {
    const { handlers } = registerExtension();
    const ctx = createContext({ select: vi.fn(async () => 'Deny') });

    const result = (await handlers.tool_call?.[0]?.(writeEvent('tool-1'), ctx)) as
      | ToolCallEventResult
      | undefined;

    expect(result).toEqual({
      block: true,
      reason:
        '[tool_call_blocked] The tool did not execute. User denied approval: Workspace file modifications require approval.',
    });
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });

  it('supports in-session approval grants for similar tool calls', async () => {
    const { handlers } = registerExtension();
    const select = vi.fn(async () => 'Allow similar for this session');
    const ctx = createContext({ select });

    await expect(handlers.tool_call?.[0]?.(writeEvent('tool-1'), ctx)).resolves.toBeUndefined();
    await expect(handlers.tool_call?.[0]?.(writeEvent('tool-2'), ctx)).resolves.toBeUndefined();

    expect(select).toHaveBeenCalledOnce();
  });

  it('does not reuse a session grant when security-relevant arguments change', async () => {
    const { handlers } = registerExtension();
    const select = vi
      .fn()
      .mockResolvedValueOnce('Allow similar for this session')
      .mockResolvedValueOnce('Deny');
    const ctx = createContext({ select });

    await expect(
      handlers.tool_call?.[0]?.(writeEvent('tool-1', 'approval.txt'), ctx),
    ).resolves.toBeUndefined();
    const changed = (await handlers.tool_call?.[0]?.(
      writeEvent('tool-2', 'different.txt'),
      ctx,
    )) as ToolCallEventResult;

    expect(changed.block).toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a session grant when an approved path symlink is retargeted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-security-grant-'));
    const firstTarget = await mkdtemp(join(tmpdir(), 'pi-security-target-a-'));
    const secondTarget = await mkdtemp(join(tmpdir(), 'pi-security-target-b-'));
    const link = join(cwd, 'linked');
    try {
      await symlink(firstTarget, link, 'dir');
      const { handlers } = registerExtension();
      const select = vi
        .fn()
        .mockResolvedValueOnce('Allow similar for this session')
        .mockResolvedValueOnce('Deny');
      const ctx = createContext({ cwd, select });

      await expect(
        handlers.tool_call?.[0]?.(writeEvent('tool-1', 'linked/file.txt'), ctx),
      ).resolves.toBeUndefined();
      await unlink(link);
      await symlink(secondTarget, link, 'dir');
      const changed = (await handlers.tool_call?.[0]?.(
        writeEvent('tool-2', 'linked/file.txt'),
        ctx,
      )) as ToolCallEventResult;

      expect(changed.block).toBe(true);
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(firstTarget, { recursive: true, force: true });
      await rm(secondTarget, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'path array',
      toolName: 'mcp__filesystem__read_multiple_files',
      input: { paths: ['linked/file.txt'] },
    },
    {
      label: 'browser file array alias',
      toolName: 'mcp__cua__browser_set_input_files',
      input: { files: ['linked/upload.txt'] },
    },
    {
      label: 'camelCase path alias',
      toolName: 'image_generate',
      input: { outputDir: 'linked' },
    },
    {
      label: 'video frame path alias',
      toolName: 'video_generate',
      input: {
        firstFrame: 'linked/frame.png',
        lastFrame: 'linked/tail.png',
        referenceImages: ['linked/reference.png'],
      },
    },
    {
      label: 'snake_case image path alias',
      toolName: 'mcp__cua__set_cursor_style',
      input: { image_path: 'linked/cursor.png' },
    },
    {
      label: 'filesystem move path aliases',
      toolName: 'mcp__filesystem__move_file',
      input: { source: 'linked/source.txt', destination: 'linked/destination.txt' },
    },
    {
      label: 'singular file path alias',
      toolName: 'mcp__filesystem__upload_file',
      input: { file: 'linked/upload.txt' },
    },
    {
      label: 'target path alias',
      toolName: 'mcp__filesystem__copy_file',
      input: { target: 'linked/copy.txt' },
    },
  ])('does not reuse a session grant when a $label symlink is retargeted', async (testCase) => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-security-grant-array-'));
    const firstTarget = await mkdtemp(join(tmpdir(), 'pi-security-target-array-a-'));
    const secondTarget = await mkdtemp(join(tmpdir(), 'pi-security-target-array-b-'));
    const link = join(cwd, 'linked');
    try {
      await symlink(firstTarget, link, 'dir');
      const select = vi
        .fn()
        .mockResolvedValueOnce('Allow similar for this session')
        .mockResolvedValueOnce('Deny');
      const ctx = createContext({ cwd, select });
      const state: PiSecurityExtensionState = {
        config: {
          enabled: true,
          profile: 'grant-test',
          security: {
            profiles: {
              'grant-test': {
                defaultDecision: { kind: 'ask', reason: 'Test approval required.' },
              },
            },
          },
          auditLimit: 200,
          allowSessionGrants: true,
        },
        auditLog: [],
        grants: [],
      };
      const event = (toolCallId: string): ToolCallEvent =>
        ({
          type: 'tool_call',
          toolCallId,
          toolName: testCase.toolName,
          input: testCase.input,
        }) as ToolCallEvent;

      await expect(authorizePiToolCall(event('tool-1'), ctx, state)).resolves.toBeUndefined();
      await unlink(link);
      await symlink(secondTarget, link, 'dir');
      const changed = await authorizePiToolCall(event('tool-2'), ctx, state);

      expect(changed?.block).toBe(true);
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(firstTarget, { recursive: true, force: true });
      await rm(secondTarget, { recursive: true, force: true });
    }
  });

  it('fails closed for non-interactive approvals', async () => {
    const { handlers } = registerExtension();
    const ctx = createContext({ hasUI: false });

    const result = (await handlers.tool_call?.[0]?.(writeEvent('tool-1'), ctx)) as
      | ToolCallEventResult
      | undefined;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('non-interactive');
  });

  it('registers user-facing commands but no LLM-callable tools', () => {
    const { pi } = registerExtension();

    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).toHaveBeenCalledWith('pi-security-status', expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith('pi-security-audit', expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith('pi-security-reset', expect.any(Object));
  });
});

function registerExtension(): {
  pi: ExtensionAPI & {
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
  };
  handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
} {
  const handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>> = {};
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers[event] ??= [];
      handlers[event]?.push(handler);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as ExtensionAPI & {
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
  };

  piSecurityExtension(pi);
  return { pi, handlers };
}

function createContext(
  options: {
    hasUI?: boolean;
    cwd?: string;
    select?: ReturnType<typeof vi.fn>;
    confirm?: ReturnType<typeof vi.fn>;
  } = {},
): ExtensionContext {
  return {
    cwd: options.cwd ?? '/repo',
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getSessionId: () => 'session-1',
    },
    model: {
      provider: 'test',
      id: 'test-model',
    },
    ui: {
      select: options.select ?? vi.fn(async () => 'Allow once'),
      confirm: options.confirm ?? vi.fn(async () => true),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function writeEvent(toolCallId: string, path = 'approval.txt'): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId,
    toolName: 'write',
    input: { path, content: 'hello' },
  } as ToolCallEvent;
}
