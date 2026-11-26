import { ValidationError } from '@amaster.ai/pi-shared';
import type { DWClient, DWClientDownStream } from 'dingtalk-stream';
import type {
  AdapterConfig,
  ChannelAdapter,
  ChannelMessage,
  DingTalkAdapterConfig,
  OnIncomingMessage,
} from '../types.js';

type DingTalkStreamModule = typeof import('dingtalk-stream');

const DINGTALK_SEND_TIMEOUT_MS = 30_000;
const MAX_API_ERROR_MESSAGE_CHARS = 200;

type DingTalkEventMode = 'stream' | 'off';

type NormalizedDingTalkConfig = DingTalkAdapterConfig & {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  eventMode: DingTalkEventMode;
  openApiBaseUrl: string;
  tokenUrl: string;
};

type DingTalkRobotMessage = {
  conversationId?: string;
  conversationTitle?: string;
  chatbotCorpId?: string;
  chatbotUserId?: string;
  msgId?: string;
  senderNick?: string;
  isAdmin?: boolean;
  senderStaffId?: string;
  sessionWebhookExpiredTime?: number;
  createAt?: number;
  senderCorpId?: string;
  conversationType?: string;
  senderId?: string;
  sessionWebhook?: string;
  robotCode?: string;
  msgtype?: string;
  isInAtList?: boolean;
  text?: {
    content?: string;
  };
};

type DingTalkAccessTokenResponse = {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
};

type DingTalkApiErrorResponse = {
  code?: unknown;
  message?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
};

const DEFAULT_OPEN_API_BASE_URL = 'https://api.dingtalk.com';
const DEFAULT_TOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const DINGTALK_TEXT_MSG_KEY = 'sampleText';

