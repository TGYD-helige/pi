import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDashboardWorkspace, readDashboardManifest } from './manifest.js';
import { startDashboardServer } from './server.js';

describe('dashboard server', () => {
  it('serves the dashboard runtime and writes module/layout edits', async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-server-'));
    const server = await startDashboardServer({ workspaceDir, host: '127.0.0.1', port: 0 });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain('dashboard.js');
      expect(html).toContain('dashboardTitle');
      expect(html).toContain('addModuleButton');
      expect(html).toContain('themePresetSelect');
      expect(html).toContain('themeModeButton');

      const addResponse = await fetch(`${server.url}/api/dashboard/modules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          module: { id: 'test-text', type: 'text', title: 'Test Text', content: 'hello' },
        }),
      });
      expect(addResponse.status).toBe(200);

      const layoutResponse = await fetch(`${server.url}/api/dashboard/layout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout: [{ id: 'test-text', x: 2, y: 6, w: 8, h: 4 }] }),
      });
      expect(layoutResponse.status).toBe(200);

      const manifest = await readDashboardManifest(workspaceDir);
      expect(manifest.modules.some((module) => module.id === 'test-text')).toBe(true);
      expect(manifest.layout.find((item) => item.id === 'test-text')).toMatchObject({
        x: 2,
        y: 6,
        w: 8,
        h: 4,
      });
    } finally {
      await server.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('resolves static data sources in the dashboard payload', async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-data-'));
    try {
      await ensureDashboardWorkspace(workspaceDir);
      const server = await startDashboardServer({ workspaceDir, host: '127.0.0.1', port: 0 });
      try {
        const body = (await fetch(`${server.url}/api/dashboard`).then((response) =>
          response.json(),
        )) as {
          data: Record<string, unknown>;
        };
        expect(body.data.overview).toBeTruthy();
      } finally {
        await server.close();
      }
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
