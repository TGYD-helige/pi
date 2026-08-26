import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import type { ChannelRegistry } from './registry.js';
import type { BridgeConfig, IncomingAttachment, IncomingMessage } from './types.js';

type BridgeRunResult = {
  ok: boolean;
  response: string;
  error?: string;
};

type QueuedMessage = {
  id: string;
  message: IncomingMessage;
};

type SessionState = {
  queue: QueuedMessage[];
  processing: boolean;
  abortController: AbortController | undefined;
};

const DEFAULTS: Required<BridgeConfig> = {
  enabled: false,
  timeoutMs: 300_000,
  maxQueuePerSender: 5,
  maxConcurrent: 2,
  model: null as string | null,
  provider: null as string | null,
  piBin: '',
  commands: true,
  persistSessions: true,
  apiBase: '',
  env: {},
};

let idCounter = 0;

export class ChatBridge {
  private config: Required<BridgeConfig>;
  private cwd: string;
  private registry: ChannelRegistry;
  private running = false;
  private activeCount = 0;
  private sessions = new Map<string, SessionState>();

  constructor(config: BridgeConfig | undefined, cwd: string, registry: ChannelRegistry) {
    this.config = { ...DEFAULTS, ...(config ?? {}) };
    this.cwd = cwd;
    this.registry = registry;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const session of this.sessions.values()) session.abortController?.abort();
    this.sessions.clear();
    this.activeCount = 0;
  }

  isActive(): boolean {
    return this.running;
  }

  stats(): { active: boolean; sessions: number; activePrompts: number; queued: number } {
    let queued = 0;
    for (const session of this.sessions.values()) queued += session.queue.length;
    return {
      active: this.running,
      sessions: this.sessions.size,
      activePrompts: this.activeCount,
      queued,
    };
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    if (!this.running) return;
    const text = message.text.trim();
    if (!text && !message.attachments?.some((attachment) => attachment.type === 'image')) return;

    const senderKey = `${message.adapter}:${message.sender}`;
    const builtInReply = this.handleBuiltInCommand(senderKey, text);
    if (builtInReply !== null) {
      await this.registry.send({
        adapter: message.adapter,
        recipient: message.sender,
        text: builtInReply,
        ...(message.metadata ? { metadata: message.metadata } : {}),
      });
      return;
    }

    const session = this.getSession(senderKey);
    if (session.queue.length >= this.config.maxQueuePerSender) {
      await this.registry.send({
        adapter: message.adapter,
        recipient: message.sender,
        text: `Queue full (${this.config.maxQueuePerSender} pending). Wait or send /abort.`,
        ...(message.metadata ? { metadata: message.metadata } : {}),
      });
      return;
    }

    session.queue.push({ id: `msg-${Date.now()}-${++idCounter}`, message });
    void persistChannelTurnStarted({
      apiBase: this.config.apiBase,
      enabled: this.config.persistSessions,
      cwd: this.cwd,
      message,
    });
    await this.sendProcessingAck(message);
    void this.processNext(senderKey);
  }

  private async sendProcessingAck(message: IncomingMessage): Promise<void> {
    if (!shouldSendProcessingAck(message)) return;
    const metadata =
      message.adapter === 'wecom'
        ? {
            ...message.metadata,
            wecomReplyFinish: false,
          }
        : message.metadata;
    await this.registry
      .send({
        adapter: message.adapter,
        recipient: message.sender,
        text: '收到，正在处理...',
        ...(metadata ? { metadata } : {}),
      })
      .catch(() => undefined);
  }

  private getSession(senderKey: string): SessionState {
    let session = this.sessions.get(senderKey);
    if (!session) {
      session = { queue: [], processing: false, abortController: undefined };
      this.sessions.set(senderKey, session);
    }
    return session;
  }

  private handleBuiltInCommand(senderKey: string, text: string): string | null {
    if (!this.config.commands || !text.startsWith('/')) return null;
    const [command] = text.slice(1).trim().split(/\s+/);
    if (!command) return null;

    if (command === 'status') {
      const stats = this.stats();
      return [
        'Channel bridge status',
        `- Active: ${stats.active}`,
        `- Sessions: ${stats.sessions}`,
        `- Active prompts: ${stats.activePrompts}`,
        `- Queued: ${stats.queued}`,
      ].join('\n');
    }

    if (command === 'abort') {
      const session = this.sessions.get(senderKey);
      if (!session?.abortController) return 'Nothing is running right now.';
      session.abortController.abort();
      return 'Aborting current prompt...';
    }

    if (command === 'new') {
      const session = this.sessions.get(senderKey);
      session?.abortController?.abort();
      this.sessions.delete(senderKey);
      return 'Session reset.';
    }

    if (command === 'help' || command === 'start') {
      return 'Send a message to talk with pi. Commands: /status, /abort, /new.';
    }

    return null;
  }

  private async processNext(senderKey: string): Promise<void> {
    const session = this.sessions.get(senderKey);
    if (!session || session.processing || session.queue.length === 0) return;
    if (this.activeCount >= this.config.maxConcurrent) return;

    const queued = session.queue.shift();
    if (!queued) return;

    session.processing = true;
    this.activeCount++;
    const ac = new AbortController();
    session.abortController = ac;
    const adapter = this.registry.getAdapter(queued.message.adapter);
    adapter?.sendTyping?.(queued.message.sender).catch(() => undefined);

    const bridgeModel = this.config.model ?? resolveDefaultBridgeModel();
    const bridgeProvider = this.config.provider ?? resolveDefaultBridgeProvider(bridgeModel);
    const sessionId = channelSessionId(queued.message);
    let result: BridgeRunResult;
    try {
      result = await runPrompt({
        cwd: this.cwd,
        prompt: queued.message.text,
        ...(queued.message.attachments ? { attachments: queued.message.attachments } : {}),
        ...(sessionId
          ? { sessionFile: channelPromptSessionFile(this.cwd, queued.message, sessionId) }
          : {}),
        timeoutMs: this.config.timeoutMs,
        model: bridgeModel,
        provider: bridgeProvider,
        piBin: this.config.piBin,
        signal: ac.signal,
        env: this.config.env,
      });
    } finally {
      await cleanupBridgeAttachments(queued.message.attachments);
    }

    const reply = result.ok
      ? result.response
      : result.response || formatBridgeErrorReply(result.error);
    await persistChannelTurn({
      apiBase: this.config.apiBase,
      enabled: this.config.persistSessions,
      cwd: this.cwd,
      message: queued.message,
      reply,
      model: bridgeModel,
      provider: bridgeProvider,
    });
    await this.registry.send({
      adapter: queued.message.adapter,
      recipient: queued.message.sender,
      text: reply,
      ...(queued.message.metadata ? { metadata: queued.message.metadata } : {}),
    });

    session.abortController = undefined;
    session.processing = false;
    this.activeCount--;
    if (session.queue.length > 0) void this.processNext(senderKey);
    this.drainWaiting();
  }

  private drainWaiting(): void {
    if (this.activeCount >= this.config.maxConcurrent) return;
    for (const [senderKey, session] of this.sessions) {
      if (!session.processing && session.queue.length > 0) {
        void this.processNext(senderKey);
        if (this.activeCount >= this.config.maxConcurrent) return;
      }
    }
  }
}

