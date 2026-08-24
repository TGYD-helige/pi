/**
 * Shared types for pi-video-gen.
 *
 * The provider layer mirrors pi-image-gen's three-level split:
 * wire format (`VideoApiStyle`) → model registry (`BuiltInVideoModel`) →
 * resolved provider/model at runtime. Unlike image generation, vendor video
 * APIs are async task APIs, so the adapter seam exposes the remote task
 * lifecycle (`submit` / `inspect` / `downloadTo` / `cancel?`) instead of a
 * single `generate()` — the remote task handle is what makes crash resume
 * possible without double-billing.
 */

/** Wire format, NOT vendor — the same model via official or proxy endpoints differs only in baseUrl. */
export type VideoApiStyle = 'ark' | 'kling' | 'dashscope' | 'openrouter' | 'newapi' | 'minimax';

export type ReferenceAssetModality = 'image' | 'video' | 'audio';

/** A provider-managed trusted asset selected in the caller's current account/project. */
export type ReferenceAsset = {
  modality: ReferenceAssetModality;
  /** Canonical id only (`asset-...`); public inputs may also use `asset://asset-...`. */
  assetId: string;
};

export type VideoModelCapabilities = {
  /** Max reference images a request may carry (0 = text-to-video only). */
  maxReferenceImages: number;
  /** Max provider-managed reference videos a request may carry. */
  maxReferenceVideos?: number | undefined;
  /** Max provider-managed reference audio clips a request may carry. */
  maxReferenceAudios?: number | undefined;
  /** Inclusive [min, max] clip duration in seconds. */
  durations: [number, number];
  resolutions: string[];
  aspectRatios: string[];
  /** Model generates synchronized speech/SFX/BGM natively (e.g. Seedance 2.0 `generate_audio`). */
  nativeAudio: boolean;
  /** First+last frame interpolation is actually honored by this endpoint. */
  supportsFirstLastFrame: boolean;
  /** Provider-managed trusted asset modalities accepted by this model. */
  referenceAssetModalities?: ReferenceAssetModality[] | undefined;
};

export type BuiltInVideoModel = {
  id: string;
  aliases: string[];
  provider: VideoApiStyle;
  /** Remote model id sent to the provider (defaults to id). */
  remoteId?: string;
  capabilities: VideoModelCapabilities;
  defaultResolution: string;
  defaultAspectRatio: string;
  defaultDurationSec: number;
};

export type ProviderSettings = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
};

export type RateLimitSettings = {
  maxRequestsPerMinute?: number | undefined;
  maxRequestsPerDay?: number | undefined;
};

/** A user-defined video model routed through a custom (or built-in) provider. */
export type CustomVideoModel = {
  /** Remote model id sent to the provider. */
  id: string;
  /** Optional alias the agent / user can refer to. */
  alias?: string | undefined;
  /** Optional display name. */
  name?: string | undefined;
  /**
   * Capability declaration driving tool schema and preflight. Every field is
   * optional; omitted fields fall back to the built-in registry entry of the
   * same id when one exists, else to conservative defaults (no audio, no
   * last-frame, 720p, 16:9).
   */
  capabilities?: Partial<VideoModelCapabilities> | undefined;
  defaultResolution?: string | undefined;
  defaultAspectRatio?: string | undefined;
  defaultDurationSec?: number | undefined;
};

/** A user-defined video-generation provider reusing a built-in wire format. */
export type CustomVideoProvider = {
  /**
   * Wire shape this provider speaks. Determines which adapter calls it.
   * Values are video-generation API shapes (e.g. the Ark task API), NOT pi.dev
   * LLM streaming formats.
   */
  api: VideoApiStyle;
  /**
   * Override the API base URL. Optional for apis with a public default
   * endpoint; REQUIRED for `newapi` (self-hosted relay — resolution fails
   * without it).
   */
  baseUrl?: string | undefined;
  /** API key. User/agent-dir settings support `$ENV_VAR` and `${ENV_VAR}` syntax. */
  apiKey?: string | undefined;
  /** Optional display name. */
  name?: string | undefined;
  /** Models routed through this provider. */
  models?: Array<string | CustomVideoModel>;
};

