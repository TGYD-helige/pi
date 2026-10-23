import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockChatGet = vi.fn();
const mockRequest = vi.fn();
const mockMessageResourceGet = vi.fn();
const mockDownloadResource = vi.fn();
const mockChannelOn = vi.fn();
const mockChannelConnect = vi.fn();
const mockChannelDisconnect = vi.fn();
let channelHandlers = new Map<string, (...args: unknown[]) => unknown>();
let dispatcherHandlers = new Map<string, (...args: unknown[]) => unknown>();
const temporaryDirectories = new Set<string>();

function trackAttachments(message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const attachments = (message as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue;
    const path = (attachment as { path?: unknown }).path;
    if (typeof path === 'string') temporaryDirectories.add(dirname(path));
  }
}

vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => ({
  normalize: (await importOriginal<typeof import('@larksuiteoapi/node-sdk')>()).normalize,
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

  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
    temporaryDirectories.clear();
  });

  it('downloads an SDK-normalized image and forwards it as an attachment', async () => {
    const onMessage = vi.fn(trackAttachments);
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
    await adapter.stop?.();
  });

  it('downloads an HTTP image event and forwards it as an attachment', async () => {
    const onMessage = vi.fn(trackAttachments);
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
    await adapter.stop?.();
  });

  it.each([
    0, 1, 2,
  ])('forwards post text with %i embedded image attachments', async (imageCount) => {
    const imageKeys = ['img_v3_first', 'img_v3_second'].slice(0, imageCount);
    const message = {
      ...postNormalizedMessage,
      content: ['**Post**', 'hello', ...imageKeys.map((key) => `![image](${key})`)].join('\n'),
      resources: [
        ...imageKeys.map((fileKey) => ({ type: 'image', fileKey })),
        { type: 'file', fileKey: 'file_not_an_image' },
        { type: 'image', fileKey: '' },
      ],
    };
    const onMessage = vi.fn(trackAttachments);
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
    });

    await adapter.start?.(onMessage);
    await channelHandlers.get('message')?.(message);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: message.content }));
    const emitted = onMessage.mock.calls[0]?.[0] as {
      attachments?: Array<{ path: string; type: string; mimeType?: string; size?: number }>;
    };
    expect(emitted.attachments ?? []).toHaveLength(imageCount);
    expect(mockMessageResourceGet).toHaveBeenCalledTimes(imageCount);
    for (const [index, fileKey] of imageKeys.entries()) {
      expect(mockMessageResourceGet).toHaveBeenNthCalledWith(index + 1, {
        path: { message_id: message.messageId, file_key: fileKey },
        params: { type: 'image' },
      });
      expect(emitted.attachments?.[index]).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        size: 8,
      });
      expect(await readFile(emitted.attachments![index]!.path)).toEqual(Buffer.from('fake-png'));
    }
    await adapter.stop?.();
  });
  it.each([
    0, 1,
  ])('preserves caption and successful images when image %i fails', async (failedIndex) => {
    if (failedIndex === 1)
      mockMessageResourceGet.mockResolvedValueOnce({
        getReadableStream: () => Readable.from([Buffer.from('fake-png')]),
        headers: { 'content-type': 'image/png' },
      });
    mockMessageResourceGet.mockRejectedValueOnce(new Error('secret response body'));
    const onMessage = vi.fn(trackAttachments);
    const log = vi.fn();
    const adapter = createFeishuAdapter(
      {
        type: 'feishu',
        appId: 'cli_xxx',
        appSecret: 'secret',
        eventMode: 'websocket',
      },
      { log },
    );
    await adapter.start?.(onMessage);
    try {
      await channelHandlers.get('message')?.({
        ...postNormalizedMessage,
        resources: [
          { type: 'image', fileKey: 'bad' },
          { type: 'image', fileKey: 'good' },
        ],
      });
      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
      expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
        text: expect.stringContaining('hello'),
        attachments: [expect.objectContaining({ type: 'image' })],
      });
      expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
        text: expect.stringContaining(
          '[Some images could not be downloaded. Ask the sender to resend them.]',
        ),
      });
      expect(log).toHaveBeenCalledWith(
        'feishu-image-download-failed',
        { messageId: 'om_post_ws' },
        'ERROR',
      );
      const emitted = onMessage.mock.calls[0]?.[0] as { attachments: Array<{ path: string }> };
      expect(await readFile(emitted.attachments[0]!.path)).toEqual(Buffer.from('fake-png'));
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret response body');
    } finally {
      await adapter.stop?.();
    }
  });

  it.each([
    false,
    true,
  ])('downloads HTTP post images (localized=%s) and preserves metadata', async (localized) => {
    const onMessage = vi.fn(trackAttachments);
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'http',
      encryptKey: 'encrypt-me',
      incoming: { port: 0 },
      botOpenId: 'ou_bot',
    });
    const post = {
      title: 'Caption',
      content: [
        [
          { tag: 'at', user_id: 'ou_bot' },
          { tag: 'text', text: ' inspect these' },
          { tag: 'img', image_key: 'img_one' },
          { tag: 'img', image_key: 'img_two' },
        ],
      ],
    };
    await adapter.start?.(onMessage);
    try {
      await dispatcherHandlers.get('im.message.receive_v1')?.({
        ...imageRawEvent,
        message: {
          ...imageRawEvent.message,
          message_type: 'post',
          content: JSON.stringify(localized ? { zh_cn: post } : post),
          thread_id: 'thread',
          root_id: 'root',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }],
        },
      });
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
        sender: 'oc_chat:thread',
        text: expect.stringContaining('inspect these'),
        attachments: [
          expect.objectContaining({ type: 'image' }),
          expect.objectContaining({ type: 'image' }),
        ],
        metadata: {
          eventId: 'evt_image_http',
          messageId: 'om_image_http',
          threadId: 'thread',
          rootId: 'root',
          senderId: { open_id: 'ou_sender' },
        },
      });
      expect(mockMessageResourceGet).toHaveBeenNthCalledWith(1, {
        path: { message_id: 'om_image_http', file_key: 'img_one' },
        params: { type: 'image' },
      });
      expect(mockMessageResourceGet).toHaveBeenNthCalledWith(2, {
        path: { message_id: 'om_image_http', file_key: 'img_two' },
        params: { type: 'image' },
      });
    } finally {
      await adapter.stop?.();
    }
  });

  it.each([
    'websocket',
    'http',
  ] as const)('logs unsupported messages without leaking content in %s mode', async (eventMode) => {
    const onMessage = vi.fn();
    const log = vi.fn();
    const adapter = createFeishuAdapter(
      {
        type: 'feishu',
        appId: 'cli_xxx',
        appSecret: 'secret',
        eventMode,
        encryptKey: 'encrypt-me',
        incoming: { port: 0 },
      },
      { log },
    );
    await adapter.start?.(onMessage);
    try {
      if (eventMode === 'websocket') {
        await channelHandlers.get('message')?.({
          ...postNormalizedMessage,
          rawContentType: 'audio',
          content: 'private audio',
        });
      } else {
        await dispatcherHandlers.get('im.message.receive_v1')?.({
          ...imageRawEvent,
          message: { ...imageRawEvent.message, message_type: 'audio', content: 'private audio' },
        });
      }
      expect(log).toHaveBeenCalledWith(
        'feishu-message-type-unsupported',
        { messageId: eventMode === 'websocket' ? 'om_post_ws' : 'om_image_http' },
        'ERROR',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private audio');
      expect(onMessage).not.toHaveBeenCalled();
      expect(mockMessageResourceGet).not.toHaveBeenCalled();
    } finally {
      await adapter.stop?.();
    }
  });
  it.each([
    'websocket',
    'http',
  ] as const)('delivers an explicit failure note when all images fail in %s mode', async (eventMode) => {
    mockMessageResourceGet.mockRejectedValue(new Error('private response'));
    const onMessage = vi.fn(trackAttachments);
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode,
      encryptKey: 'encrypt-me',
      incoming: { port: 0 },
    });
    await adapter.start?.(onMessage);
    try {
      if (eventMode === 'websocket') await channelHandlers.get('message')?.(imageNormalizedMessage);
      else await dispatcherHandlers.get('im.message.receive_v1')?.(imageRawEvent);
      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
      expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
        text: expect.stringContaining('Some images could not be downloaded'),
      });
      expect(onMessage.mock.calls[0]?.[0]).not.toHaveProperty('attachments');
      expect(JSON.stringify(onMessage.mock.calls)).not.toContain('private response');
    } finally {
      await adapter.stop?.();
    }
  });

  it.each([
    'mention',
    'chat',
    'sender',
  ] as const)('rejects HTTP posts before downloading when blocked by %s policy', async (policy) => {
    const onMessage = vi.fn();
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'http',
      encryptKey: 'encrypt-me',
      incoming: { port: 0 },
      ...(policy === 'mention' ? { botOpenId: 'ou_bot' } : {}),
      ...(policy === 'chat' ? { allowedChatIds: ['other'] } : {}),
      ...(policy === 'sender' ? { allowedSenderIds: ['other'] } : {}),
    });
    await adapter.start?.(onMessage);
    try {
      await dispatcherHandlers.get('im.message.receive_v1')?.({
        ...imageRawEvent,
        message: {
          ...imageRawEvent.message,
          message_type: 'post',
          content: JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_one' }]] }),
        },
      });
      expect(onMessage).not.toHaveBeenCalled();
      expect(mockMessageResourceGet).not.toHaveBeenCalled();
    } finally {
      await adapter.stop?.();
    }
  });
});
