import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { complete, streamSimple } from '@earendil-works/pi-ai/compat';

/** Credentials from `ModelRegistry.getApiKeyAndHeaders`, used only when Pi lacks registry requests. */
export type ModelRequestAuth = Pick<SimpleStreamOptions, 'apiKey' | 'headers'>;

/** Request methods of Pi's `ModelRegistry`; Pi 0.86 and later provide them. */
export interface ModelRequestRegistry {
  streamSimple?(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
  complete?(
    model: Model<Api>,
    context: Context,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage>;
}

/**
 * Stream a model request through Pi's registry. The registry reaches providers registered with
 * `pi.registerProvider()` and resolves credentials per request; older Pi uses pi-ai compat with `auth`.
 */
export function streamModelRequest(
  registry: ModelRequestRegistry,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  auth: ModelRequestAuth,
): AssistantMessageEventStream {
  if (registry.streamSimple) return registry.streamSimple(model, context, options);
  return streamSimple(model, context, { ...options, ...definedAuth(auth) });
}

/** Complete a model request through Pi's registry, as {@link streamModelRequest} does. */
export function completeModelRequest(
  registry: ModelRequestRegistry,
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
  auth: ModelRequestAuth,
): Promise<AssistantMessage> {
  if (registry.complete) return registry.complete(model, context, options);
  return complete(model, context, { ...options, ...definedAuth(auth) });
}

function definedAuth({ apiKey, headers }: ModelRequestAuth): ModelRequestAuth {
  return { ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) };
}
