import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';

export interface VisionModelConfig {
  provider: string;
  model: string;
}

export interface ComputerUseConfig {
  /** 'bundled' uses the packaged binary, 'path' uses a custom binary path */
  mode?: 'bundled' | 'path';
  /** Custom cua-driver binary path (used when mode is 'path') */
  binaryPath?: string;
  /** Extra CLI args passed to cua-driver mcp */
  extraArgs?: string[];
  /** Vision model for screenshot analysis */
  visionModel?: VisionModelConfig;
  /** Ask once per app target before launch_app. Default: true */
  confirmAppLaunch?: boolean;
  /** Confirm high-risk tools such as kill_app and replay_trajectory. Default: true */
  confirmDangerousActions?: boolean;
  /**
   * Which driver tools are active at session start: 'core' activates only the
   * everyday toolset (extra groups via the computer_use_tools tool or the
   * /computer-use-tools command), 'full' activates every tool. Default: 'core'
   */
  toolProfile?: 'core' | 'full';
}

const DEFAULTS: Partial<ComputerUseConfig> = {
  mode: 'bundled',
  confirmAppLaunch: true,
  confirmDangerousActions: true,
  toolProfile: 'core',
};

export function resolveConfig(config?: ComputerUseConfig): ComputerUseConfig {
  return { ...DEFAULTS, ...config };
}

export function loadConfigFromFile(options?: PiSettingsOptions): ComputerUseConfig {
  return loadPiSettings<ComputerUseConfig>('pi-computer-use', {
    ...options,
  });
}
