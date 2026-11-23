import { homedir } from 'node:os';
import { join } from 'node:path';
import { createOfficeCli, getOfficeCliSkillsDir, runOfficeCommand } from '@amaster.ai/pi-shared';
import type { DingTalkConfig } from './config.js';

const NPM_PACKAGE = 'dingtalk-workspace-cli';
const ensureCli = createOfficeCli('dws', NPM_PACKAGE, join(homedir(), '.dws'));

export function ensureDws(signal?: AbortSignal) {
  return ensureCli(signal);
}

export async function initDws(
  file: string,
  config: DingTalkConfig,
  signal?: AbortSignal,
): Promise<void> {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) {
    throw new Error('clientId and clientSecret are required');
  }
  try {
    // Environment variables keep the secret out of the process arguments.
    await runOfficeCommand(file, ['auth', 'login', '--yes'], {
      env: { DWS_CLIENT_ID: clientId, DWS_CLIENT_SECRET: clientSecret },
      signal,
    });
  } catch {
    signal?.throwIfAborted();
    throw new Error('dws auth login failed');
  }
}

export async function getDwsSkillsDir(file: string, signal?: AbortSignal) {
  return getOfficeCliSkillsDir(file, NPM_PACKAGE, join('skills', 'multi'), signal);
}
