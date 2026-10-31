import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadPiPolicyProfiles, loadPiPolicyProfilesAsync } from '@amaster.ai/pi-shared/settings';
import type { SecurityProfileConfig } from './index.js';

export function loadPolicyDir(dirPath: string): Record<string, SecurityProfileConfig> {
  const result: Record<string, SecurityProfileConfig> = {};
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const profileName = basename(entry, '.json');
    try {
      const raw = readFileSync(join(dirPath, entry), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result[profileName] = parsed as SecurityProfileConfig;
      }
    } catch {
      // skip malformed files
    }
  }
  return result;
}

export type LoadFilePoliciesOptions = {
  cwd: string;
  configDir?: string;
  projectTrusted?: boolean;
};

export function loadFilePolicies(
  options: LoadFilePoliciesOptions,
): Record<string, SecurityProfileConfig> {
  return loadPiPolicyProfiles<SecurityProfileConfig>({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
  });
}

export function loadFilePoliciesAsync(
  options: LoadFilePoliciesOptions,
): Promise<Record<string, SecurityProfileConfig>> {
  return loadPiPolicyProfilesAsync<SecurityProfileConfig>(options);
}
