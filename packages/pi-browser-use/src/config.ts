import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCloudBrowserAdapter } from './adapter.js';
import type { BrowserSessionConfig } from './session-backend.js';

/** Vision model used by the optional analyze_screenshot tool. */
export interface VisionModelConfig {
  provider: string;
  model: string;
}

export type BrowserSessionMode = 'persistent' | 'isolated' | 'existing';

/** Configuration for the chrome-devtools-mcp upstream process. */
export interface BrowserUseConfig {
  session?: BrowserSessionConfig;
  sessionMode?: BrowserSessionMode;
  headless?: boolean;
  channel?: 'canary' | 'dev' | 'beta' | 'stable';
  browserUrl?: string;
  wsEndpoint?: string;
  wsHeaders?: string;
  executablePath?: string;
  viewport?: string;
  isolated?: boolean;
  userDataDir?: string;
  autoConnect?: boolean;

  categoryPerformance?: boolean;
  categoryNetwork?: boolean;
  categoryEmulation?: boolean;
  categoryExtensions?: boolean;

  experimentalVision?: boolean;
  experimentalScreencast?: boolean;
  experimentalMemory?: boolean;
  experimentalPageIdRouting?: boolean;

  visionModel?: VisionModelConfig;

  usageStatistics?: boolean;
  performanceCrux?: boolean;
  redactNetworkHeaders?: boolean;
  acceptInsecureCerts?: boolean;
  allowedUrlPattern?: string[];
  blockedUrlPattern?: string[];

  slim?: boolean;
  extraArgs?: string[];

  /**
   * Additional environment variable names the MCP subprocess may inherit,
   * on top of DEFAULT_ENV_ALLOWLIST. Everything else is stripped so secrets
   * in the host environment do not reach the subprocess.
   */
  envAllowlist?: string[];

  /**
   * Environment variable names the MCP subprocess must never receive.
   * Takes precedence over DEFAULT_ENV_ALLOWLIST and envAllowlist.
   */
  envBlocklist?: string[];

  /**
   * Which upstream tools are active at session start: 'core' activates only
   * the everyday toolset (extra groups via the browser_tools tool or the
   * /browser-tools command), 'full' activates every discovered tool.
   * Ignored in slim mode. Default: 'core'
   */
  toolProfile?: 'core' | 'full';
}

export const DEFAULT_PROFILE_DIR = join(homedir(), '.pi', 'browser-profile');

/**
 * Environment variables the MCP subprocess needs for Chrome and the network:
 * process basics, the graphical session (headful Chrome), and proxies.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  // Process basics
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'USER',
  // Linux graphical session (headful Chrome)
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  // Proxy (upper- and lowercase variants)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // Windows basics Chrome needs
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMDRIVE',
];

/** Filter env down to the default allowlist plus configured extras, minus the blocklist. */
export function buildSubprocessEnv(
  env: Record<string, string | undefined>,
  extraAllowlist?: string[],
  extraBlocklist?: string[],
): Record<string, string | undefined> {
  const normalize = (name: string) => (process.platform === 'win32' ? name.toUpperCase() : name);
  const allowed = new Set(
    [...DEFAULT_ENV_ALLOWLIST, ...(extraAllowlist ?? [])].map((name) => normalize(name.trim())),
  );
  const blocked = new Set((extraBlocklist ?? []).map((name) => normalize(name.trim())));
  const filtered: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    // Undefined overrides SDK defaults and is omitted by Node when spawning.
    const key = normalize(name);
    filtered[key] = allowed.has(key) && !blocked.has(key) ? value : undefined;
  }
  return filtered;
}

const DEFAULTS: Partial<BrowserUseConfig> = {
  sessionMode: 'persistent',
  categoryPerformance: false,
  categoryNetwork: true,
  categoryEmulation: true,
  categoryExtensions: false,
  experimentalVision: true,
  experimentalScreencast: false,
  experimentalMemory: false,
  experimentalPageIdRouting: true,
  usageStatistics: false,
  performanceCrux: false,
  redactNetworkHeaders: true,
  acceptInsecureCerts: false,
  toolProfile: 'core',
};