export type VideoGenSettings = {
  /** Job root directory. Defaults to `<cwd>/.video-gen`. */
  outputDir?: string;
  /** Model id or alias resolved against the built-in registry. */
  defaultModel?: string;
  /** Sensitive: honored from global/agent-dir settings layers only. */
  providers?: Partial<Record<VideoApiStyle, ProviderSettings>>;
  /** Sensitive: honored from global/agent-dir settings layers only. */
  ffmpegPath?: string;
  rateLimit?: RateLimitSettings;
  concurrency?: { clips?: number };
  /**
   * User-defined custom providers keyed by provider name (mirrors
   * pi-image-gen's customProviders). Sensitive: global/agent-dir layers only.
   */
  customProviders?: Record<string, CustomVideoProvider>;
};

export type ResolvedProvider = {
  style: VideoApiStyle;
  apiKey?: string | undefined;
  apiKeyPath?: string | undefined;
  baseUrl: string;
};

export type ResolvedModel = {
  entry: BuiltInVideoModel;
  remoteId: string;
  provider: ResolvedProvider;
};

/** A film-level character whose description is inlined into shot prompts on demand. */
export type PromptCharacter = {
  id: string;
  /** Static + dynamic appearance (face, hair, build, outfit). */
  description: string;
};

/**
 * Per-shot prompt fields. Content is authored by the caller (skill/LLM);
 * assembly into the provider string is mechanical (see prompt.ts).
 */
export type ShotPrompt = {
  /** Setting of the shot. Required when no first frame anchors the visuals. */
  scene?: string | undefined;
  /** Camera, framing, composition ("Static camera, medium close-up, …"). */
  visuals: string;
  /** In-frame action/movement. */
  action: string;
  /** Time-varying visuals a static frame cannot carry: transformations, lighting shifts, particles, mood. */
  effects?: string | undefined;
  /** Audio cues, e.g. "[Sound Effect] rain; [Speaker] Alice (soft): line". */
  audio?: string | undefined;
  /** Ids of film-level characters appearing in this shot. */
  visibleCharacters?: string[] | undefined;
};

/** Film-level prompt fields shared across shots. */
export type FilmPrompt = {
  /** Overall look: genre, quality, render texture ("cinematic, 8K, film grain"). */
  style?: string | undefined;
  characters?: PromptCharacter[] | undefined;
  /** Consistency directive ("Face, hair and outfit stay identical, no morphing or drift"). */
  consistency?: string | undefined;
  /** Negative directive ("no text, watermarks, or subtitles"). */
  negative?: string | undefined;
};

export type GenerateVideoParams = {
  prompt: string;
  /** Stable orchestration identity for provider idempotency/recovery keys. */
  requestId?: string | undefined;
  firstFramePath?: string | undefined;
  lastFramePath?: string | undefined;
  /** Additional reference images (subject/style), roles mapped per provider. */
  referenceImagePaths?: string[] | undefined;
  /** Provider-managed trusted assets, kept in caller order for prompt numbering. */
  referenceAssets?: ReferenceAsset[] | undefined;
  durationSec?: number | undefined;
  aspectRatio?: string | undefined;
  resolution?: string | undefined;
  /** Caller-side decision from capabilities.nativeAudio; adapter forwards it. */
  generateAudio?: boolean | undefined;
};

export type RemoteTaskHandle = {
  taskId: string;
  /** ISO-8601 submission time. */
  submittedAt: string;
  /** Hash of model+prompt+frames+params, used to match a handle to its request on resume. */
  requestFingerprint: string;
  /** Adapter-specific resume data (e.g. Kling's task kind for the poll URL). */
  meta?: Record<string, string> | undefined;
};

export type RemoteTaskStatus =
  | { phase: 'pending' | 'running' }
  | { phase: 'succeeded'; videoUrl: string }
  | { phase: 'failed'; message: string };

export type VideoFileMeta = {
  path: string;
  bytes: number;
};

export type VideoProviderAdapter = {
  /** Create the remote task. Caller persists the returned handle immediately. */
  submit(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateVideoParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
  ): Promise<RemoteTaskHandle>;

  /** Query task state. Resume entry point: with a handle, never re-submit. */
  inspect(
    provider: ResolvedProvider,
    handle: RemoteTaskHandle,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
  ): Promise<RemoteTaskStatus>;

  /** Stream the finished video to destPath (temp file → limits → magic bytes → atomic rename). */
  downloadTo(
    provider: ResolvedProvider,
    handle: RemoteTaskHandle,
    videoUrl: string,
    destPath: string,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
  ): Promise<VideoFileMeta>;

  /** Only implemented when the vendor exposes a cancel API; absent ⇒ local stop is `polling_stopped`. */
  cancel?(
    provider: ResolvedProvider,
    handle: RemoteTaskHandle,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
  ): Promise<{ cancelled: boolean }>;
};
