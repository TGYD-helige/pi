export type ApiStyle = 'openai' | 'gemini' | 'dashscope' | 'openrouter' | 'ark';

/** Built-in provider id. Currently 1:1 with ApiStyle. */
export type BuiltInProviderId = ApiStyle;

/** A user-defined image-generation provider. */
export type CustomImageProvider = {
  /**
   * Image-API wire shape this provider speaks. Determines which adapter
   * is used to call it. Required.
   *
   * Note: this is NOT the same as pi.dev custom providers' `api` field — pi.dev's
   * values (`openai-completions`, `anthropic-messages`, ...) are LLM streaming
   * formats. The values here are image-generation API shapes.
   */
  api: ApiStyle;
  /** Override the API base URL. Optional; defaults to the api's default. */
  baseUrl?: string;
  /**
   * API key. User and agent settings support `$ENV_VAR` and `${ENV_VAR}` syntax.
   * Required unless the api does not need one.
   */
  apiKey?: string;
  /** Optional display name. */
  name?: string;
  /** Extra headers merged into every outbound request. */
  headers?: Record<string, string>;
  /** Resolve API credentials and endpoint from this provider in the current Pi session. */
  runtimeAuthProvider?: string;
  /** Models routed through this provider. Each entry is a model id (string) or an object. */
  models?: Array<string | CustomImageModel>;
};

export type CustomImageModel = {
  /** Model id sent to the provider (e.g. "qwen-image-2.0"). */
  id: string;
  /** Optional alias the agent / user can refer to. Defaults to id. */
  alias?: string;
  /** Optional display name. */
  name?: string;
};

/** Per-built-in-provider override (api key, base url, custom headers). */
export type BuiltInProviderOverride = {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Resolve API credentials and endpoint from this provider in the current Pi session. */
  runtimeAuthProvider?: string;
};

export type ImageGenSettings = {
  /** Default model id when the tool call does not pass `model`. */
  defaultModel?: string;
  /**
   * Where to write generated images. Relative paths resolve against the session cwd.
   * Default: `.pi/images`.
   */
  outputDir?: string;
  /** Per-built-in-provider overrides keyed by provider id. */
  providers?: Partial<Record<BuiltInProviderId, BuiltInProviderOverride>>;
  /** User-defined custom providers keyed by provider name. */
  customProviders?: Record<string, CustomImageProvider>;
};

export type GenerateImageParams = {
  prompt: string;
  /**
   * Optional reference / input images for image-to-image, editing, style
   * transfer, or character preservation. Each entry MUST be either:
   *   - an absolute or relative file path on the local filesystem, or
   *   - an http(s) URL.
   *
   * `data:` URIs and raw base64 strings are intentionally rejected — tool
   * arguments don't survive megabyte-sized strings cleanly across providers.
   * If you have raw image bytes, write them to a file first.
   */
  image?: string[];
  /** Number of images to generate. Default 1. */
  n?: number;
  /** Image size hint (e.g. "1024x1024"). Provider may ignore. */
  size?: string;
  /**
   * Quality hint (e.g. "low" | "medium" | "high" | "auto" for OpenAI gpt-image).
   * Provider-specific: forwarded on OpenAI-shaped providers, ignored by adapters
   * that don't expose a quality knob.
   */
  quality?: string;
  /** Output filename prefix. */
  filename?: string;
  /** Override settings.outputDir for this call. */
  outputDir?: string;
};

/** Materialized reference image, ready for adapters to encode. */
export type ResolvedImageInput = {
  bytes: Uint8Array;
  mimeType: string;
};

export type GeneratedImage = {
  /** Absolute path on disk where the image was saved. */
  path: string;
  /** Image MIME type, e.g. "image/png". */
  mimeType: string;
  /** Pass-through revised prompt if the provider returned one (e.g. OpenAI). */
  revisedPrompt?: string;
};

export type ImageGenResult = {
  model: string;
  provider: string;
  images: GeneratedImage[];
};

/** Resolved provider entry: either a built-in or a custom one. */
export type ResolvedProvider = {
  /** Provider key as referenced by the user (e.g. "openai", "my-stable-diffusion"). */
  id: string;
  api: ApiStyle;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Display label. */
  name: string;
  /** True for built-in providers (openai/gemini/dashscope/openrouter). */
  builtIn: boolean;
};

/** Result of resolving a model string to a provider + remote model id. */
export type ResolvedModel = {
  provider: ResolvedProvider;
  /** The id passed to the remote provider. */
  remoteId: string;
  /** The id the user asked for (alias or remoteId). */
  requestedId: string;
};

/** Adapter interface implemented by each api shape. */
export type ImageProviderAdapter = {
  generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
  ): Promise<RawImageResult[]>;
};

export type RawImageResult = {
  /** Either base64 PNG bytes or a URL to fetch. */
  data: { kind: 'base64'; bytes: string; mimeType?: string } | { kind: 'url'; url: string };
  revisedPrompt?: string;
};
