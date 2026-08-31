import { exec } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NPM_PACKAGE = '@wecom/cli';
const INSTALL_DIR = join(homedir(), '.wecom-cli');
const BIN_PATH = join(INSTALL_DIR, 'node_modules', '.bin', 'wecom-cli');

let installAttempted = false;
let cliAvailable: boolean | undefined;

function execAsync(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { signal }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function wecomCliBin(): string {
  if (existsSync(BIN_PATH)) return BIN_PATH;
  return 'wecom-cli';
}

export async function isWeComCliInstalled(): Promise<boolean> {
  if (cliAvailable !== undefined) return cliAvailable;
  try {
    await execAsync(`"${wecomCliBin()}" --version`);
    cliAvailable = true;
    return true;
  } catch {
    cliAvailable = false;
    return false;
  }
}

export async function installWeComCli(): Promise<void> {
  if (installAttempted) return;
  installAttempted = true;
  mkdirSync(INSTALL_DIR, { recursive: true });
  await execAsync(`npm install --prefix "${INSTALL_DIR}" ${NPM_PACKAGE}@latest`);
  cliAvailable = undefined;
}

export async function ensureWeComCli(): Promise<boolean> {
  if (await isWeComCliInstalled()) return true;
  await installWeComCli();
  return isWeComCliInstalled();
}

export async function isWeComCliAuthenticated(signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`"${wecomCliBin()}" auth show --status`, signal);
    return stdout.trim() === 'authorized';
  } catch {
    return false;
  }
}

export async function getWeComCliSkillsDir(): Promise<string | undefined> {
  const localSkills = join(INSTALL_DIR, 'node_modules', '@wecom', 'cli', 'skills');
  if (existsSync(localSkills)) return localSkills;

  try {
    const { stdout } = await execAsync('npm root -g');
    const skillsPath = join(stdout.trim(), '@wecom', 'cli', 'skills');
    if (existsSync(skillsPath)) return skillsPath;
  } catch {
    // ignore
  }

  return undefined;
}
