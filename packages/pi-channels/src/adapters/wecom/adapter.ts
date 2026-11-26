import { ValidationError } from '@amaster.ai/pi-shared';
import {
  type TextMessage,
  WSClient,
  type WSClientOptions,
  type WsFrame,
} from '@wecom/aibot-node-sdk';
import type {
  AdapterConfig,
  ChannelAdapter,
  ChannelMessage,
  OnIncomingMessage,
  WeComAdapterConfig,
} from '../../types.js';

type WeComEventMode = 'websocket' | 'off';

type NormalizedWeComBotConfig = WeComAdapterConfig & {
  botId: string;
  secret: string;
  eventMode: WeComEventMode;
  timeoutMs: number;
};

type WeComReplyFrame = Pick<WsFrame<TextMessage>, 'headers'>;

function asConfig(config: AdapterConfig): WeComAdapterConfig {
  return config as WeComAdapterConfig;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`WeCom adapter requires ${name}`);
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function normalizeConfig(config: AdapterConfig): NormalizedWeComBotConfig {
  const cfg = asConfig(config);
  return {
    ...cfg,
    botId: requireString(cfg.botId, 'botId'),
    secret: requireString(cfg.secret, 'secret'),
    eventMode: cfg.eventMode === 'off' ? 'off' : 'websocket',
    timeoutMs: optionalNumber(cfg.timeoutMs) ?? 15_000,
  };
}

function createSdkLogger(
  log: ((event: string, data?: Record<string, unknown>, level?: string) => void) | undefined,
) {
  const emit = (level: string, message: unknown, args: unknown[]) => {
    log?.('wecom-sdk', { message: [message, ...args].map(String).join(' ') }, level);
  };
  return {
    debug: (message: unknown, ...args: unknown[]) => emit('DEBUG', message, args),
    info: (message: unknown, ...args: unknown[]) => emit('INFO', message, args),
    warn: (message: unknown, ...args: unknown[]) => emit('WARN', message, args),
    error: (message: unknown, ...args: unknown[]) => emit('ERROR', message, args),
  };
}

function textFromMessage(message: ChannelMessage): string {
  if (!message.text)
    throw new ValidationError(
      'The request was rejected before sending. The WeCom adapter requires text.',
    );
  return message.source ? `[${message.source}]\n${message.text}` : message.text;
}

function senderForMessage(body: TextMessage): string {
  const senderId = body.from?.userid ?? '';
  return body.chattype === 'group' && body.chatid ? `${body.chatid}:${senderId}` : senderId;
}

function shouldAcceptMessage(body: TextMessage, cfg: NormalizedWeComBotConfig): boolean {
  const allowedChatIds = cfg.allowedChatIds;
  if (
    body.chattype === 'group' &&
    body.chatid &&
    Array.isArray(allowedChatIds) &&
    allowedChatIds.length > 0 &&
    !allowedChatIds.includes(body.chatid)
  ) {
    return false;
  }

  const senderId = body.from?.userid ?? '';
  const allowedSenderIds = cfg.allowedSenderIds;
  if (
    senderId &&
    Array.isArray(allowedSenderIds) &&
    allowedSenderIds.length > 0 &&
    !allowedSenderIds.includes(senderId)
  ) {
    return false;
  }

  return true;
}

function frameMetadata(frame: WsFrame<TextMessage>, body: TextMessage): Record<string, unknown> {
  return {
    messageId: body.msgid,
    replyToMessageId: body.msgid,
    botId: body.aibotid,
    chatId: body.chatid,
    groupId: body.chatid,
    chatType: body.chattype,
    senderId: body.from?.userid,
    createTime: body.create_time,
    responseUrl: body.response_url,
    wecomReplyFrame: {
      headers: frame.headers,
    },
    headers: frame.headers,
  };
}

