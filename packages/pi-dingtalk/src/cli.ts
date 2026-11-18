import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DingTalkConfig } from './config.js';

const NPM_PACKAGE = 'dingtalk-workspace-cli';
const INSTALL_DIR = join(homedir(), '.dws');
const BIN_PATH = join(INSTALL_DIR, 'node_modules', '.bin', 'dws');

let installAttempted = false;
let cliAvailable: boolean | undefined;

function execAsync(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function dwsBin(): string {
  if (existsSync(BIN_PATH)) return BIN_PATH;
  return 'dws';
}

export async function isDwsInstalled(): Promise<boolean> {
  if (cliAvailable !== undefined) return cliAvailable;
  try {
    await execAsync(dwsBin(), ['--version']);
    cliAvailable = true;
    return true;
  } catch {
    cliAvailable = false;
    return false;
  }
}

export async function installDws(): Promise<void> {
  if (installAttempted) return;
  installAttempted = true;
  mkdirSync(INSTALL_DIR, { recursive: true });
  await execAsync('npm', ['install', '--prefix', INSTALL_DIR, `${NPM_PACKAGE}@latest`]);
  cliAvailable = undefined;
}

export async function ensureDws(): Promise<boolean> {
  if (await isDwsInstalled()) return true;
  await installDws();
  return isDwsInstalled();
}

export async function initDws(config: DingTalkConfig): Promise<void> {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) {
    throw new Error('clientId and clientSecret are required');
  }
  const bin = dwsBin();
  try {
    // Environment variables keep the secret out of the process list that `ps` exposes.
    await execAsync(bin, ['auth', 'login', '--yes'], {
      ...process.env,
      DWS_CLIENT_ID: clientId,
      DWS_CLIENT_SECRET: clientSecret,
    });
  } catch {
    throw new Error('dws auth login failed');
  }
}

export async function getDwsSkillsDir(): Promise<string | undefined> {
  const localSkills = join(
    INSTALL_DIR,
    'node_modules',
    'dingtalk-workspace-cli',
    'skills',
    'multi',
  );
  if (existsSync(localSkills)) return localSkills;

  try {
    const { stdout } = await execAsync('npm', ['root', '-g']);
    const skillsPath = join(stdout.trim(), 'dingtalk-workspace-cli', 'skills', 'multi');
    if (existsSync(skillsPath)) return skillsPath;
  } catch {
    // ignore
  }

  return undefined;
}
