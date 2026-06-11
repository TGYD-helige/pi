import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DashboardLayoutItem, DashboardManifest, DashboardModule } from './types.js';

export const DASHBOARD_MANIFEST_FILE = 'dashboard.json';
export const DASHBOARD_AGENTS_FILE = 'AGENTS.md';

export async function ensureDashboardWorkspace(workspaceDir: string): Promise<DashboardManifest> {
  const resolved = path.resolve(workspaceDir);
  await mkdir(resolved, { recursive: true });
  const manifestPath = dashboardManifestPath(resolved);
  let manifest = await readDashboardManifest(resolved).catch(() => undefined);
  if (!manifest) {
    manifest = createDefaultManifest();
    await writeDashboardManifest(resolved, manifest);
  }
  await writeAgentsFile(resolved);
  await mkdir(path.join(resolved, 'data'), { recursive: true });
  await mkdir(path.join(resolved, 'modules'), { recursive: true });
  await writeFileIfMissing(
    path.join(resolved, 'data', 'README.md'),
    '# Dashboard Data\n\nPut static data examples or API notes here.\n',
  );
  await readFile(manifestPath, 'utf8');
  return manifest;
}

export function dashboardManifestPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), DASHBOARD_MANIFEST_FILE);
}

export async function readDashboardManifest(workspaceDir: string): Promise<DashboardManifest> {
  const raw = await readFile(dashboardManifestPath(workspaceDir), 'utf8');
  return normalizeManifest(JSON.parse(raw) as unknown);
}

export async function writeDashboardManifest(
  workspaceDir: string,
  manifest: DashboardManifest,
): Promise<DashboardManifest> {
  const normalized = normalizeManifest({ ...manifest, updatedAt: new Date().toISOString() });
  await mkdir(path.resolve(workspaceDir), { recursive: true });
  await writeFile(
    dashboardManifestPath(workspaceDir),
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf8',
  );
  return normalized;
}

export async function updateDashboardLayout(
  workspaceDir: string,
  layout: DashboardLayoutItem[],
): Promise<DashboardManifest> {
  const manifest = await readDashboardManifest(workspaceDir);
  return writeDashboardManifest(workspaceDir, {
    ...manifest,
    layout: layout.map(normalizeLayoutItem).filter(Boolean) as DashboardLayoutItem[],
  });
}

export async function upsertDashboardModule(
  workspaceDir: string,
  module: DashboardModule,
  layout?: DashboardLayoutItem,
): Promise<DashboardManifest> {
  const manifest = await readDashboardManifest(workspaceDir);
  const modules = manifest.modules.some((item) => item.id === module.id)
    ? manifest.modules.map((item) => (item.id === module.id ? module : item))
    : [...manifest.modules, module];
  const nextLayout = layout
    ? upsertLayout(manifest.layout, layout)
    : manifest.layout.some((item) => item.id === module.id)
      ? manifest.layout
      : [...manifest.layout, defaultLayoutForModule(module.id, manifest.layout.length)];
  return writeDashboardManifest(workspaceDir, { ...manifest, modules, layout: nextLayout });
}

export async function deleteDashboardModule(
  workspaceDir: string,
  moduleId: string,
): Promise<DashboardManifest> {
  const manifest = await readDashboardManifest(workspaceDir);
  return writeDashboardManifest(workspaceDir, {
    ...manifest,
    modules: manifest.modules.filter((item) => item.id !== moduleId),
    layout: manifest.layout.filter((item) => item.id !== moduleId),
  });
}

