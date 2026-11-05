import { describeToolError, SafeToolError } from '@amaster.ai/pi-shared';
import { createDingTalkAdapter } from './adapters/dingtalk.js';
import { createFeishuAdapter } from './adapters/feishu.js';
import { createWebhookAdapter } from './adapters/webhook.js';
import { createWeComAdapter } from './adapters/wecom.js';
import type {
  AdapterConfig,
  AdapterDirection,
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelRouteConfig,
  IncomingMessage,
  OnIncomingMessage,
  SendResult,
} from './types.js';

export type AdapterFactoryContext = {
  cwd: string;
  log?: (event: string, data?: Record<string, unknown>, level?: string) => void;
};

type AdapterFactory = (
  config: AdapterConfig,
  context: AdapterFactoryContext,
) => Promise<ChannelAdapter> | ChannelAdapter;

const adapterFactories: Record<string, AdapterFactory> = {
  dingtalk: createDingTalkAdapter,
  feishu: createFeishuAdapter,
  webhook: createWebhookAdapter,
  wecom: createWeComAdapter,
};

export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();
  private adapterFingerprints = new Map<string, string>();
  private routes = new Map<string, ChannelRouteConfig>();
  private credentialedWebhookRecipients = new Map<string, Set<string>>();
  private errors: Array<{ adapter: string; error: string }> = [];
  private onIncoming: OnIncomingMessage = () => undefined;
  private log?: (event: string, data?: Record<string, unknown>, level?: string) => void;

  setLogger(log: (event: string, data?: Record<string, unknown>, level?: string) => void): void {
    this.log = log;
  }

  setOnIncoming(onIncoming: OnIncomingMessage): void {
    this.onIncoming = onIncoming;
  }

  async loadConfig(config: ChannelConfig, cwd: string): Promise<void> {
    await this.stopAll();
    this.adapters.clear();
    this.adapterFingerprints.clear();
    this.routes.clear();
    this.credentialedWebhookRecipients.clear();
    this.errors = [];

    this.loadRoutes(config);

    for (const [name, adapterConfig] of Object.entries(config.adapters ?? {})) {
      await this.loadAdapter(name, adapterConfig, cwd);
    }
  }

  loadRoutes(config: ChannelConfig): void {
    this.routes.clear();
    for (const [alias, target] of Object.entries(config.routes ?? {})) {
      this.routes.set(alias, target);
    }
  }

  async loadAdapter(name: string, config: AdapterConfig, cwd: string): Promise<void> {
    this.setCredentialedWebhookPolicy(name, config);
    const fingerprint = JSON.stringify(config);
    if (this.adapters.has(name) && this.adapterFingerprints.get(name) === fingerprint) return;
    this.errors = this.errors.filter((error) => error.adapter !== name);
    const factory = adapterFactories[config.type];
    if (!factory) {
      this.errors.push({ adapter: name, error: `Unknown adapter type: ${config.type}` });
      return;
    }
    const previous = this.adapters.get(name);
    await previous?.stop?.();
    this.adapters.delete(name);
    this.adapterFingerprints.delete(name);
    try {
      const context: AdapterFactoryContext = this.log
        ? {
            cwd,
            log: (event, data, level) =>
              this.log?.(event, { adapter: name, ...(data ?? {}) }, level),
          }
        : { cwd };
      const adapter = await factory(config, context);
      this.adapters.set(name, adapter);
      this.adapterFingerprints.set(name, fingerprint);
    } catch (error) {
      this.errors.push({ adapter: name, error: errorMessage(error) });
    }
  }

  async ensureAdapter(name: string, config: ChannelConfig, cwd: string): Promise<void> {
    const adapterConfig = config.adapters?.[name];
    if (!adapterConfig) {
      this.errors = this.errors.filter((error) => error.adapter !== name);
      this.errors.push({ adapter: name, error: `No adapter config "${name}"` });
      return;
    }
    await this.loadAdapter(name, adapterConfig, cwd);
  }

  async startListening(adapterName?: string): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      if (adapterName && name !== adapterName) continue;
      if (!adapter.start || adapter.direction === 'outgoing') continue;
      try {
        await adapter.start((message: IncomingMessage) => {
          const withAdapter = { ...message, adapter: name };
          try {
            const maybePromise = this.onIncoming(withAdapter);
            if (maybePromise instanceof Promise) {
              maybePromise.catch((error) => {
                this.errors.push({
                  adapter: name,
                  error: `Incoming handler failed: ${errorMessage(error)}`,
                });
              });
            }
          } catch (error) {
            this.errors.push({
              adapter: name,
              error: `Incoming handler failed: ${errorMessage(error)}`,
            });
          }
        });
      } catch (error) {
        this.errors.push({ adapter: name, error: `Failed to start: ${errorMessage(error)}` });
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop?.();
    }
    this.adapters.clear();
    this.adapterFingerprints.clear();
  }

  register(name: string, adapter: ChannelAdapter): void {
    this.adapters.set(name, adapter);
    if (adapter.start && adapter.direction !== 'outgoing') {
      adapter
        .start((message) => this.onIncoming({ ...message, adapter: name }))
        .catch((error) => {
          this.errors.push({ adapter: name, error: `Failed to start: ${errorMessage(error)}` });
        });
    }
  }

  unregister(name: string): boolean {
    const adapter = this.adapters.get(name);
    adapter?.stop?.();
    return this.adapters.delete(name);
  }

  async send(message: ChannelMessage, signal?: AbortSignal): Promise<SendResult> {
    const resolved = this.resolve(message.adapter, message.recipient);
    const allowedWebhookRecipients = this.credentialedWebhookRecipients.get(resolved.adapter);
    if (allowedWebhookRecipients && !allowedWebhookRecipients.has(resolved.recipient)) {
      const error = 'Credentialed webhook destinations must use a configured route.';
      this.log?.(
        'message_send_failed',
        { adapter: resolved.adapter, source: message.source },
        'ERROR',
      );
      return { ok: false, error };
    }
    const adapter = this.adapters.get(resolved.adapter);
    if (!adapter) {
      const error = `No adapter "${resolved.adapter}"`;
      this.log?.('message_send_failed', { adapter: resolved.adapter, error }, 'ERROR');
      return { ok: false, error };
    }
    if (adapter.direction === 'incoming') {
      const error = `Adapter "${resolved.adapter}" is incoming-only`;
      this.log?.('message_send_failed', { adapter: resolved.adapter, error }, 'ERROR');
      return { ok: false, error };
    }
    if (!adapter.send) {
      const error = `Adapter "${resolved.adapter}" cannot send`;
      this.log?.('message_send_failed', { adapter: resolved.adapter, error }, 'ERROR');
      return { ok: false, error };
    }

    try {
      this.log?.('message_send_start', {
        adapter: resolved.adapter,
        source: message.source,
      });
      const outbound = { ...message, adapter: resolved.adapter, recipient: resolved.recipient };
      if (signal) await adapter.send(outbound, signal);
      else await adapter.send(outbound);
      this.log?.('message_send_ok', {
        adapter: resolved.adapter,
        source: message.source,
      });
      return { ok: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = describeToolError(
        'Channel send',
        error,
        'Delivery may have completed. Inspect delivery state before retrying.',
      );
      if (
        error instanceof Error &&
        !(error instanceof SafeToolError) &&
        error.message.startsWith('Outbound URL must use a public HTTP(S) destination.')
      )
        failure.error = 'Outbound URL must use a public HTTP(S) destination.';
      this.log?.(
        'message_send_failed',
        {
          adapter: resolved.adapter,
          source: message.source,
          errorCategory: failure.errorCategory,
          ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        },
        'ERROR',
      );
      return { ok: false, ...failure };
    }
  }

  getAdapter(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): Array<{
    name: string;
    type: 'adapter' | 'route';
    adapter?: string;
    direction?: AdapterDirection;
    target?: string;
    label?: string;
  }> {
    const result: Array<{
      name: string;
      type: 'adapter' | 'route';
      adapter?: string;
      direction?: AdapterDirection;
      target?: string;
      label?: string;
    }> = [];
    for (const [name, adapter] of this.adapters) {
      result.push({ name, type: 'adapter', direction: adapter.direction });
    }
    for (const [name, route] of this.routes) {
      result.push({
        name,
        type: 'route',
        adapter: route.adapter,
        target: `${route.adapter} -> ${recipientForDisplay(route.recipient)}`,
        ...(route.name ? { label: route.name } : {}),
      });
    }
    return result;
  }

  getErrors(): Array<{ adapter: string; error: string }> {
    return [...this.errors];
  }

  resolveTarget(adapterName: string, recipient: string): { adapter: string; recipient: string } {
    const route = this.routes.get(adapterName);
    if (!route) return { adapter: adapterName, recipient };
    return { adapter: route.adapter, recipient: recipient || route.recipient };
  }

  private resolve(adapterName: string, recipient: string): { adapter: string; recipient: string } {
    return this.resolveTarget(adapterName, recipient);
  }

  private setCredentialedWebhookPolicy(name: string, config: AdapterConfig): void {
    const headers =
      config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
        ? Object.keys(config.headers)
        : [];
    if (config.type !== 'webhook' || (!config.secret && headers.length === 0)) {
      this.credentialedWebhookRecipients.delete(name);
      return;
    }
    this.credentialedWebhookRecipients.set(
      name,
      new Set(
        [...this.routes.values()]
          .filter((route) => route.adapter === name && route.recipient)
          .map((route) => route.recipient),
      ),
    );
  }
}

function recipientForDisplay(recipient: string): string {
  try {
    const url = new URL(recipient);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}/[redacted]`;
    }
  } catch {
    // Non-URL channel recipients are safe to display as configured.
  }
  return recipient;
}

export function errorMessage(error: unknown): string {
  return describeToolError('Channel operation', error).error;
}
