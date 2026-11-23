import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createOfficeCli,
  getOfficeCliSkillsDir,
  runOfficeCommand,
} from '@amaster.ai/pi-shared/office-cli';

const NPM_PACKAGE = '@wecom/cli';
const ensureCli = createOfficeCli('wecom-cli', NPM_PACKAGE, join(homedir(), '.wecom-cli'));

export function ensureWeComCli(signal?: AbortSignal) {
  return ensureCli(signal);
}

export async function isWeComCliAuthenticated(
  file: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const { stdout } = await runOfficeCommand(file, ['auth', 'show', '--status'], { signal });
    return stdout.trim() === 'authorized';
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

export async function getWeComCliSkillsDir(file: string, signal?: AbortSignal) {
  return getOfficeCliSkillsDir(file, NPM_PACKAGE, 'skills', signal);
}