/** Merge user config over sane defaults. */
export function resolveConfig(config?: BrowserUseConfig): BrowserUseConfig {
  const resolved = { ...DEFAULTS, ...config };

  if (resolved.session && typeof resolved.session.enabled !== 'boolean')
    throw new Error('Browser session.enabled must be true or false');

  if (resolved.session?.enabled) {
    const { key, retentionMs, backend, adapterModule, provider } = resolved.session;
    if (typeof key !== 'string' || !key.trim() || key.length > 512)
      throw new Error(
        'Browser session.key must be a non-empty logical session identifier (max 512 characters)',
      );
    if (!Number.isInteger(retentionMs) || retentionMs < 1 || retentionMs > 86_400_000)
      throw new Error('Browser session.retentionMs must be between 1 and 86400000');
    if ([backend, adapterModule, provider].filter(Boolean).length > 1)
      throw new Error('Choose one browser session provider, backend, or adapterModule');
    if (provider) createCloudBrowserAdapter(provider);
    if (backend && Object.hasOwn(backend, 'sessionId'))
      throw new Error(
        'Provider sessionId is runtime state; supply a runtime binding instead of settings',
      );
    if (resolved.slim || resolved.experimentalPageIdRouting === false)
      throw new Error('Browser sessions require page ID routing and cannot use slim mode');
    if (
      resolved.extraArgs?.some(
        (arg) =>
          /^-[uwe]/.test(arg) ||
          [
            'browserurl',
            'wsendpoint',
            'wsheaders',
            'autoconnect',
            'userdatadir',
            'isolated',
            'executablepath',
            'channel',
            'slim',
            'experimentalpageidrouting',
          ].includes(arg.split('=')[0]!.replaceAll('-', '').toLowerCase().replace(/^no/, '')),
      )
    ) {
      throw new Error(
        'Use structured browser connection settings instead of extraArgs overrides with browser sessions',
      );
    }
  }

  if (resolved.allowedUrlPattern?.length && resolved.blockedUrlPattern?.length) {
    throw new Error('allowedUrlPattern and blockedUrlPattern cannot be used together');
  }

  if (resolved.slim) {
    if (config?.experimentalPageIdRouting === true) {
      throw new Error('experimentalPageIdRouting cannot be used with slim mode');
    }
    resolved.experimentalPageIdRouting = false;
  }

  switch (resolved.sessionMode) {
    case 'existing':
      if (!resolved.autoConnect && !resolved.browserUrl && !resolved.wsEndpoint) {
        resolved.autoConnect = true;
      }
      break;
    case 'isolated':
      if (!resolved.isolated) {
        resolved.isolated = true;
      }
      break;
    default:
      if (!resolved.userDataDir && !resolved.browserUrl && !resolved.wsEndpoint) {
        resolved.userDataDir = DEFAULT_PROFILE_DIR;
      }
      break;
  }

  return resolved;
}

/** Convert config into CLI flags for the chrome-devtools-mcp subprocess. */
export function configToArgs(config: BrowserUseConfig): string[] {
  const args: string[] = [];
  const resolved = resolveConfig(config);

  if (resolved.headless) args.push('--headless');
  if (resolved.channel) args.push(`--channel=${resolved.channel}`);
  if (resolved.browserUrl) args.push(`--browser-url=${resolved.browserUrl}`);
  if (resolved.wsEndpoint) args.push(`--ws-endpoint=${resolved.wsEndpoint}`);
  if (resolved.wsHeaders) args.push(`--ws-headers=${resolved.wsHeaders}`);
  if (resolved.executablePath) args.push(`--executable-path=${resolved.executablePath}`);
  if (resolved.viewport) args.push(`--viewport=${resolved.viewport}`);
  if (resolved.isolated) args.push('--isolated');
  if (resolved.userDataDir) args.push(`--user-data-dir=${resolved.userDataDir}`);
  if (resolved.autoConnect) args.push('--auto-connect');
  if (resolved.slim) args.push('--slim');

  if (resolved.categoryPerformance === false) args.push('--category-performance=false');
  if (resolved.categoryNetwork === false) args.push('--category-network=false');
  if (resolved.categoryEmulation === false) args.push('--category-emulation=false');
  if (resolved.categoryExtensions === true) args.push('--category-extensions=true');

  if (resolved.experimentalVision) args.push('--experimental-vision');
  if (resolved.experimentalScreencast) args.push('--experimental-screencast');
  if (resolved.experimentalMemory) args.push('--experimental-memory');
  if (resolved.experimentalPageIdRouting) args.push('--experimental-page-id-routing');

  if (resolved.usageStatistics === false) args.push('--no-usage-statistics');
  if (resolved.performanceCrux === false) args.push('--no-performance-crux');
  if (resolved.redactNetworkHeaders) args.push('--redact-network-headers');
  if (resolved.acceptInsecureCerts) args.push('--accept-insecure-certs');

  for (const pattern of resolved.allowedUrlPattern ?? []) {
    args.push(`--allowed-url-pattern=${pattern}`);
  }
  for (const pattern of resolved.blockedUrlPattern ?? []) {
    args.push(`--blocked-url-pattern=${pattern}`);
  }

  if (resolved.extraArgs) args.push(...resolved.extraArgs);

  return args;
}
