import { randomBytes } from 'node:crypto';
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SafeToolError } from '@amaster.ai/pi-shared';
import lockfile from 'proper-lockfile';
import { firstThreatMessage, scanForThreats } from './threat-patterns.js';

export const ENTRY_DELIMITER = '\n§\n';

export type MemoryTarget = 'memory' | 'user';

export type MemoryStoreOptions = {
  /** Directory where MEMORY.md and USER.md live. */
  dir: string;
  /** Char limit for MEMORY.md. Default 2200. */
  memoryCharLimit?: number;
  /** Char limit for USER.md. Default 1375. */
  userCharLimit?: number;
};

export type MemorySuccessResult = {
  success: true;
  target: MemoryTarget;
  entries: string[];
  usage: string;
  entryCount: number;
  message?: string;
};

export type MemoryDriftError = {
  success: false;
  error: string;
  driftBackup: string;
  remediation: string;
};

export type MemoryErrorResult = {
  success: false;
  error: string;
  matches?: string[];
  currentEntries?: string[];
  usage?: string;
};

export type MemoryResult = MemorySuccessResult | MemoryDriftError | MemoryErrorResult;

const FILENAME: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
};

const HEADER_LABEL: Record<MemoryTarget, string> = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
};

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

/**
 * Bounded curated memory with file persistence.
 *
 * Two parallel states:
 *  - `_systemPromptSnapshot`: a sanitized prompt snapshot rebuilt explicitly
 *    by `loadFromDisk()`.
 *  - `memoryEntries` / `userEntries`: live state, refreshed by `read()`,
 *    mutated by tool calls, and persisted to disk.
 */
export class MemoryStore {
  readonly dir: string;
  readonly memoryCharLimit: number;
  readonly userCharLimit: number;

  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private systemPromptSnapshot: Record<MemoryTarget, string> = { memory: '', user: '' };
  private loaded = false;

  constructor(opts: MemoryStoreOptions) {
    this.dir = opts.dir;
    this.memoryCharLimit = opts.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
    this.userCharLimit = opts.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
  }

  /**
   * Load entries from MEMORY.md and USER.md, capture system prompt snapshot.
   *
   * Each entry is scanned for injection / promptware patterns at strict
   * scope; ANY match replaces the entry text in the snapshot with a
   * `[BLOCKED: …]` placeholder so a poisoned-on-disk file (supply chain,
   * compromised tool, sister-session write) cannot enter the system
   * prompt. Live state keeps the original so the user can inspect and
   * remove via `memory_read` / `memory_remove`.
   */
  async loadFromDisk(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.refreshLiveEntries();
    this.rebuildSystemPromptSnapshot();
    this.loaded = true;
  }

  /** Return frozen snapshot for system prompt injection. Empty string if no entries. */
  formatForSystemPrompt(target: MemoryTarget): string {
    return this.systemPromptSnapshot[target] ?? '';
  }

  /** Combined memory + user snapshot block, with a blank line between them. */
  formatAllForSystemPrompt(): string {
    const parts = [this.formatForSystemPrompt('memory'), this.formatForSystemPrompt('user')].filter(
      (s) => s.length > 0,
    );
    return parts.join('\n\n');
  }

  /** Live entries, not the frozen snapshot. */
  getEntries(target: MemoryTarget): string[] {
    return [...this.entriesFor(target)];
  }

  async add(target: MemoryTarget, content: string): Promise<MemoryResult> {
    const trimmed = content.trim();
    if (!trimmed) {
      return { success: false, error: 'Content cannot be empty.' };
    }
    const scanError = firstThreatMessage(trimmed, 'strict');
    if (scanError) {
      return { success: false, error: scanError };
    }

    return this.withFileLock(target, async () => {
      const drift = await this.reloadTarget(target);
      if (drift) return driftError(this.pathFor(target), drift);

      const entries = this.entriesFor(target);
      const limit = this.charLimit(target);

      if (entries.includes(trimmed)) {
        return this.successResponse(target, 'Entry already exists (no duplicate added).');
      }

      const newEntries = [...entries, trimmed];
      const newTotal = newEntries.join(ENTRY_DELIMITER).length;
      if (newTotal > limit) {
        const current = this.charCount(target);
        return {
          success: false,
          error:
            `Memory at ${current.toLocaleString()}/${limit.toLocaleString()} chars. ` +
            `Adding this entry (${trimmed.length} chars) would exceed the limit. ` +
            `Replace or remove existing entries first.`,
          currentEntries: [...entries],
          usage: `${current.toLocaleString()}/${limit.toLocaleString()}`,
        };
      }

      this.setEntries(target, newEntries);
      await this.saveToDisk(target);
      return this.successResponse(target, 'Entry added.');
    });
  }

