/**
 * Dreaming state persistence — tracks when the last consolidation ran.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SafeToolError } from '@amaster.ai/pi-shared';
import { resolveHome } from '@amaster.ai/pi-shared/settings';

export interface DreamScanCursor {
  path: string;
  modified: number;
}

export interface DreamingState {
  scanCursor?: DreamScanCursor;
  lastConsolidatedAt: string | null;
  lastSessionCount: number;
}

const STATE_FILE = 'memories/dreaming-state.json';

function statePath(memoryDir?: string): string {
  return memoryDir ? join(memoryDir, 'dreaming-state.json') : join(resolveHome(), STATE_FILE);
}

export async function readDreamingState(memoryDir?: string): Promise<DreamingState> {
  try {
    const raw = await readFile(statePath(memoryDir), 'utf-8');
    const state = JSON.parse(raw) as DreamingState | null;
    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      !(
        state.lastConsolidatedAt === null ||
        (typeof state.lastConsolidatedAt === 'string' &&
          Number.isFinite(Date.parse(state.lastConsolidatedAt)))
      ) ||
      !Number.isInteger(state.lastSessionCount) ||
      state.lastSessionCount < 0 ||
      (state.scanCursor !== undefined &&
        (!state.scanCursor ||
          typeof state.scanCursor.path !== 'string' ||
          !Number.isFinite(state.scanCursor.modified)))
    )
      throw new Error('Invalid checkpoint schema');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { lastConsolidatedAt: null, lastSessionCount: 0 };
    throw new SafeToolError(
      'Read memory consolidation checkpoint',
      error,
      'The checkpoint is unreadable or malformed. Restore it before running consolidation; progress was not reset.',
    );
  }
}

export async function writeDreamingState(state: DreamingState, memoryDir?: string): Promise<void> {
  const filePath = statePath(memoryDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}
