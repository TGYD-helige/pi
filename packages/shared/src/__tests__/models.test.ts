import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  registerFauxProvider,
  streamSimple,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { completeModelRequest, streamModelRequest } from '../models.js';

const context: Context = {
  messages: [{ role: 'user', content: 'Summarize.', timestamp: 0 }],
};
const text = (message: { content: Array<{ type: string; text?: string }> }) =>
  message.content.map((part) => part.text ?? '').join('');

describe('models', () => {
  const providers: Array<{ unregister(): void }> = [];
  afterEach(() => {
    for (const provider of providers.splice(0)) provider.unregister();
  });

  function fauxModel(name: string) {
    const provider = registerFauxProvider({ provider: name });
    providers.push(provider);
    return provider;
  }

  it.each([
    'stream',
    'complete',
  ])('%s reaches a provider known only to the registry', async (kind) => {
    const backing = fauxModel(`pi-shared-registry-${kind}`);
    const seen: Array<SimpleStreamOptions | undefined> = [];
    backing.setResponses([
      (_context, options) => {
        seen.push(options);
        return fauxAssistantMessage('from registry');
      },
    ]);
    // pi-ai compat has no provider for this api, like a pi.registerProvider() extension.
    const model = { ...backing.getModel(), api: 'pi-shared-extension-api' } as Model<string>;
    // Like Pi's ModelRegistry, the methods need their receiver.
    const registry = {
      backing: backing.getModel(),
      streamSimple(this: { backing: Model<string> }, _m: Model<string>, c: Context, o?: object) {
        return streamSimple(this.backing, c, o);
      },
    };
    const auth = { apiKey: 'resolved-once' };
    const result =
      kind === 'stream'
        ? await streamModelRequest(registry, model, context, {}, auth).result()
        : await completeModelRequest(registry, model, context, {}, auth);
    expect(text(result)).toBe('from registry');
    // The registry resolves credentials per request instead of reusing a pre-resolved key.
    expect(seen[0]?.apiKey).toBeUndefined();
  });

  it.each([
    'stream',
    'complete',
  ])('%s falls back to compat with resolved credentials before Pi 0.86', async (kind) => {
    const provider = fauxModel(`pi-shared-compat-${kind}`);
    const seen: Array<SimpleStreamOptions | undefined> = [];
    provider.setResponses([
      (_context, options) => {
        seen.push(options);
        return fauxAssistantMessage('from compat');
      },
    ]);
    const auth = { apiKey: 'resolved-key', headers: { 'x-test': 'header' } };
    const result =
      kind === 'stream'
        ? await streamModelRequest({}, provider.getModel(), context, {}, auth).result()
        : await completeModelRequest({}, provider.getModel(), context, {}, auth);
    expect(text(result)).toBe('from compat');
    expect(seen[0]).toMatchObject({ apiKey: 'resolved-key', headers: { 'x-test': 'header' } });
  });
});
