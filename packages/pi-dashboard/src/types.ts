export type DashboardManifest = {
  version: 1;
  title: string;
  description?: string;
  theme?: DashboardTheme;
  layout: DashboardLayoutItem[];
  dataSources: DashboardDataSource[];
  modules: DashboardModule[];
  updatedAt?: string;
};

export type DashboardTheme = {
  preset?: string;
  mode?: 'dark' | 'light';
  accent?: string;
  accentSoft?: string;
  accentText?: string;
  bg?: string;
  panel?: string;
  panelStrong?: string;
  line?: string;
  lineStrong?: string;
  text?: string;
  muted?: string;
  topbar?: string;
  ambient1?: string;
  ambient2?: string;
};

export type DashboardLayoutItem = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DashboardDataSource =
  | {
      id: string;
      name?: string;
      type: 'static';
      data: unknown;
      refreshIntervalMs?: number;
    }
  | {
      id: string;
      name?: string;
      type: 'http';
      url: string;
      method?: 'GET' | 'POST';
      headers?: Record<string, string>;
      body?: unknown;
      jsonPath?: string;
      refreshIntervalMs?: number;
    };

export type DashboardModule =
  | DashboardMetricModule
  | DashboardChartModule
  | DashboardTableModule
  | DashboardTextModule
  | DashboardJsonUiModule;

export type DashboardModuleBase = {
  id: string;
  title: string;
  dataSourceId?: string;
  subtitle?: string;
  refreshIntervalMs?: number;
};

export type DashboardMetricModule = DashboardModuleBase & {
  type: 'metric';
  valuePath?: string;
  suffix?: string;
  trendPath?: string;
};

export type DashboardChartModule = DashboardModuleBase & {
  type: 'chart';
  chartType?: 'line' | 'bar' | 'pie';
  option?: Record<string, unknown>;
};

export type DashboardTableModule = DashboardModuleBase & {
  type: 'table';
  rowsPath?: string;
  columns?: Array<{ key: string; label: string }>;
};

export type DashboardTextModule = DashboardModuleBase & {
  type: 'text';
  content: string;
};

export type DashboardJsonUiModule = DashboardModuleBase & {
  type: 'json-ui';
  schema: unknown;
};

export type DashboardResolvedPayload = {
  manifest: DashboardManifest;
  data: Record<string, unknown>;
};

export type DashboardServerHandle = {
  url: string;
  port: number;
  close: () => Promise<void>;
};
