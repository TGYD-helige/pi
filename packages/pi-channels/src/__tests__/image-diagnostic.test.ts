import { describe, expect, it, vi } from 'vitest';

const mockChatGet = vi.fn();
const mockRequest = vi.fn();
const mockMessageResourceGet = vi.fn();
const mockDownloadResource = vi.fn();
const mockChannelOn = vi.fn();
const mockChannelConnect = vi.fn();
const mockChannelDisconnect = vi.fn();
let channelHandlers = new Map<string, (...args: unknown[]) => unknown>();
let dispatcherHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
  Client: class MockClient {
    im = {
      chat: { get: mockChatGet },
      v1: { messageResource: { get: mockMessageResourceGet } },
    };
    request = mockRequest;
  },
  EventDispatcher: class MockEventDispatcher {
    register = vi.fn((handlers: Record<string, (...args: unknown[]) => unknown>) => {
      dispatcherHandlers = new Map(Object.entries(handlers));
      return this;
    });
  },
  adaptDefault: vi.fn(() => vi.fn()),
  createLarkChannel: vi.fn(() => ({
    on: mockChannelOn.mockImplementation(
      (name: string, handler: (...args: unknown[]) => unknown) => {
        channelHandlers.set(name, handler);
      },
    ),
    connect: mockChannelConnect,
    disconnect: mockChannelDisconnect,
    downloadResource: mockDownloadResource,
  })),
}));

const { createFeishuAdapter } = await import('../adapters/feishu.js');

const imageNormalizedMessage = {
  messageId: 'om_image_ws',
  chatId: 'oc_chat',
  chatType: 'group',
  senderId: 'ou_sender',
  content: '![image](img_v3_demo)',
  rawContentType: 'image',
  resources: [{ type: 'image', fileKey: 'img_v3_demo' }],
  mentions: [],
  mentionAll: false,
  mentionedBot: true,
  createTime: 1,
};

const imageRawEvent = {
  event_id: 'evt_image_http',
  sender: { sender_id: { open_id: 'ou_sender' } },
  message: {
    message_id: 'om_image_http',
    chat_id: 'oc_chat',
    chat_type: 'group',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v3_demo' }),
  },
};

describe('Feishu image diagnostic', () => {
  it('drops an SDK-normalized image before the websocket onMessage seam', async () => {
    channelHandlers = new Map();
    const onMessage = vi.fn();
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
    });

    await adapter.start?.(onMessage);
    await channelHandlers.get('message')?.(imageNormalizedMessage);

    expect(onMessage).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockMessageResourceGet).not.toHaveBeenCalled();
    expect(mockDownloadResource).not.toHaveBeenCalled();
    await adapter.stop?.();
  });

  it('drops an image raw event before the HTTP onMessage seam', async () => {
    dispatcherHandlers = new Map();
    const onMessage = vi.fn();
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'http',
      encryptKey: 'encrypt-me',
      incoming: { port: 0 },
    });

    await adapter.start?.(onMessage);
    await dispatcherHandlers.get('im.message.receive_v1')?.(imageRawEvent);

    expect(onMessage).not.toHaveBeenCalled();
    expect(mockMessageResourceGet).not.toHaveBeenCalled();
    expect(mockDownloadResource).not.toHaveBeenCalled();
    await adapter.stop?.();
  });
});
