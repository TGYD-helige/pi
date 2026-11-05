import { SafeToolError } from '@amaster.ai/pi-shared';
/**
 * Minimal JSON-file persistence helpers.
 *
 * Owns directory creation, missing-file fallbacks, private-file permissions, and
 * atomic-ish JSON writes used by local stores. Keep domain-specific schema and
 * retention behavior in the store modules.
 */

import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const backupPath = jsonBackupPath(filePath);
  try {
    return await readJsonFileStrict<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      try {
        const restored = await readJsonFileStrict<T>(backupPath);
        console.error('[pi-storage] primary JSON is malformed; recovered from backup');
        return restored;
      } catch (backupError) {
        throw new SafeToolError(
          'Read stored JSON',
          backupError,
          'The primary file is corrupt and its backup is unavailable or malformed. Refusing to initialize empty data; restore the file or backup before retrying.',
        );
      }
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const backupPath = jsonBackupPath(filePath);
  await copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeJsonFile(filePath, value);
  await chmod(filePath, 0o600).catch(() => undefined);
}

function readJsonFileStrict<T>(filePath: string): Promise<T> {
  return readFile(filePath, 'utf8').then((content) => JSON.parse(content) as T);
}

function jsonBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}

export async function appendJsonlFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`);
}

export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const results: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}
