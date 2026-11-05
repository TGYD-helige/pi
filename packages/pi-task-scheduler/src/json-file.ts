import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SafeToolError } from '@amaster.ai/pi-shared';

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
        console.error('[pi-task-scheduler] primary JSON is malformed; recovered from backup');
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
  const backupCandidate = `${tempPath}.bak`;
  try {
    await copyFile(filePath, backupCandidate);
    await readJsonFileStrict<unknown>(backupCandidate);
    await rename(backupCandidate, backupPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('[pi-task-scheduler] primary JSON is malformed; retained the existing backup');
    } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await rm(backupCandidate, { force: true }).catch(() =>
      console.error('[pi-task-scheduler] backup cleanup failed'),
    );
  }
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() =>
      console.error('[pi-task-scheduler] temporary JSON cleanup failed'),
    );
    throw error;
  }
}

function readJsonFileStrict<T>(filePath: string): Promise<T> {
  return readFile(filePath, 'utf8').then((content) => JSON.parse(content) as T);
}

function jsonBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}
