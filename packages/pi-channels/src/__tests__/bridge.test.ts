import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';

const mockSpawn = vi.fn();
const trustedRuntime = realpathSync.native(process.execPath);
const trustedCli = realpathSync.native(join(getPackageDir(), 'dist', 'cli.js'));
const temporaryDirectories = new Set<string>();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { ChatBridge } = await import('../bridge.js');

function createChild(stdoutText: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('close', exitCode);
  }, 0);
  return child;
}

function createPendingChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    setTimeout(() => child.emit('close', null), 0);
  });
  return child;
}

function createTemporaryImage(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'pi-channels-feishu-image-'));
  const path = join(directory, 'image');
  writeFileSync(path, 'fake-png');
  temporaryDirectories.add(directory);
  return { directory, path };
}

function sessionFileArg(call: unknown[] | undefined): string {
  const args = call?.[1] as string[] | undefined;
  const index = args?.indexOf('--session') ?? -1;
  return index >= 0 ? (args?.[index + 1] ?? '') : '';
}

describe('ChatBridge', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'MODEL',
      'DESKTOP_PORT',
      'PI_AGENT_WORKSPACE',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.clear();
  });

  test('runs pi prompt and sends reply with original metadata', async () => {
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: 'ping',
      metadata: { messageId: 'om_1', threadId: 'omt_1' },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      trustedRuntime,
      [
        trustedCli,
        '-p',
        '--offline',
        '--no-extensions',
        '--session',
        expect.stringMatching(/^\/workspace\/\.pi\/channel-sessions\/feishu-[0-9a-f]{24}\.jsonl$/),
        '来自即时通讯的用户消息：\nping',
      ],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenCalledWith({
        adapter: 'feishu',
        recipient: 'oc_chat',
        text: 'pong',
        metadata: { messageId: 'om_1', threadId: 'omt_1' },
      });
    });
  });

  it('passes image attachments to the Pi CLI as @file arguments', async () => {
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: '请看图',
      attachments: [{ type: 'image', path: '/tmp/feishu-image.png', mimeType: 'image/png' }],
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      trustedRuntime,
      [
        trustedCli,
        '-p',
        '--offline',
        '--no-extensions',
        '--session',
        expect.stringMatching(/^\/workspace\/\.pi\/channel-sessions\/feishu-[0-9a-f]{24}\.jsonl$/),
        '@/tmp/feishu-image.png',
        '来自即时通讯的用户消息：\n请看图',
      ],
      expect.objectContaining({ cwd: '/workspace' }),
    );
  });

  it('cleans Feishu temporary image attachments after the prompt finishes', async () => {
    const { directory: attachmentDir, path: imagePath } = createTemporaryImage();
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: '请看图',
      attachments: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
    });

    await vi.waitFor(() =>
      expect(registry.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'pong' })),
    );
    expect(existsSync(attachmentDir)).toBe(false);
  });

  it('forwards an image attachment when the message text is empty', async () => {
    const { directory: attachmentDir, path: imagePath } = createTemporaryImage();
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: '',
      attachments: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      trustedRuntime,
      [
        trustedCli,
        '-p',
        '--offline',
        '--no-extensions',
        '--session',
        expect.stringMatching(/^\/workspace\/\.pi\/channel-sessions\/feishu-[0-9a-f]{24}\.jsonl$/),
        `@${imagePath}`,
        '来自即时通讯的用户消息：\n',
      ],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    await vi.waitFor(() =>
      expect(registry.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'pong' })),
    );
    expect(existsSync(attachmentDir)).toBe(false);
  });

  it('cleans a rejected image attachment when the sender queue is full', async () => {
    const pendingChild = createPendingChild();
    mockSpawn.mockReturnValue(pendingChild);
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge(
      { enabled: true, maxConcurrent: 1, maxQueuePerSender: 1 },
      '/workspace',
      registry as never,
    );
    bridge.start();

    await bridge.handleMessage({ adapter: 'feishu', sender: 'oc_chat', text: 'first' });
    await bridge.handleMessage({ adapter: 'feishu', sender: 'oc_chat', text: 'queued' });
    const { directory, path } = createTemporaryImage();
    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: 'rejected',
      attachments: [{ type: 'image', path }],
    });

    expect(registry.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Queue full (1 pending). Wait or send /abort.' }),
    );
    expect(existsSync(directory)).toBe(false);
    bridge.stop();
  });

  it('cleans queued image attachments when the bridge stops', async () => {
    const pendingChild = createPendingChild();
    mockSpawn.mockReturnValue(pendingChild);
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge(
      { enabled: true, maxConcurrent: 1 },
      '/workspace',
      registry as never,
    );
    bridge.start();

    await bridge.handleMessage({ adapter: 'feishu', sender: 'oc_chat', text: 'first' });
    const { directory, path } = createTemporaryImage();
    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: 'queued',
      attachments: [{ type: 'image', path }],
    });

    bridge.stop();

    await vi.waitFor(() => expect(existsSync(directory)).toBe(false));
  });

  it('does not execute a project-local Pi binary discovered from cwd', async () => {
    const cwd = join(tmpdir(), `pi-channels-bridge-${process.pid}`);
    rmSync(cwd, { recursive: true, force: true });
    try {
      const localBin = join(cwd, 'node_modules', '.bin', 'pi');
      mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(localBin, '#!/bin/sh\n');
      mockSpawn.mockReturnValue(createChild('pong'));
      const registry = {
        getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
        send: vi.fn(() => Promise.resolve({ ok: true })),
      };
      const bridge = new ChatBridge({ enabled: true }, cwd, registry as never);
      bridge.start();

      await bridge.handleMessage({ adapter: 'feishu', sender: 'oc_chat', text: 'ping' });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      expect(mockSpawn.mock.calls[0]?.[0]).toBe(trustedRuntime);
      expect(mockSpawn.mock.calls[0]?.[1]?.[0]).toBe(trustedCli);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an explicit Pi binary inside a dot-prefixed workspace directory', async () => {
    const cwd = join(tmpdir(), `pi-channels-bridge-explicit-${process.pid}`);
    rmSync(cwd, { recursive: true, force: true });
    try {
      const localBin = join(cwd, '..trusted', 'pi');
      mkdirSync(join(cwd, '..trusted'), { recursive: true });
      writeFileSync(localBin, '#!/bin/sh\n');
      mockSpawn.mockReturnValue(createChild('pong'));
      const registry = {
        getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
        send: vi.fn(() => Promise.resolve({ ok: true })),
      };
      const bridge = new ChatBridge({ enabled: true, piBin: localBin }, cwd, registry as never);
      bridge.start();

      await bridge.handleMessage({ adapter: 'feishu', sender: 'oc_chat', text: 'ping' });
      await vi.waitFor(() => expect(registry.send).toHaveBeenCalled());

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(registry.send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('must be outside the workspace'),
        }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('registers the bridge provider when anthropic-compatible env is configured', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://credits.amaster.ai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('ANTHROPIC_MODEL', 'kimi-k2.5');
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: 'ping',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSpawn).toHaveBeenCalledWith(
      trustedRuntime,
      [
        trustedCli,
        '-p',
        '--offline',
        '--no-extensions',
        '--session',
        expect.stringMatching(/^\/workspace\/\.pi\/channel-sessions\/feishu-[0-9a-f]{24}\.jsonl$/),
        '-e',
        expect.stringContaining('bridge-provider.js'),
        '--provider',
        'anthropic-compatible',
        '--model',
        'kimi-k2.5',
        '来自即时通讯的用户消息：\nping',
      ],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenCalledWith({
        adapter: 'feishu',
        recipient: 'oc_chat',
        text: 'pong',
      });
    });
  });

  test('uses the same pi session file for multiple messages from the same channel session', async () => {
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'dingtalk',
      sender: 'cid_group',
      text: '第一句',
      metadata: { conversationId: 'cid_group' },
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));

    await bridge.handleMessage({
      adapter: 'dingtalk',
      sender: 'cid_group',
      text: '第二句',
      metadata: { conversationId: 'cid_group' },
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    const firstSessionFile = sessionFileArg(mockSpawn.mock.calls[0]);
    const secondSessionFile = sessionFileArg(mockSpawn.mock.calls[1]);
    expect(firstSessionFile).toMatch(
      /^\/workspace\/\.pi\/channel-sessions\/dingtalk-[0-9a-f]{24}\.jsonl$/,
    );
    expect(secondSessionFile).toBe(firstSessionFile);
  });

  test('persists channel turns to the local pi-agent session endpoint when available', async () => {
    vi.stubEnv('DESKTOP_PORT', '18146');
    vi.stubEnv('PI_AGENT_WORKSPACE', '/workspace');
    vi.stubEnv('ANTHROPIC_MODEL', 'kimi-k2.5');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://credits.amaster.ai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat:thread_1',
      text: 'ping',
      metadata: { chatId: 'oc_chat', chatName: '项目群' },
    });

    await vi.waitFor(() => {
      const channelCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === 'http://127.0.0.1:18146/internal/channel-sessions/turn',
      );
      expect(channelCalls.length).toBeGreaterThanOrEqual(2);
    });
    const channelCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === 'http://127.0.0.1:18146/internal/channel-sessions/turn',
    );
    for (const call of channelCalls) {
      expect(call[0]).toBe('http://127.0.0.1:18146/internal/channel-sessions/turn');
      expect(call[1]).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-pi-agent-internal': 'channel-bridge',
          }),
          body: expect.any(String),
        }),
      );
    }
    const started = JSON.parse(
      String(
        channelCalls.find((call) => String(call[1]?.body).includes('"phase":"started"'))?.[1]?.body,
      ),
    );
    expect(started).toMatchObject({
      phase: 'started',
      sessionId: 'oc_chat',
      conversationId: 'oc_chat',
      title: '飞书 / 项目群',
      adapter: 'feishu',
      recipient: 'oc_chat',
      userMessage: 'ping',
      workspaceDir: '/workspace',
    });
    expect(started).not.toHaveProperty('assistantMessage');
    const body = JSON.parse(
      String(
        channelCalls.find((call) => {
          const raw = String(call[1]?.body);
          return raw.includes('"phase":"completed"') && raw.includes('"assistantMessage":"pong"');
        })?.[1]?.body,
      ),
    );
    expect(body).toMatchObject({
      phase: 'completed',
      sessionId: 'oc_chat',
      conversationId: 'oc_chat',
      title: '飞书 / 项目群',
      adapter: 'feishu',
      recipient: 'oc_chat',
      userMessage: 'ping',
      assistantMessage: 'pong',
      workspaceDir: '/workspace',
      model: {
        provider: 'anthropic-compatible',
        model: 'kimi-k2.5',
      },
    });
  });

  test('acks WeCom messages before running the prompt and finishes with the final reply', async () => {
    mockSpawn.mockReturnValue(createChild('done'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'wecom',
      sender: 'wr_group:user_1',
      text: '@amaster 测试',
      metadata: {
        chatId: 'wr_group',
        replyToMessageId: 'msg_x',
        wecomReplyFrame: { headers: { req_id: 'req_x' } },
      },
    });

    expect(registry.send).toHaveBeenNthCalledWith(1, {
      adapter: 'wecom',
      recipient: 'wr_group:user_1',
      text: '收到，正在处理...',
      metadata: {
        chatId: 'wr_group',
        replyToMessageId: 'msg_x',
        wecomReplyFrame: { headers: { req_id: 'req_x' } },
        wecomReplyFinish: false,
      },
    });
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenNthCalledWith(2, {
        adapter: 'wecom',
        recipient: 'wr_group:user_1',
        text: 'done',
        metadata: {
          chatId: 'wr_group',
          replyToMessageId: 'msg_x',
          wecomReplyFrame: { headers: { req_id: 'req_x' } },
        },
      });
    });
  });

  test('acks DingTalk messages before running the prompt and finishes with the final reply', async () => {
    mockSpawn.mockReturnValue(createChild('done'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'dingtalk',
      sender: 'cid_group',
      text: '@amaster 测试',
      metadata: {
        conversationId: 'cid_group',
        replyToMessageId: 'msg_ding',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
        sessionWebhookExpiredTime: Date.now() + 60_000,
      },
    });

    expect(registry.send).toHaveBeenNthCalledWith(1, {
      adapter: 'dingtalk',
      recipient: 'cid_group',
      text: '收到，正在处理...',
      metadata: {
        conversationId: 'cid_group',
        replyToMessageId: 'msg_ding',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
        sessionWebhookExpiredTime: expect.any(Number),
      },
    });
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenNthCalledWith(2, {
        adapter: 'dingtalk',
        recipient: 'cid_group',
        text: 'done',
        metadata: {
          conversationId: 'cid_group',
          replyToMessageId: 'msg_ding',
          sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
          sessionWebhookExpiredTime: expect.any(Number),
        },
      });
    });
  });

  test('handles built-in /status without spawning pi', async () => {
    const registry = {
      getAdapter: vi.fn(),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: '/status',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: expect.stringContaining('Channel bridge status'),
    });
  });
});