  async replace(target: MemoryTarget, oldText: string, newContent: string): Promise<MemoryResult> {
    const oldTrim = oldText.trim();
    const newTrim = newContent.trim();
    if (!oldTrim) return { success: false, error: 'oldText cannot be empty.' };
    if (!newTrim)
      return {
        success: false,
        error: "newContent cannot be empty. Use 'remove' to delete entries.",
      };

    const scanError = firstThreatMessage(newTrim, 'strict');
    if (scanError) return { success: false, error: scanError };

    return this.withFileLock(target, async () => {
      const drift = await this.reloadTarget(target);
      if (drift) return driftError(this.pathFor(target), drift);

      const entries = this.entriesFor(target);
      const matches = entries
        .map((entry, i) => ({ entry, i }))
        .filter(({ entry }) => entry.includes(oldTrim));

      if (matches.length === 0) {
        return { success: false, error: `No entry matched '${oldTrim}'.` };
      }

      if (matches.length > 1) {
        const uniqueTexts = new Set(matches.map((m) => m.entry));
        if (uniqueTexts.size > 1) {
          return {
            success: false,
            error: `Multiple entries matched '${oldTrim}'. Be more specific.`,
            matches: matches.map(({ entry }) =>
              entry.length > 80 ? `${entry.slice(0, 80)}...` : entry,
            ),
          };
        }
      }

      const idx = matches[0]!.i;
      const limit = this.charLimit(target);
      const test = [...entries];
      test[idx] = newTrim;
      const newTotal = test.join(ENTRY_DELIMITER).length;
      if (newTotal > limit) {
        return {
          success: false,
          error:
            `Replacement would put memory at ${newTotal.toLocaleString()}/${limit.toLocaleString()} chars. ` +
            `Shorten the new content or remove other entries first.`,
        };
      }

      this.setEntries(target, test);
      await this.saveToDisk(target);
      return this.successResponse(target, 'Entry replaced.');
    });
  }

  async remove(target: MemoryTarget, oldText: string): Promise<MemoryResult> {
    const oldTrim = oldText.trim();
    if (!oldTrim) return { success: false, error: 'oldText cannot be empty.' };

    return this.withFileLock(target, async () => {
      const drift = await this.reloadTarget(target);
      if (drift) return driftError(this.pathFor(target), drift);

      const entries = this.entriesFor(target);
      const matches = entries
        .map((entry, i) => ({ entry, i }))
        .filter(({ entry }) => entry.includes(oldTrim));

      if (matches.length === 0) {
        return { success: false, error: `No entry matched '${oldTrim}'.` };
      }

      if (matches.length > 1) {
        const uniqueTexts = new Set(matches.map((m) => m.entry));
        if (uniqueTexts.size > 1) {
          return {
            success: false,
            error: `Multiple entries matched '${oldTrim}'. Be more specific.`,
            matches: matches.map(({ entry }) =>
              entry.length > 80 ? `${entry.slice(0, 80)}...` : entry,
            ),
          };
        }
      }

      const idx = matches[0]!.i;
      const next = [...entries.slice(0, idx), ...entries.slice(idx + 1)];
      this.setEntries(target, next);
      await this.saveToDisk(target);
      return this.successResponse(target, 'Entry removed.');
    });
  }

  async read(target: MemoryTarget): Promise<MemorySuccessResult> {
    if (!this.loaded) {
      await this.loadFromDisk();
    } else {
      await this.refreshLiveEntries(target);
    }
    return this.successResponse(target);
  }

  // -- internals -----------------------------------------------------------

  private pathFor(target: MemoryTarget): string {
    return path.join(this.dir, FILENAME[target]);
  }

  private entriesFor(target: MemoryTarget): string[] {
    return target === 'user' ? this.userEntries : this.memoryEntries;
  }

  private setEntries(target: MemoryTarget, entries: string[]): void {
    if (target === 'user') this.userEntries = entries;
    else this.memoryEntries = entries;
  }

  private charLimit(target: MemoryTarget): number {
    return target === 'user' ? this.userCharLimit : this.memoryCharLimit;
  }

  private charCount(target: MemoryTarget): number {
    const entries = this.entriesFor(target);
    return entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length;
  }

