import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ snapshot: undefined as unknown }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('/tool-categories.json')) {
        if (state.snapshot === undefined) throw new Error('ENOENT');
        return JSON.stringify(state.snapshot);
      }
      return fs.readFileSync(...args);
    },
  };
});
const { loadCategoryMap } = await import('../tool-groups.js');
const version = createRequire(import.meta.url)('chrome-devtools-mcp/package.json').version;

describe('browser tool category snapshot', () => {
  it('uses build metadata only for the installed upstream version', async () => {
    state.snapshot = { packageVersion: version, categories: { marker: 'debugging' } };
    expect(await loadCategoryMap()).toEqual({ marker: 'debugging' });
  });
  it('preserves live discovery when metadata is absent, stale or malformed', async () => {
    state.snapshot = undefined;
    const live = await loadCategoryMap();
    expect(Object.keys(live).length).toBeGreaterThan(0);
    for (const snapshot of [
      { packageVersion: '0.0.0-stale', categories: { marker: 'debugging' } },
      { packageVersion: version, categories: { marker: 42 } },
      { packageVersion: version, categories: [] },
    ]) {
      state.snapshot = snapshot;
      expect(await loadCategoryMap()).toEqual(live);
    }
  });
});
