export type RuntimeAuthModel = {
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
};

export type RuntimeAuthResult =
  | {
      ok: true;
      apiKey: string;
      baseUrl: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

export type RuntimeAuthRegistry<TModel extends RuntimeAuthModel = RuntimeAuthModel> = {
  getAll(): TModel[];
  getApiKeyAndHeaders(
    model: TModel,
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >;
};

const AUTH_HEADER_NAMES = new Set([
  'api-key',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
]);

export function mergeRuntimeAuthHeaders(
  staticHeaders?: Record<string, string>,
  runtimeHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(staticHeaders ?? {})) {
    if (!AUTH_HEADER_NAMES.has(name.toLowerCase())) merged[name] = value;
  }
  Object.assign(merged, runtimeHeaders);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function resolveRuntimeProviderAuth<TModel extends RuntimeAuthModel>(
  provider: string,
  registry: RuntimeAuthRegistry<TModel>,
): Promise<RuntimeAuthResult> {
  const requested = provider.trim();
  const model = registry.getAll().find((candidate) => candidate.provider === requested);
  if (!model) {
    return {
      ok: false,
      error: `Runtime auth provider "${requested}" is not available in this session.`,
    };
  }

  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return {
        ok: false,
        error: `Runtime auth provider "${requested}" failed: ${auth.error}`,
      };
    }
    if (!auth.apiKey) {
      return {
        ok: false,
        error: `Runtime auth provider "${requested}" did not provide an API key.`,
      };
    }

    const headers = mergeRuntimeAuthHeaders(model.headers, auth.headers);
    return {
      ok: true,
      apiKey: auth.apiKey,
      baseUrl: model.baseUrl,
      ...(headers ? { headers } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Runtime auth provider "${requested}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
