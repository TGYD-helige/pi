import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const postNormalizedMessage = {
  messageId: 'om_post_ws',
  chatId: 'oc_chat',
  chatType: 'group',
  senderId: 'ou_sender',
  content: '**Post**\n\nhello\n![image](img_v3_demo)',
  rawContentType: 'post',
  resources: [{ type: 'image', fileKey: 'img_v3_demo' }],
  mentions: [],
  mentionAll: false,
  mentionedBot: true,
  createTime: 1,
};

describe('Feishu adapter', () => {
  beforeEach(() => {
    channelHandlers = new Map();
    dispatcherHandlers = new Map();
    mockMessageResourceGet.mockReset();
    mockMessageResourceGet.mockResolvedValue({
      getReadableStream: () => Readable.from([Buffer.from('fake-png')]),
      headers: { 'content-type': 'image/png' },
    });
    mockDownloadResource.mockReset();
    mockRequest.mockReset();
  });

  it('downloads an SDK-normalized image and forwards it as an attachment', async () => {
    const onMessage = vi.fn();
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
    });

    await adapter.start?.(onMessage);
    await channelHandlers.get('message')?.(imageNormalizedMessage);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    const emitted = onMessage.mock.calls[0]?.[0] as {
      attachments?: Array<{ path: string; type: string; mimeType?: string; size?: number }>;
    };
    expect(emitted.attachments).toHaveLength(1);
    expect(emitted.attachments?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      size: 8,
    });
    expect(await readFile(emitted.attachments![0]!.path)).toEqual(Buffer.from('fake-png'));
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: { message_id: 'om_image_ws', file_key: 'img_v3_demo' },
      params: { type: 'image' },
    });
    expect(mockDownloadResource).not.toHaveBeenCalled();
    await rm(dirname(emitted.attachments![0]!.path), { recursive: true, force: true });
    await adapter.stop?.();
  });

  it('downloads an HTTP image event and forwards it as an attachment', async () => {
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

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    const emitted = onMessage.mock.calls[0]?.[0] as {
      attachments?: Array<{ path: string; type: string; mimeType?: string; size?: number }>;
    };
    expect(emitted.attachments).toHaveLength(1);
    expect(emitted.attachments?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      size: 8,
    });
    expect(await readFile(emitted.attachments![0]!.path)).toEqual(Buffer.from('fake-png'));
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: { message_id: 'om_image_http', file_key: 'img_v3_demo' },
      params: { type: 'image' },
    });
    expect(mockDownloadResource).not.toHaveBeenCalled();
    await rm(dirname(emitted.attachments![0]!.path), { recursive: true, force: true });
    await adapter.stop?.();
  });

  it('keeps post messages as text without downloading embedded images', async () => {
    const onMessage = vi.fn();
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
    });

    await adapter.start?.(onMessage);
    await channelHandlers.get('message')?.(postNormalizedMessage);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: postNormalizedMessage.content }),
    );
    expect(onMessage.mock.calls[0]?.[0]).not.toHaveProperty('attachments');
    expect(mockMessageResourceGet).not.toHaveBeenCalled();
    await adapter.stop?.();
  });
});
