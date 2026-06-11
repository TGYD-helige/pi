import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDashboardWorkspace, readDashboardManifest } from './manifest.js';

describe('dashboard manifest', () => {
  it('creates a dashboard workspace with manifest and agent guidance', async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-manifest-'));
    try {
      const manifest = await ensureDashboardWorkspace(workspaceDir);

      expect(manifest.title).toBe('数据大屏');
      expect(manifest.modules.length).toBeGreaterThan(0);
      await expect(readDashboardManifest(workspaceDir)).resolves.toMatchObject({ version: 1 });
      await expect(readFile(path.join(workspaceDir, 'AGENTS.md'), 'utf8')).resolves.toContain(
        'dashboard.json',
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
