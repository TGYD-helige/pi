/**
 * Dreaming state persistence — tracks when the last consolidation ran.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
    return JSON.parse(raw) as DreamingState;
  } catch {
    return { lastConsolidatedAt: null, lastSessionCount: 0 };
  }
}

export async function writeDreamingState(state: DreamingState, memoryDir?: string): Promise<void> {
  const filePath = statePath(memoryDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}
