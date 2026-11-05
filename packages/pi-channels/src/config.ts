import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ValidationError } from '@amaster.ai/pi-shared';
import { loadPiSettings, resolveConfigDir } from '@amaster.ai/pi-shared/settings';
import type { ChannelConfig } from './types.js';

const SETTINGS_KEY = 'pi-channels';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function section(settings: Record<string, unknown>): ChannelConfig {
  const value = settings[SETTINGS_KEY];
  return isRecord(value) ? (value as ChannelConfig) : {};
}

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(parsed)) throw new Error('Settings must be an object');
    return parsed;
  } catch {
    throw new ValidationError(
      'settings.json is unreadable or malformed. Fix the existing file before updating channel configuration; it has not been replaced.',
      'configuration_error',
    );
  }
}

function writeSettingsFile(path: string, settings: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function discoverLocalSettingsFiles(cwd: string, projectTrusted: boolean): string[] {
  if (!projectTrusted) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  const add = (path: string) => {
    const resolved = resolve(path);
    if (seen.has(resolved) || !existsSync(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };

  let current = resolve(cwd);
  const upwards: string[] = [];
  while (true) {
    upwards.push(join(current, '.pi', 'settings.json'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const path of upwards.reverse()) add(path);
  return found;
}

function mergeChannelConfig(base: ChannelConfig, override: ChannelConfig): ChannelConfig {
  return {
    adapters: {
      ...(base.adapters ?? {}),
      ...(override.adapters ?? {}),
    },
    routes: {
      ...(base.routes ?? {}),
      ...(override.routes ?? {}),
    },
    bridge: {
      ...(base.bridge ?? {}),
      ...(override.bridge ?? {}),
    },
  };
}

export function loadChannelConfig(cwd: string, projectTrusted = false): ChannelConfig {
  const config = loadPiSettings<ChannelConfig>(SETTINGS_KEY, { cwd, projectTrusted });

  const settingsFiles = discoverLocalSettingsFiles(cwd, projectTrusted);
  const local = settingsFiles.reduce(
    (merged, path) => mergeChannelConfig(merged, section(readSettingsFile(path))),
    {} as ChannelConfig,
  );

  const merged = mergeChannelConfig(config, local);

  applyEnvOverrides(merged);
  if (process.env.DEBUG?.includes('pi-channels')) {
    console.error('[pi-channels] config', {
      cwd,
      settingsFiles,
      adapters: Object.keys(merged.adapters ?? {}),
      routes: Object.keys(merged.routes ?? {}),
      bridgeEnabled: Boolean(merged.bridge?.enabled),
    });
  }
  return merged;
}

export function updateLocalChannelConfig(
  cwd: string,
  update: (config: ChannelConfig) => ChannelConfig,
  projectTrusted = false,
): boolean {
  const agentSettingsFile = join(resolveConfigDir(), 'settings.json');
  const settingsFile =
    discoverLocalSettingsFiles(cwd, projectTrusted).at(-1) ??
    (existsSync(agentSettingsFile) ? agentSettingsFile : undefined);
  if (!settingsFile) return false;

  const settings = readSettingsFile(settingsFile);
  const current = section(settings);
  const next = update(current);
  settings[SETTINGS_KEY] = next;
  writeSettingsFile(settingsFile, settings);
  return true;
}

function applyEnvOverrides(config: ChannelConfig): void {
  if (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) {
    config.adapters ??= {};
    config.adapters.feishu ??= { type: 'feishu' };
    if (process.env.FEISHU_APP_ID) config.adapters.feishu.appId = process.env.FEISHU_APP_ID;
    if (process.env.FEISHU_APP_SECRET) {
      config.adapters.feishu.appSecret = process.env.FEISHU_APP_SECRET;
    }
  }

  if (process.env.WECOM_BOT_ID || process.env.WECOM_BOT_SECRET) {
    config.adapters ??= {};
    config.adapters.wecom ??= { type: 'wecom' };
    if (process.env.WECOM_BOT_ID) config.adapters.wecom.botId = process.env.WECOM_BOT_ID;
    if (process.env.WECOM_BOT_SECRET) config.adapters.wecom.secret = process.env.WECOM_BOT_SECRET;
  }

  if (process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_CLIENT_SECRET) {
    config.adapters ??= {};
    config.adapters.dingtalk ??= { type: 'dingtalk' };
    if (process.env.DINGTALK_CLIENT_ID) {
      config.adapters.dingtalk.clientId = process.env.DINGTALK_CLIENT_ID;
    }
    if (process.env.DINGTALK_CLIENT_SECRET) {
      config.adapters.dingtalk.clientSecret = process.env.DINGTALK_CLIENT_SECRET;
    }
    if (process.env.DINGTALK_ROBOT_CODE) {
      config.adapters.dingtalk.robotCode = process.env.DINGTALK_ROBOT_CODE;
    }
  }

  if (process.env.WEBHOOK_SECRET) {
    config.adapters ??= {};
    config.adapters.webhook ??= { type: 'webhook' };
    config.adapters.webhook.secret = process.env.WEBHOOK_SECRET;
  }
}
