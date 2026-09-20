export type AdapterDirection = 'outgoing' | 'incoming' | 'bidirectional';

export type ChannelPayloadMode = 'envelope' | 'raw';

export type ChannelMessage = {
  adapter: string;
  recipient: string;
  text?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  payloadMode?: ChannelPayloadMode;
  rawBody?: unknown;
  webhook?: {
    method?: string;
    contentType?: string;
  };
};

export type IncomingAttachment = {
  type: 'image' | 'document' | 'audio' | 'file';
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

export type IncomingMessage = {
  adapter: string;
  sender: string;
  text: string;
  attachments?: IncomingAttachment[];
  metadata?: Record<string, unknown>;
};

export type OnIncomingMessage = (message: IncomingMessage) => void | Promise<void>;

export type ChannelAdapter = {
  direction: AdapterDirection;
  send?(message: ChannelMessage, signal?: AbortSignal): Promise<void>;
  start?(onMessage: OnIncomingMessage): Promise<void>;
  stop?(): Promise<void>;
  sendTyping?(recipient: string): Promise<void>;
};

export type AdapterConfig = {
  type: string;
  [key: string]: unknown;
};

export type HttpIncomingConfig = {
  enabled?: boolean;
  host?: string;
  port?: number;
  path?: string;
};

export type FeishuAdapterConfig = AdapterConfig & {
  type: 'feishu';
  appId?: string;
  appSecret?: string;
  /**
   * Event transport. Defaults to websocket. Set "off" for outgoing-only use,
   * or "http" when the deployment already exposes an event callback endpoint.
   */
  eventMode?: 'websocket' | 'http' | 'off';
  appType?: 'self_build' | 'selfBuild' | 'SelfBuild' | 'isv' | 'ISV';
  domain?: 'feishu' | 'lark' | string;
  verificationToken?: string;
  encryptKey?: string;
  botOpenId?: string;
  receiveIdType?: 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';
  respondToMentionsOnly?: boolean;
  respondToMentionAll?: boolean;
  replyInThread?: boolean;
  ackReactionEmoji?: string | false;
  allowedChatIds?: string[];
  allowedSenderIds?: string[];
  dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
  dmAllowlist?: string[];
  loggerLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  handshakeTimeoutMs?: number;
  wsPingTimeoutSeconds?: number;
  incoming?: HttpIncomingConfig;
};

export type WeComAdapterConfig = AdapterConfig & {
  type: 'wecom';
  botId?: string;
  secret?: string;
  eventMode?: 'websocket' | 'off';
  timeoutMs?: number;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
  heartbeatInterval?: number;
  wsUrl?: string;
  respondToMentionsOnly?: boolean;
  allowedChatIds?: string[];
  allowedSenderIds?: string[];
};

export type DingTalkAdapterConfig = AdapterConfig & {
  type: 'dingtalk';
  clientId?: string;
  clientSecret?: string;
  robotCode?: string;
  eventMode?: 'stream' | 'off';
  respondToMentionsOnly?: boolean;
  allowedConversationIds?: string[];
  allowedSenderIds?: string[];
  keepAlive?: boolean;
  debug?: boolean;
  ua?: string;
  openApiBaseUrl?: string;
  tokenUrl?: string;
};

export type WebhookAdapterConfig = AdapterConfig & {
  type: 'webhook';
  method?: string;
  contentType?: string;
  payloadMode?: ChannelPayloadMode;
  secret?: string;
  headers?: Record<string, string>;
};

export type BridgeConfig = {
  enabled?: boolean;
  timeoutMs?: number;
  maxQueuePerSender?: number;
  maxConcurrent?: number;
  model?: string | null;
  provider?: string | null;
  piBin?: string;
  commands?: boolean;
  persistSessions?: boolean;
  apiBase?: string;
  env?: Record<string, string>;
  /** Extension sources (`-e`) the bridge child session may load. Empty/omitted keeps the child extension-free. */
  extensions?: string[];
};

export type ChannelRouteConfig = {
  adapter: string;
  recipient: string;
  name?: string;
  capture?: boolean;
};

export type ChannelConfig = {
  adapters?: Record<string, AdapterConfig>;
  routes?: Record<string, ChannelRouteConfig>;
  bridge?: BridgeConfig;
};

export type SendResult = {
  ok: boolean;
  error?: string;
};