function shouldSendProcessingAck(message: IncomingMessage): boolean {
  if (message.adapter === 'wecom') return Boolean(message.metadata?.wecomReplyFrame);
  if (message.adapter === 'dingtalk') return typeof message.metadata?.sessionWebhook === 'string';
  return false;
}

async function persistChannelTurn(input: {
  apiBase: string;
  enabled: boolean;
  cwd: string;
  message: IncomingMessage;
  reply: string;
  model: string | null;
  provider: string | null;
}): Promise<void> {
  if (!input.enabled) return;
  const apiBase = resolvePiAgentApiBase(input.apiBase);
  if (!apiBase) return;
  const sessionId = channelSessionId(input.message);
  if (!sessionId) return;
  const title = channelSessionTitle(input.message, sessionId);
  const body = {
    phase: 'completed',
    sessionId,
    conversationId: sessionId,
    title,
    adapter: input.message.adapter,
    recipient: sessionId,
    userMessage: input.message.text,
    assistantMessage: input.reply,
    createdAt: channelMessageCreatedAt(input.message),
    workspaceDir: process.env.PI_AGENT_WORKSPACE || input.cwd,
    model: modelPayload(input.provider, input.model),
  };
  try {
    const response = await fetch(`${apiBase}/internal/channel-sessions/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pi-agent-internal': 'channel-bridge',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn('[pi-channels] channel_session_persist_failed', {
        status: response.status,
        sessionId,
      });
    }
  } catch (error) {
    console.warn('[pi-channels] channel_session_persist_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function persistChannelTurnStarted(input: {
  apiBase: string;
  enabled: boolean;
  cwd: string;
  message: IncomingMessage;
}): Promise<void> {
  if (!input.enabled) return;
  const apiBase = resolvePiAgentApiBase(input.apiBase);
  if (!apiBase) return;
  const sessionId = channelSessionId(input.message);
  if (!sessionId) return;
  const title = channelSessionTitle(input.message, sessionId);
  const body = {
    phase: 'started',
    sessionId,
    conversationId: sessionId,
    title,
    adapter: input.message.adapter,
    recipient: sessionId,
    userMessage: input.message.text,
    createdAt: channelMessageCreatedAt(input.message),
    workspaceDir: process.env.PI_AGENT_WORKSPACE || input.cwd,
  };
  try {
    const response = await fetch(`${apiBase}/internal/channel-sessions/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pi-agent-internal': 'channel-bridge',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn('[pi-channels] channel_session_start_failed', {
        status: response.status,
        sessionId,
      });
    }
  } catch (error) {
    console.warn('[pi-channels] channel_session_start_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function channelSessionId(message: IncomingMessage): string | undefined {
  const metadata = message.metadata ?? {};
  if (message.adapter === 'feishu') {
    return (
      trimToNull(typeof metadata.chatId === 'string' ? metadata.chatId : undefined) ??
      trimToNull(message.sender.split(':')[0]) ??
      undefined
    );
  }
  return trimToNull(message.sender.split(':')[0]) ?? undefined;
}

function channelSessionTitle(message: IncomingMessage, sessionId: string): string {
  const metadata = message.metadata ?? {};
  const name =
    trimToNull(
      typeof metadata.chatName === 'string'
        ? metadata.chatName
        : typeof metadata.groupName === 'string'
          ? metadata.groupName
          : undefined,
    ) ?? sessionId;
  return `${adapterDisplayName(message.adapter)} / ${name}`;
}

function channelMessageCreatedAt(message: IncomingMessage): string {
  const createTime = message.metadata?.createTime;
  if (typeof createTime === 'number' && Number.isFinite(createTime)) {
    return new Date(createTime > 10_000_000_000 ? createTime : createTime * 1000).toISOString();
  }
  if (typeof createTime === 'string' && createTime.trim()) {
    const numeric = Number(createTime);
    if (Number.isFinite(numeric)) {
      return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
    }
    if (!Number.isNaN(Date.parse(createTime))) {
      return new Date(createTime).toISOString();
    }
  }
  return new Date().toISOString();
}

function adapterDisplayName(adapter: string): string {
  if (adapter === 'feishu') return '飞书';
  if (adapter === 'wecom') return '企微';
  return adapter;
}

function modelPayload(
  provider: string | null,
  model: string | null,
): { provider?: string; model?: string } | undefined {
  const cleanProvider = trimToNull(provider ?? undefined);
  const cleanModel = trimToNull(model ?? undefined);
  if (!cleanProvider && !cleanModel) return undefined;
  return {
    ...(cleanProvider ? { provider: cleanProvider } : {}),
    ...(cleanModel ? { model: cleanModel } : {}),
  };
}

function resolvePiAgentApiBase(configured: string): string | undefined {
  const explicit =
    trimToNull(configured) ??
    trimToNull(process.env.PI_AGENT_API_BASE) ??
    trimToNull(process.env.DESKTOP_API_BASE);
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = trimToNull(process.env.DESKTOP_PORT) ?? trimToNull(process.env.PORT);
  return port ? `http://127.0.0.1:${port}` : undefined;
}

function runPrompt(options: {
  cwd: string;
  prompt: string;
  attachments?: IncomingAttachment[];
  sessionFile?: string;
  timeoutMs: number;
  model: string | null;
  provider: string | null;
  piBin: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<BridgeRunResult> {
  return new Promise((resolve) => {
    const args = ['-p', '--offline', '--no-extensions'];
    if (options.sessionFile) {
      args.push('--session', options.sessionFile);
    } else {
      args.push('--no-session');
    }
    const model = options.model ?? resolveDefaultBridgeModel();
    const provider = options.provider ?? resolveDefaultBridgeProvider(model);
    if (shouldAttachBridgeProvider(provider)) {
      args.push('-e', resolveBridgeProviderExtensionPath());
    }
    if (provider) args.push('--provider', provider);
    if (model) args.push('--model', model);
    for (const attachment of options.attachments ?? []) {
      if (attachment.type === 'image') args.push(`@${attachment.path}`);
    }
    args.push(formatBridgePrompt(options.prompt));
    let command: string;
    let commandArgs: string[];
    try {
      const resolvedCommand = resolvePiCommand(options.piBin, options.cwd);
      command = resolvedCommand.command;
      commandArgs = [...resolvedCommand.argsPrefix, ...args];
    } catch (error) {
      resolve({
        ok: false,
        response: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (process.env.DEBUG?.includes('pi-channels')) {
      console.error('[pi-channels] bridge_run_prompt', {
        cwd: options.cwd,
        command,
        provider,
        model,
        sessionFile: options.sessionFile,
        hasAnthropicBaseUrl: Boolean(process.env.ANTHROPIC_BASE_URL),
        hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
        providerExtension: shouldAttachBridgeProvider(provider)
          ? resolveBridgeProviderExtensionPath()
          : undefined,
      });
    }

    let child: ChildProcess;
    try {
      child = spawn(command, commandArgs, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(options.env ?? {}) },
        timeout: options.timeoutMs,
      });
    } catch (error) {
      resolve({
        ok: false,
        response: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      const response = stdout.trim();
      if (options.signal?.aborted) {
        resolve({ ok: false, response: response || '(aborted)', error: 'Aborted' });
      } else if (code === 0) {
        resolve({ ok: true, response: response || '(no output)' });
      } else {
        resolve({ ok: false, response, error: stderr.trim() || `Exit code ${code ?? 1}` });
      }
    });

    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      resolve({ ok: false, response: '', error: error.message });
    });
  });
}

function channelPromptSessionFile(
  cwd: string,
  message: IncomingMessage,
  sessionId: string,
): string {
  const sessionDir = join(cwd, '.pi', 'channel-sessions');
  if (existsSync(cwd)) mkdirSync(sessionDir, { recursive: true });
  const fingerprint = createHash('sha256')
    .update(`${message.adapter}:${sessionId}`)
    .digest('hex')
    .slice(0, 24);
  return join(sessionDir, `${message.adapter}-${fingerprint}.jsonl`);
}

function formatBridgeErrorReply(error: string | undefined): string {
  const message = error?.trim();
  if (!message) return 'Error: unknown';
  if (
    /\b401\b/.test(message) ||
    /invalid x-api-key/i.test(message) ||
    /authentication_error/i.test(message)
  ) {
    return '模型服务认证失败，请检查 API Key 后点击“更新配置”或重启服务。';
  }
  return `Error: ${message}`;
}

function formatBridgePrompt(prompt: string): string {
  return `来自即时通讯的用户消息：\n${prompt}`;
}

async function cleanupBridgeAttachments(
  attachments: IncomingAttachment[] | undefined,
): Promise<void> {
  const tempRoot = resolve(tmpdir());
  const tempPrefix = join(tempRoot, 'pi-channels-feishu-image-');
  await Promise.all(
    (attachments ?? [])
      .filter((attachment) => resolve(attachment.path).startsWith(tempPrefix))
      .map((attachment) =>
        rm(dirname(attachment.path), { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

function resolveDefaultBridgeModel(): string | null {
  return trimToNull(process.env.ANTHROPIC_MODEL) ?? trimToNull(process.env.MODEL) ?? null;
}

function resolveDefaultBridgeProvider(model: string | null): string | null {
  if (!model || model.includes('/')) return null;
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY) {
    return 'anthropic-compatible';
  }
  return null;
}

function shouldAttachBridgeProvider(provider: string | null): boolean {
  return provider === 'anthropic-compatible';
}

function resolveBridgeProviderExtensionPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'bridge-provider.js');
}

function resolvePiCommand(
  configured: string,
  cwd: string,
): { command: string; argsPrefix: string[] } {
  const explicit = trimToNull(configured) ?? trimToNull(process.env.PI_CHANNELS_PI_BIN);
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error('Channel bridge Pi binary must be an absolute path.');
    }
    const command = realpathSync.native(explicit);
    const canonicalCwd = existsSync(cwd) ? realpathSync.native(cwd) : resolve(cwd);
    const pathFromCwd = relative(canonicalCwd, command);
    const insideWorkspace =
      pathFromCwd === '' ||
      (pathFromCwd !== '..' && !pathFromCwd.startsWith(`..${sep}`) && !isAbsolute(pathFromCwd));
    if (insideWorkspace) {
      throw new Error('Channel bridge Pi binary must be outside the workspace.');
    }
    return { command, argsPrefix: [] };
  }

  const cliPath = realpathSync.native(join(getPackageDir(), 'dist', 'cli.js'));
  return {
    command: realpathSync.native(process.execPath),
    argsPrefix: [cliPath],
  };
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