export function createDefaultManifest(): DashboardManifest {
  return {
    version: 1,
    title: '数据大屏',
    description: '由 Pi Dashboard runtime 渲染的独立大屏。',
    theme: {
      preset: 'aurora',
      mode: 'dark',
      accent: '#14b8a6',
      accentSoft: 'rgba(20, 184, 166, 0.14)',
      accentText: '#99f6e4',
      bg: '#071014',
      panel: 'rgba(12, 25, 31, 0.88)',
      panelStrong: 'rgba(15, 34, 42, 0.96)',
      line: 'rgba(148, 163, 184, 0.18)',
      lineStrong: 'rgba(45, 212, 191, 0.34)',
      text: '#e5f2f4',
      muted: '#8aa1a8',
      topbar: 'rgba(4, 10, 13, 0.72)',
      ambient1: 'rgba(20, 184, 166, 0.14)',
      ambient2: 'rgba(245, 158, 11, 0.11)',
    },
    dataSources: [
      {
        id: 'overview',
        name: '示例经营数据',
        type: 'static',
        data: {
          revenue: 1286000,
          revenueTrend: 12.8,
          activeUsers: 42893,
          conversion: 7.4,
          series: [
            ['日期', '访问', '转化'],
            ['周一', 1200, 82],
            ['周二', 1380, 91],
            ['周三', 1560, 110],
            ['周四', 1420, 96],
            ['周五', 1880, 147],
            ['周六', 2120, 166],
            ['周日', 2300, 184],
          ],
          regions: [
            { name: '华东', value: 42 },
            { name: '华南', value: 31 },
            { name: '华北', value: 19 },
            { name: '西南', value: 8 },
          ],
          table: [
            { channel: '搜索', visits: 12300, conversion: '8.1%' },
            { channel: '推荐', visits: 9600, conversion: '6.8%' },
            { channel: '广告', visits: 7200, conversion: '5.9%' },
          ],
        },
      },
    ],
    layout: [
      { id: 'revenue', x: 0, y: 0, w: 6, h: 4 },
      { id: 'users', x: 6, y: 0, w: 6, h: 4 },
      { id: 'trend', x: 12, y: 0, w: 12, h: 8 },
      { id: 'regions', x: 0, y: 4, w: 12, h: 8 },
      { id: 'channels', x: 12, y: 8, w: 12, h: 8 },
    ],
    modules: [
      {
        id: 'revenue',
        type: 'metric',
        title: '本周收入',
        dataSourceId: 'overview',
        valuePath: 'revenue',
        trendPath: 'revenueTrend',
        suffix: '元',
      },
      {
        id: 'users',
        type: 'metric',
        title: '活跃用户',
        dataSourceId: 'overview',
        valuePath: 'activeUsers',
      },
      {
        id: 'trend',
        type: 'chart',
        title: '访问与转化趋势',
        dataSourceId: 'overview',
        chartType: 'line',
        option: {
          dataset: { sourcePath: 'series' },
          xAxis: { type: 'category' },
          yAxis: { type: 'value' },
          series: [{ type: 'line', smooth: true }, { type: 'bar' }],
        },
      },
      {
        id: 'regions',
        type: 'chart',
        title: '区域占比',
        dataSourceId: 'overview',
        chartType: 'pie',
        option: {
          dataset: { sourcePath: 'regions' },
          series: [{ type: 'pie', radius: ['48%', '72%'] }],
        },
      },
      {
        id: 'channels',
        type: 'table',
        title: '渠道表现',
        dataSourceId: 'overview',
        rowsPath: 'table',
        columns: [
          { key: 'channel', label: '渠道' },
          { key: 'visits', label: '访问量' },
          { key: 'conversion', label: '转化率' },
        ],
      },
    ],
  };
}

function normalizeManifest(value: unknown): DashboardManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('dashboard.json must be an object');
  }
  const record = value as Record<string, unknown>;
  const title =
    typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '数据大屏';
  const description = typeof record.description === 'string' ? record.description : undefined;
  const theme =
    record.theme && typeof record.theme === 'object'
      ? (record.theme as DashboardManifest['theme'])
      : undefined;
  const layout = Array.isArray(record.layout)
    ? (record.layout.map(normalizeLayoutItem).filter(Boolean) as DashboardLayoutItem[])
    : [];
  const dataSources = Array.isArray(record.dataSources)
    ? record.dataSources.filter(isDataSource)
    : [];
  const modules = Array.isArray(record.modules) ? record.modules.filter(isModule) : [];
  const normalized: DashboardManifest = {
    version: 1,
    title,
    layout,
    dataSources,
    modules,
  };
  if (description) normalized.description = description;
  if (theme) normalized.theme = theme;
  if (typeof record.updatedAt === 'string') normalized.updatedAt = record.updatedAt;
  return normalized;
}

function normalizeLayoutItem(value: unknown): DashboardLayoutItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return undefined;
  return {
    id,
    x: clampNumber(record.x, 0, 23, 0),
    y: clampNumber(record.y, 0, 999, 0),
    w: clampNumber(record.w, 1, 24, 6),
    h: clampNumber(record.h, 2, 40, 6),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function isDataSource(value: unknown): value is DashboardManifest['dataSources'][number] {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && (record.type === 'static' || record.type === 'http');
}

function isModule(value: unknown): value is DashboardModule {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    (record.type === 'metric' ||
      record.type === 'chart' ||
      record.type === 'table' ||
      record.type === 'text' ||
      record.type === 'json-ui')
  );
}

function upsertLayout(
  layout: DashboardLayoutItem[],
  item: DashboardLayoutItem,
): DashboardLayoutItem[] {
  const normalized = normalizeLayoutItem(item);
  if (!normalized) return layout;
  return layout.some((candidate) => candidate.id === normalized.id)
    ? layout.map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
    : [...layout, normalized];
}

function defaultLayoutForModule(id: string, index: number): DashboardLayoutItem {
  return {
    id,
    x: (index * 6) % 24,
    y: Math.floor(index / 4) * 6,
    w: 6,
    h: 6,
  };
}

async function writeAgentsFile(workspaceDir: string): Promise<void> {
  await writeFileIfMissing(
    path.join(workspaceDir, DASHBOARD_AGENTS_FILE),
    [
      '# Dashboard Workspace',
      '',
      'You are editing a manifest-driven Pi Dashboard workspace.',
      '',
      '- The source of truth is `dashboard.json`.',
      '- Prefer editing JSON configuration over adding framework code.',
      '- Use `dataSources` for API/static data and `modules` for metric, chart, table, text, or json-ui widgets.',
      '- Keep module IDs stable because layout items reference them.',
      '- After changes, keep the JSON valid and preserve `version: 1`.',
      '',
    ].join('\n'),
  );
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(filePath, content, 'utf8');
  }
}