  private successResponse(target: MemoryTarget, message?: string): MemorySuccessResult {
    const entries = this.entriesFor(target);
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    const result: MemorySuccessResult = {
      success: true,
      target,
      entries: [...entries],
      usage: `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
      entryCount: entries.length,
    };
    if (message) result.message = message;
    return result;
  }

  private async refreshLiveEntries(target?: MemoryTarget): Promise<void> {
    if (!target || target === 'memory') {
      this.memoryEntries = dedupe(await readEntriesFile(this.pathFor('memory')));
    }
    if (!target || target === 'user') {
      this.userEntries = dedupe(await readEntriesFile(this.pathFor('user')));
    }
  }

  private rebuildSystemPromptSnapshot(): void {
    this.systemPromptSnapshot = {
      memory: this.renderBlock('memory', sanitizeForSnapshot(this.memoryEntries, FILENAME.memory)),
      user: this.renderBlock('user', sanitizeForSnapshot(this.userEntries, FILENAME.user)),
    };
  }

  private renderBlock(target: MemoryTarget, entries: string[]): string {
    if (entries.length === 0) return '';
    const limit = this.charLimit(target);
    const content = entries.join(ENTRY_DELIMITER);
    const current = content.length;
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    const header = `${HEADER_LABEL[target]} [${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars]`;
    const sep = '═'.repeat(46);
    return `${sep}\n${header}\n${sep}\n${content}`;
  }

  private async saveToDisk(target: MemoryTarget): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.pathFor(target), this.entriesFor(target).join(ENTRY_DELIMITER));
  }

  /**
   * Re-read entries from disk. Returns backup-path string when external
   * drift was detected (the on-disk file contains content that wouldn't
   * round-trip through the parser/serializer, OR an entry larger than the
   * store's char limit). Caller must abort the mutation when drift is
   * detected — flushing would discard the un-roundtrippable content.
   */
  private async reloadTarget(target: MemoryTarget): Promise<string | null> {
    const drift = await this.detectExternalDrift(target);
    const fresh = dedupe(await readEntriesFile(this.pathFor(target)));
    this.setEntries(target, fresh);
    return drift;
  }

  private async detectExternalDrift(target: MemoryTarget): Promise<string | null> {
    const p = this.pathFor(target);
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SafeToolError(
        'Memory read',
        err,
        'The existing memory file was not replaced. Check file access before retrying.',
      );
    }
    if (!raw.trim()) return null;

    const parsed = raw
      .split(ENTRY_DELIMITER)
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    const roundtrip = parsed.join(ENTRY_DELIMITER);
    const charLimit = this.charLimit(target);
    const maxEntryLen = parsed.reduce((m, e) => Math.max(m, e.length), 0);

    const drift = raw.trim() !== roundtrip || maxEntryLen > charLimit;
    if (!drift) return null;

    const ts = Math.floor(Date.now() / 1000);
    const bakPath = `${p}.bak.${ts}`;
    try {
      await fs.writeFile(bakPath, raw, { encoding: 'utf-8' });
    } catch {
      return `${bakPath} (BACKUP FAILED — file unchanged on disk)`;
    }
    return bakPath;
  }

  private async withFileLock<T>(target: MemoryTarget, fn: () => Promise<T>): Promise<T> {
    const lockTarget = this.pathFor(target);
    await fs.mkdir(this.dir, { recursive: true });
    // proper-lockfile requires the file to exist; create empty if missing.
    try {
      await fs.access(lockTarget);
    } catch {
      try {
        await fs.writeFile(lockTarget, '', { encoding: 'utf-8', flag: 'wx' });
      } catch {
        /* race: another caller created it */
      }
    }

    const release = await lockfile.lock(lockTarget, {
      retries: { retries: 10, minTimeout: 50, maxTimeout: 500, factor: 1.5 },
      stale: 30_000,
    });
    try {
      return await fn();
    } finally {
      try {
        await release();
      } catch {
        /* lock already released */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function readEntriesFile(p: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SafeToolError(
      'Memory read',
      err,
      'The existing memory file was not replaced. Check file access before retrying.',
    );
  }
  if (!raw.trim()) return [];
  return raw
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

function sanitizeForSnapshot(entries: string[], filename: string): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry) {
      out.push(entry);
      continue;
    }
    if (entry.startsWith('[BLOCKED:')) {
      out.push(
        `[BLOCKED: ${filename} contained an untrusted blocked-looking entry. ` +
          `Removed from system prompt; use memory_read to inspect the original.]`,
      );
      continue;
    }
    const findings = scanForThreats(entry, 'strict');
    if (findings.length > 0) {
      out.push(
        `[BLOCKED: ${filename} entry contained threat pattern(s): ${findings.join(', ')}. ` +
          `Removed from system prompt; use memory_read to inspect and memory_remove to delete the original.]`,
      );
    } else {
      out.push(entry);
    }
  }
  return out;
}

function driftError(filePath: string, bakPath: string): MemoryDriftError {
  const name = path.basename(filePath);
  return {
    success: false,
    error:
      `Refusing to write ${name}: file on disk has content that wouldn't round-trip through the memory tool ` +
      `(likely added by a patch tool, a shell append, a manual edit, or a concurrent session). ` +
      `A snapshot was saved to ${bakPath}. Resolve the drift first — either rewrite the file as a clean ` +
      `§-delimited list of entries, or move the extra content out — then retry. This guard exists to prevent silent data loss.`,
    driftBackup: bakPath,
    remediation:
      `Open the .bak file, integrate the missing entries into the memory tool one at a time via memory_add, ` +
      `then remove or rewrite the original file to a clean state.`,
  };
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  // ensure the dir exists synchronously before tempfile creation
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.mem_${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf-8' });
    await fs.rename(tmp, target);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
