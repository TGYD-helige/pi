import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createOfficeCli,
  getOfficeCliSkillsDir,
  runOfficeCommand,
} from '@amaster.ai/pi-shared/office-cli';
import type { LarkConfig } from './config.js';

const NPM_PACKAGE = '@larksuite/cli';
const ensureCli = createOfficeCli('lark-cli', NPM_PACKAGE, join(homedir(), '.lark-cli'));

export function ensureLarkCli(signal?: AbortSignal) {
  return ensureCli(signal);
}

export function initLarkCli(config: LarkConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const { appId, appSecret, domain } = config;
    if (!appId || !appSecret) {
      reject(new Error('appId and appSecret are required'));
      return;
    }

    const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR || join(homedir(), '.lark-cli');
    const configFile = join(configDir, 'config.json');

    const brand = domain === 'lark' ? 'lark' : 'feishu';

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { mode: 0o700, recursive: true });
    }

    const configContent = JSON.stringify(
      {
        apps: [
          {
            appId,
            appSecret,
            brand,
            users: [],
          },
        ],
      },
      null,
      2,
    );

    writeFileSync(configFile, `${configContent}\n`, { mode: 0o600 });
    resolve();
  });
}

export async function getLarkCliSkillsDir(file: string, signal?: AbortSignal) {
  try {
    const { stdout } = await runOfficeCommand(file, ['skills', 'path'], { signal });
    const output = stdout.trim();
    if (output && existsSync(output)) return output;
  } catch {
    signal?.throwIfAborted();
  }
  return getOfficeCliSkillsDir(file, NPM_PACKAGE, 'skills', signal);
}