function replyFrameFromMetadata(
  metadata: Record<string, unknown> | undefined,
): WeComReplyFrame | undefined {
  const value = metadata?.wecomReplyFrame;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers = (value as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  return { headers: headers as WeComReplyFrame['headers'] };
}

function replyStreamId(message: ChannelMessage): string {
  const metadata = message.metadata ?? {};
  const messageId = typeof metadata.replyToMessageId === 'string' ? metadata.replyToMessageId : '';
  if (messageId.trim()) return `amaster-${messageId.trim()}`;
  return `amaster-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function replyFinishFromMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.wecomReplyFinish !== false;
}

function normalizeWeComError(error: Error): Error {
  if (error.message.includes('853000') || /invalid bot_?id or secret/i.test(error.message)) {
    return new Error(
      '企业微信智能机器人认证失败：请确认 Bot ID 和 Secret 来自同一个“智能机器人 API 模式 / 长连接”配置。Secret 不是回调 Token、EncodingAESKey，也不是自建应用 Secret。',
    );
  }
  return error;
}

export function createWeComAdapter(
  config: AdapterConfig,
  context: {
    log?: (event: string, data?: Record<string, unknown>, level?: string) => void;
  } = {},
): ChannelAdapter {
  const cfg = normalizeConfig(config);
  const clientOptions: WSClientOptions = {
    botId: cfg.botId,
    secret: cfg.secret,
    requestTimeout: cfg.timeoutMs,
    logger: createSdkLogger(context.log),
  };
  const reconnectInterval = optionalNumber(cfg.reconnectInterval);
  if (reconnectInterval !== undefined) clientOptions.reconnectInterval = reconnectInterval;
  const maxReconnectAttempts = optionalNumber(cfg.maxReconnectAttempts);
  if (maxReconnectAttempts !== undefined) clientOptions.maxReconnectAttempts = maxReconnectAttempts;
  const maxAuthFailureAttempts = optionalNumber(cfg.maxAuthFailureAttempts);
  if (maxAuthFailureAttempts !== undefined) {
    clientOptions.maxAuthFailureAttempts = maxAuthFailureAttempts;
  }
  const heartbeatInterval = optionalNumber(cfg.heartbeatInterval);
  if (heartbeatInterval !== undefined) clientOptions.heartbeatInterval = heartbeatInterval;
  if (typeof cfg.wsUrl === 'string' && cfg.wsUrl.trim()) clientOptions.wsUrl = cfg.wsUrl.trim();

  const client = new WSClient(clientOptions);

  let authenticated = false;
  let connectPromise: Promise<void> | null = null;
  let started = false;

  client.on('authenticated', () => {
    authenticated = true;
    context.log?.('wecom-authenticated', { botId: cfg.botId });
  });
  client.on('disconnected', (reason) => {
    authenticated = false;
    context.log?.('wecom-disconnected', { reason }, 'WARN');
  });
  client.on('event.disconnected_event', () => {
    authenticated = false;
    context.log?.(
      'wecom-server-disconnected',
      { error: '企业微信长连接已被新的机器人连接顶下线，请停止其他同 Bot ID 的连接后重新连接。' },
      'ERROR',
    );
  });
  client.on('reconnecting', (attempt) => {
    authenticated = false;
    context.log?.('wecom-reconnecting', { attempt }, 'WARN');
  });
  client.on('error', (error) => {
    context.log?.('wecom-client-error', { error: normalizeWeComError(error).message }, 'ERROR');
  });

  async function ensureConnected(): Promise<void> {
    if (client.isConnected && authenticated) return;
    if (connectPromise) return connectPromise;

    connectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('WeCom bot authentication timed out'));
      }, cfg.timeoutMs);
      const onAuthenticated = () => {
        cleanup();
        authenticated = true;
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(normalizeWeComError(error));
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.off('authenticated', onAuthenticated);
        client.off('error', onError);
        connectPromise = null;
      };
      client.on('authenticated', onAuthenticated);
      client.on('error', onError);
      client.connect();
    });

    return connectPromise;
  }

  async function sendText(message: ChannelMessage): Promise<void> {
    const text = textFromMessage(message);
    await ensureConnected();
    const replyFrame = replyFrameFromMetadata(message.metadata);
    if (replyFrame) {
      await client.replyStream(
        replyFrame,
        replyStreamId(message),
        text,
        replyFinishFromMetadata(message.metadata),
      );
      return;
    }
    await client.sendMessage(message.recipient, {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  }

  async function start(onMessage: OnIncomingMessage): Promise<void> {
    if (cfg.eventMode === 'off') return;
    if (started) {
      await ensureConnected();
      return;
    }
    started = true;
    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      const body = frame.body;
      if (!body) return;
      if (!shouldAcceptMessage(body, cfg)) return;
      const text = body.text?.content?.trim();
      if (!text) return;
      void onMessage({
        adapter: 'wecom',
        sender: senderForMessage(body),
        text,
        metadata: frameMetadata(frame, body),
      });
    });
    await ensureConnected();
  }

  return {
    direction: cfg.eventMode === 'off' ? 'outgoing' : 'bidirectional',
    send: sendText,
    start,
    async stop(): Promise<void> {
      started = false;
      authenticated = false;
      connectPromise = null;
      client.disconnect();
    },
  };
}
