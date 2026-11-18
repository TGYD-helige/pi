import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (value: unknown) => void;

const mock = vi.hoisted(() => {
  const clients: FakeDWClient[] = [];

  class FakeDWClient {
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Listener>();
    readonly acks: Array<{ messageId: string; result: unknown }> = [];
    connectCount = 0;
    disconnectCount = 0;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      clients.push(this);
    }

    registerCallbackListener(topic: string, listener: Listener): this {
      this.listeners.set(topic, listener);
      return this;
    }

    async connect(): Promise<void> {
      this.connectCount += 1;
    }

    disconnect(): void {
      this.disconnectCount += 1;
    }

    socketCallBackResponse(messageId: string, result: unknown): void {
      this.acks.push({ messageId, result });
    }
  }

  return { clients, FakeDWClient };
});

vi.mock('dingtalk-stream', () => ({
  DWClient: mock.FakeDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

const { createDingTalkAdapter } = await import('../adapters/dingtalk.js');

describe('DingTalk adapter', () => {
  beforeEach(() => {
    mock.clients.length = 0;
    vi.unstubAllGlobals();
  });

  it('starts the Stream client and emits accepted incoming text messages', async () => {
    const adapter = createDingTalkAdapter({
      type: 'dingtalk',
      clientId: 'ding_client',
      clientSecret: 'secret',
      eventMode: 'stream',
      allowedConversationIds: ['cid_group'],
    });
    const incoming = vi.fn();

    await adapter.start?.(incoming);

    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0]!.options).toMatchObject({
      clientId: 'ding_client',
      clientSecret: 'secret',
      ua: 'amaster-pi-channels',
    });
    expect(mock.clients[0]!.connectCount).toBe(1);

    mock.clients[0]!.listeners.get('/v1.0/im/bot/messages/get')?.({
      headers: {
        topic: '/v1.0/im/bot/messages/get',
        messageId: 'stream_msg_1',
      },
      data: JSON.stringify({
        conversationId: 'cid_group',
        conversationTitle: '钉钉运营',
        conversationType: '2',
        isInAtList: true,
        msgId: 'msg_ding',
        senderId: 'sender_open',
        senderStaffId: 'staff_1',
        senderNick: 'Ada',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
        sessionWebhookExpiredTime: Date.now() + 60_000,
        robotCode: 'robot_x',
        msgtype: 'text',
        text: { content: ' 帮我看一下 ' },
      }),
    });

    expect(incoming).toHaveBeenCalledWith({
      adapter: 'dingtalk',
      sender: 'cid_group',
      text: '帮我看一下',
      metadata: expect.objectContaining({
        messageId: 'msg_ding',
        replyToMessageId: 'msg_ding',
        conversationId: 'cid_group',
        chatId: 'cid_group',
        chatName: '钉钉运营',
        senderId: 'sender_open',
        senderStaffId: 'staff_1',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
        robotCode: 'robot_x',
      }),
    });
    expect(mock.clients[0]!.acks).toEqual([{ messageId: 'stream_msg_1', result: null }]);
  });

  it('replies through sessionWebhook metadata when available', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errcode: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createDingTalkAdapter({
      type: 'dingtalk',
      clientId: 'ding_client',
      clientSecret: 'secret',
      eventMode: 'off',
    });

    await adapter.send?.({
      adapter: 'dingtalk',
      recipient: 'cid_group',
      text: '收到',
      source: 'unit',
      metadata: {
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
        sessionWebhookExpiredTime: Date.now() + 60_000,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: '[unit]\n收到' },
        }),
      }),
    );
  });

  it('sends active group messages through DingTalk OpenAPI', async () => {
    const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
      const value = String(url);
      if (value.startsWith('https://oapi.dingtalk.com/gettoken')) {
        return new Response(
          JSON.stringify({ errcode: 0, access_token: 'token_x', expires_in: 7200 }),
        );
      }
      if (value === 'https://api.dingtalk.com/v1.0/robot/groupMessages/send') {
        return new Response(JSON.stringify({ processQueryKey: 'query_x' }));
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createDingTalkAdapter({
      type: 'dingtalk',
      clientId: 'ding_client',
      clientSecret: 'secret',
      robotCode: 'robot_x',
      eventMode: 'off',
    });

    await adapter.send?.({
      adapter: 'dingtalk',
      recipient: 'cid_group',
      text: 'hello',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('appkey=ding_client');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('appsecret=secret');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'x-acs-dingtalk-access-token': 'token_x',
      }),
      body: JSON.stringify({
        robotCode: 'robot_x',
        openConversationId: 'cid_group',
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: 'hello' }),
      }),
    });
  });

  it('passes one cancellable deadline to the token and send requests', async () => {
    const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) =>
      String(url).includes('gettoken')
        ? new Response(JSON.stringify({ errcode: 0, access_token: 'token_x' }))
        : new Response(JSON.stringify({ processQueryKey: 'query_x' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createDingTalkAdapter({
      type: 'dingtalk',
      clientId: 'ding_client',
      clientSecret: 'secret',
      robotCode: 'robot_x',
      eventMode: 'off',
    });
    const controller = new AbortController();

    await adapter.send?.({ adapter: 'dingtalk', recipient: 'cid', text: 'hi' }, controller.signal);

    const signals = fetchMock.mock.calls.map((call) => call[1]?.signal);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
    expect(signals[0]?.aborted).toBe(false);
    controller.abort();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('reports API errors without echoing raw response bodies', async () => {
    const longMessage = 'x'.repeat(5_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'Forbidden', message: longMessage, extra: 'raw' }), {
            status: 403,
          }),
      ),
    );
    const adapter = createDingTalkAdapter({
      type: 'dingtalk',
      clientId: 'ding_client',
      clientSecret: 'secret',
      eventMode: 'off',
    });
    const send = adapter.send?.({
      adapter: 'dingtalk',
      recipient: 'cid',
      text: 'hi',
      metadata: {
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
        sessionWebhookExpiredTime: Date.now() + 60_000,
      },
    });

    const error = await send?.then(
      () => undefined,
      (reason: Error) => reason,
    );
    expect(error?.message).toMatch(/^DingTalk API error Forbidden: x+$/);
    expect(error?.message.length).toBeLessThan(300);
    expect(error?.message).not.toContain('raw');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway secret page</html>', { status: 502 })),
    );
    await expect(
      adapter.send?.({
        adapter: 'dingtalk',
        recipient: 'cid',
        text: 'hi',
        metadata: {
          sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
          sessionWebhookExpiredTime: Date.now() + 60_000,
        },
      }),
    ).rejects.toThrow(/^DingTalk session webhook error 502$/);
  });
});