function asConfig(config: AdapterConfig): DingTalkAdapterConfig {
  return config as DingTalkAdapterConfig;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`DingTalk adapter requires ${name}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeConfig(config: AdapterConfig): NormalizedDingTalkConfig {
  const cfg = asConfig(config);
  const clientId = requireString(cfg.clientId, 'clientId');
  return {
    ...cfg,
    clientId,
    clientSecret: requireString(cfg.clientSecret, 'clientSecret'),
    robotCode: optionalString(cfg.robotCode) ?? clientId,
    eventMode: cfg.eventMode === 'off' ? 'off' : 'stream',
    openApiBaseUrl: optionalString(cfg.openApiBaseUrl) ?? DEFAULT_OPEN_API_BASE_URL,
    tokenUrl: optionalString(cfg.tokenUrl) ?? DEFAULT_TOKEN_URL,
  };
}

function textFromMessage(message: ChannelMessage): string {
  if (!message.text)
    throw new ValidationError(
      'The request was rejected before sending. The DingTalk adapter requires text.',
    );
  return message.source ? `[${message.source}]\n${message.text}` : message.text;
}

function shouldAcceptMessage(body: DingTalkRobotMessage, cfg: NormalizedDingTalkConfig): boolean {
  const conversationId = body.conversationId ?? '';
  const allowedConversationIds = cfg.allowedConversationIds;
  if (
    conversationId &&
    Array.isArray(allowedConversationIds) &&
    allowedConversationIds.length > 0 &&
    !allowedConversationIds.includes(conversationId)
  ) {
    return false;
  }

  const senderId = body.senderId ?? body.senderStaffId ?? '';
  const allowedSenderIds = cfg.allowedSenderIds;
  if (
    senderId &&
    Array.isArray(allowedSenderIds) &&
    allowedSenderIds.length > 0 &&
    !allowedSenderIds.includes(senderId)
  ) {
    return false;
  }

  if (
    (cfg.respondToMentionsOnly ?? true) &&
    body.conversationType !== '1' &&
    body.isInAtList === false
  ) {
    return false;
  }

  return true;
}

function senderForMessage(body: DingTalkRobotMessage): string {
  return body.conversationId ?? body.senderId ?? body.senderStaffId ?? '';
}

function metadataFromMessage(body: DingTalkRobotMessage): Record<string, unknown> {
  return {
    messageId: body.msgId,
    replyToMessageId: body.msgId,
    conversationId: body.conversationId,
    chatId: body.conversationId,
    groupId: body.conversationId,
    conversationTitle: body.conversationTitle,
    chatName: body.conversationTitle,
    groupName: body.conversationTitle,
    conversationType: body.conversationType,
    senderId: body.senderId,
    senderStaffId: body.senderStaffId,
    senderNick: body.senderNick,
    senderName: body.senderNick,
    sessionWebhook: body.sessionWebhook,
    sessionWebhookExpiredTime: body.sessionWebhookExpiredTime,
    robotCode: body.robotCode,
    chatbotCorpId: body.chatbotCorpId,
    chatbotUserId: body.chatbotUserId,
    createAt: body.createAt,
    rawMsgtype: body.msgtype,
  };
}

function parseRobotMessage(downstream: DWClientDownStream): DingTalkRobotMessage | undefined {
  if (downstream.headers.topic !== '/v1.0/im/bot/messages/get') return undefined;
  try {
    const parsed = JSON.parse(downstream.data) as DingTalkRobotMessage;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sessionWebhookFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const value = metadata?.sessionWebhook;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sessionWebhookIsFresh(metadata: Record<string, unknown> | undefined): boolean {
  const value = metadata?.sessionWebhookExpiredTime;
  if (typeof value !== 'number' || !Number.isFinite(value)) return true;
  return value > Date.now();
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatDingTalkApiError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as DingTalkApiErrorResponse;
  const code = record.code ?? record.errcode;
  if (code === undefined || code === 0 || code === '0') return undefined;
  const message = String(record.message ?? record.errmsg ?? '').slice(
    0,
    MAX_API_ERROR_MESSAGE_CHARS,
  );
  return `DingTalk API error ${String(code)}${message ? `: ${message}` : ''}`;
}

function httpError(label: string, status: number, body: unknown): Error {
  return new Error(formatDingTalkApiError(body) ?? `DingTalk ${label} error ${status}`);
}

export function createDingTalkAdapter(
  config: AdapterConfig,
  context: {
    log?: (event: string, data?: Record<string, unknown>, level?: string) => void;
  } = {},
): ChannelAdapter {
  const cfg = normalizeConfig(config);
  let client: DWClient | null = null;
  let streamModulePromise: Promise<DingTalkStreamModule> | null = null;
  let accessToken:
    | {
        token: string;
        expiresAt: number;
      }
    | undefined;

  async function loadStreamModule(): Promise<DingTalkStreamModule> {
    streamModulePromise ??= import('dingtalk-stream');
    return streamModulePromise;
  }

  async function getAccessToken(signal: AbortSignal): Promise<string> {
    if (accessToken && accessToken.expiresAt > Date.now()) return accessToken.token;
    const url = new URL(cfg.tokenUrl);
    url.searchParams.set('appkey', cfg.clientId);
    url.searchParams.set('appsecret', cfg.clientSecret);
    const response = await fetch(url, { signal });
    const body = (await readJsonResponse(response)) as DingTalkAccessTokenResponse | undefined;
    if (!response.ok) throw httpError('token', response.status, body);
    if (body?.errcode && body.errcode !== 0) {
      throw httpError('token', response.status, body);
    }
    if (!body?.access_token) throw new Error('DingTalk token response missing access_token');
    const expiresIn = Number.isFinite(body.expires_in) ? Number(body.expires_in) : 7200;
    accessToken = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    };
    return accessToken.token;
  }

  async function sendViaSessionWebhook(
    url: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: text },
      }),
      signal,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) throw httpError('session webhook', response.status, body);
    const apiError = formatDingTalkApiError(body);
    if (apiError) throw new Error(apiError);
  }

  async function sendViaOpenApi(
    recipient: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const conversationId = recipient.trim();
    if (!conversationId)
      throw new ValidationError(
        'The request was rejected before sending. The DingTalk adapter requires a recipient.',
      );
    const token = await getAccessToken(signal);
    const response = await fetch(
      `${normalizeApiBaseUrl(cfg.openApiBaseUrl)}/v1.0/robot/groupMessages/send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          robotCode: cfg.robotCode,
          openConversationId: conversationId,
          msgKey: DINGTALK_TEXT_MSG_KEY,
          msgParam: JSON.stringify({ content: text }),
        }),
        signal,
      },
    );
    const body = await readJsonResponse(response);
    if (!response.ok) throw httpError('send', response.status, body);
    const apiError = formatDingTalkApiError(body);
    if (apiError) throw new Error(apiError);
  }

  async function sendText(message: ChannelMessage, signal?: AbortSignal): Promise<void> {
    const text = textFromMessage(message);
    // One deadline covers the token request, the send, and reading both bodies.
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(DINGTALK_SEND_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    const sessionWebhook = sessionWebhookFromMetadata(message.metadata);
    if (sessionWebhook && sessionWebhookIsFresh(message.metadata)) {
      await sendViaSessionWebhook(sessionWebhook, text, requestSignal);
      return;
    }
    await sendViaOpenApi(message.recipient, text, requestSignal);
  }

  async function start(onMessage: OnIncomingMessage): Promise<void> {
    if (cfg.eventMode === 'off') return;
    if (client) return;
    const stream = await loadStreamModule();
    client = new stream.DWClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      ...(cfg.ua ? { ua: cfg.ua } : { ua: 'amaster-pi-channels' }),
      ...(cfg.keepAlive !== undefined ? { keepAlive: cfg.keepAlive } : {}),
      ...(cfg.debug !== undefined ? { debug: cfg.debug } : {}),
    });
    client.registerCallbackListener(stream.TOPIC_ROBOT, (downstream: DWClientDownStream) => {
      try {
        const body = parseRobotMessage(downstream);
        if (!body) return;
        if (!shouldAcceptMessage(body, cfg)) return;
        if (body.msgtype !== 'text') return;
        const text = body.text?.content?.trim();
        const sender = senderForMessage(body);
        if (!text || !sender) return;
        void onMessage({
          adapter: 'dingtalk',
          sender,
          text,
          metadata: metadataFromMessage(body),
        });
      } finally {
        try {
          client?.socketCallBackResponse(downstream.headers.messageId, null);
        } catch (error) {
          context.log?.(
            'dingtalk-stream-ack-failed',
            { error: error instanceof Error ? error.message : String(error) },
            'WARN',
          );
        }
      }
    });
    await client.connect();
  }

  return {
    direction: cfg.eventMode === 'off' ? 'outgoing' : 'bidirectional',
    send: sendText,
    start,
    async stop(): Promise<void> {
      client?.disconnect();
      client = null;
    },
  };
}
