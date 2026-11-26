import { safeFetch, ValidationError } from '@amaster.ai/pi-shared';
import type {
  AdapterConfig,
  ChannelAdapter,
  ChannelMessage,
  ChannelPayloadMode,
} from '../types.js';

const WEBHOOK_TIMEOUT_MS = 30_000;

export function createWebhookAdapter(config: AdapterConfig): ChannelAdapter {
  const defaultMethod = typeof config.method === 'string' ? config.method : 'POST';
  const defaultContentType =
    typeof config.contentType === 'string' ? config.contentType : 'application/json';
  const defaultPayloadMode: ChannelPayloadMode = config.payloadMode === 'raw' ? 'raw' : 'envelope';
  const configuredHeaders =
    config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
      ? (config.headers as Record<string, string>)
      : {};
  const secret = typeof config.secret === 'string' ? config.secret : undefined;
  const headers = { ...configuredHeaders };
  const hasAuthorization = Object.keys(headers).some(
    (key) => key.toLowerCase() === 'authorization',
  );
  if (secret && !hasAuthorization) headers.Authorization = `Bearer ${secret}`;

  return {
    direction: 'outgoing',
    async send(message: ChannelMessage, signal?: AbortSignal): Promise<void> {
      const payloadMode = message.payloadMode ?? defaultPayloadMode;
      const method =
        payloadMode === 'raw' ? (message.webhook?.method ?? defaultMethod) : defaultMethod;
      const contentType =
        payloadMode === 'raw'
          ? (message.webhook?.contentType ?? defaultContentType)
          : defaultContentType;
      const normalizedMethod = method.toUpperCase();
      const canHaveBody = normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD';
      let body: string | undefined;

      if (payloadMode === 'raw') {
        if (canHaveBody) {
          if (message.rawBody === undefined) {
            throw new ValidationError(
              'The request was rejected before sending. Set json for a webhook raw payload or use envelope mode.',
            );
          }
          body =
            typeof message.rawBody === 'string' ? message.rawBody : JSON.stringify(message.rawBody);
        } else if (message.rawBody !== undefined) {
          throw new ValidationError(
            'The request was rejected before sending. GET and HEAD webhook requests cannot include a body.',
          );
        }
      } else if (canHaveBody) {
        body = JSON.stringify({
          text: message.text ?? '',
          source: message.source,
          metadata: message.metadata,
          timestamp: new Date().toISOString(),
        });
      }

      const requestHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== 'content-type') requestHeaders[key] = value;
      }
      if (body !== undefined) requestHeaders['Content-Type'] = contentType;

      const response = await safeFetch(
        message.recipient,
        {
          method,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.any([
            AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            ...(signal ? [signal] : []),
          ]),
        },
        { maxRedirects: 0 },
      );
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        throw new Error(`Webhook request failed with HTTP ${response.status}.`);
      }
    },
  };
}
