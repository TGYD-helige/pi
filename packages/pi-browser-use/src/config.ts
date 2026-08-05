import { homedir } from 'node:os';
import { join } from 'node:path';

/** Vision model used by the optional analyze_screenshot tool. */
export interface VisionModelConfig {
  provider: string;
  model: string;
}

export type BrowserSessionMode = 'persistent' | 'isolated' | 'existing';

export type BrowserReadPolicyV1 = {
  version: 'browser_read_policy_v1';
  accessMode: 'public' | 'authenticated';
  allowedTopLevelLocators: string[];
  allowedTopLevelOrigins: string[];
  subresources: 'public_or_same_origin';
  privateCrossOriginSubresources: 'deny';
  popups: 'deny';
  downloads: 'deny';
  newTargets: 'deny';
  observation?: {
    runId: string;
    retention: 'source_summary_only_v1';
  };
};

/** Configuration for the chrome-devtools-mcp upstream process. */
export interface BrowserUseConfig {
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
  readPolicy?: BrowserReadPolicyV1;

  slim?: boolean;
  extraArgs?: string[];
}

export const DEFAULT_PROFILE_DIR = join(homedir(), '.pi', 'browser-profile');

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
};

/** Merge user config over sane defaults. */
export function resolveConfig(config?: BrowserUseConfig): BrowserUseConfig {
  const resolved = { ...DEFAULTS, ...config };

  if (resolved.allowedUrlPattern?.length && resolved.blockedUrlPattern?.length) {
    throw new Error('allowedUrlPattern and blockedUrlPattern cannot be used together');
  }

  if (resolved.readPolicy) {
    if (resolved.readPolicy.accessMode === 'public' && resolved.sessionMode !== 'isolated') {
      throw new Error('public browser read policy requires isolated session mode');
    }
    if (resolved.readPolicy.accessMode === 'authenticated' && resolved.sessionMode !== 'existing') {
      throw new Error('authenticated browser read policy requires existing session mode');
    }
    if (resolved.allowedUrlPattern?.length || resolved.blockedUrlPattern?.length) {
      throw new Error('browser read policy owns URL filtering configuration');
    }
    if (
      resolved.browserUrl ||
      resolved.wsEndpoint ||
      resolved.wsHeaders ||
      resolved.autoConnect ||
      resolved.extraArgs?.length
    ) {
      throw new Error('browser read policy requires a package-managed browser session');
    }
    if (resolved.readPolicy.accessMode === 'public' && resolved.userDataDir) {
      throw new Error('public browser read policy requires an ephemeral profile');
    }
    if (resolved.readPolicy.accessMode === 'authenticated' && !resolved.userDataDir) {
      throw new Error('authenticated browser read policy requires an adapter-resolved profile');
    }
  }

  if (resolved.slim) {
    if (config?.experimentalPageIdRouting === true) {
      throw new Error('experimentalPageIdRouting cannot be used with slim mode');
    }
    resolved.experimentalPageIdRouting = false;
  }

  switch (resolved.sessionMode) {
    case 'existing':
      if (
        !resolved.readPolicy &&
        !resolved.autoConnect &&
        !resolved.browserUrl &&
        !resolved.wsEndpoint
      ) {
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
