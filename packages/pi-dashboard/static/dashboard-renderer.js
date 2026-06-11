import {
  arrayAt,
  clone,
  cssEscape,
  escapeAttr,
  escapeHtml,
  formatTrend,
  formatValue,
  valueAt,
} from "./dashboard-utils.js";

export function renderGridItem(module, layout, handlers) {
  const item = document.createElement("section");
  item.className = "grid-stack-item";
  item.setAttribute("gs-id", module.id);
  item.setAttribute("gs-x", String(layout.x));
  item.setAttribute("gs-y", String(layout.y));
  item.setAttribute("gs-w", String(layout.w));
  item.setAttribute("gs-h", String(layout.h));
  item.innerHTML = `
    <div class="grid-stack-item-content">
      <article class="widget" data-module-id="${escapeAttr(module.id)}">
        <header class="widget-header">
          <div class="widget-title">
            <strong>${escapeHtml(module.title)}</strong>
            <span>${escapeHtml(module.subtitle || module.type)}</span>
          </div>
          <div class="widget-tools">
            <button type="button" class="widget-icon-button" data-action="edit" aria-label="编辑模块" title="编辑模块">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15.2 5.2 3.6 3.6" />
                <path d="M4 20l4.2-1 10.1-10.1a2.5 2.5 0 0 0-3.5-3.5L4.7 15.5 4 20Z" />
              </svg>
            </button>
            <button type="button" class="widget-icon-button" data-action="delete" aria-label="删除模块" title="删除模块">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="m19 6-1 14H6L5 6" />
                <path d="M10 11v5" />
                <path d="M14 11v5" />
              </svg>
            </button>
          </div>
        </header>
        <div class="widget-body">${renderModuleBody(module, handlers.moduleData(module))}</div>
      </article>
    </div>
  `;
  item.querySelector('[data-action="edit"]').addEventListener("click", () => handlers.onEdit(module.id));
  item.querySelector('[data-action="delete"]').addEventListener("click", () => handlers.onDelete(module.id));
  return item;
}

export function renderModuleBody(module, data) {
  if (module.type === "metric") {
    const value = valueAt(data, module.valuePath) ?? valueAt(data, "value") ?? "-";
    const trend = module.trendPath ? valueAt(data, module.trendPath) : undefined;
    return `
      <div class="metric-value">
        <span class="metric-number">${escapeHtml(formatValue(value))}</span>
        ${module.suffix ? `<span class="metric-suffix">${escapeHtml(module.suffix)}</span>` : ""}
        ${trend === undefined ? "" : `<span class="metric-trend">${escapeHtml(formatTrend(trend))}</span>`}
      </div>
    `;
  }
  if (module.type === "chart") {
    return `<div class="chart-host" data-chart-id="${escapeAttr(module.id)}"></div>`;
  }
  if (module.type === "table") {
    return renderTable(module, data);
  }
  if (module.type === "json-ui") {
    return `<pre class="text-content">${escapeHtml(JSON.stringify(module.schema, null, 2))}</pre>`;
  }
  return `<div class="text-content">${escapeHtml(module.content || "")}</div>`;
}

export function renderTable(module, data) {
  const rows = arrayAt(data, module.rowsPath) || (Array.isArray(data) ? data : []);
  const columns = module.columns && module.columns.length
    ? module.columns
    : Object.keys(rows[0] || {}).slice(0, 6).map((key) => ({ key, label: key }));
  if (!rows.length || !columns.length) {
    return '<div class="empty-state">暂无表格数据</div>';
  }
  return `
    <table class="data-table">
      <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.slice(0, 20).map((row) => `
          <tr>${columns.map((column) => `<td>${escapeHtml(formatValue(row[column.key]))}</td>`).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

export function renderCharts(options) {
  const { payload, charts, getTheme } = options;
  if (!window.echarts) {
    renderFallbackCharts({ payload });
    return;
  }
  if (!payload) return;
  const theme = getTheme();
  for (const module of payload.manifest.modules.filter((item) => item.type === "chart")) {
    const host = document.querySelector(`[data-chart-id="${cssEscape(module.id)}"]`);
    if (!host) continue;
    const chart = window.echarts.init(host, theme.mode === "light" ? undefined : "dark");
    chart.setOption(resolveChartOption(module, moduleData(payload, module), theme));
    charts.set(module.id, chart);
  }
}

export function renderFallbackCharts(options) {
  const { payload } = options;
  if (!payload) return;
  for (const module of payload.manifest.modules.filter((item) => item.type === "chart")) {
    const host = document.querySelector(`[data-chart-id="${cssEscape(module.id)}"]`);
    if (!host) continue;
    const rows = chartRows(module, moduleData(payload, module));
    const values = rows.map((row) => Number(Array.isArray(row) ? row[1] : row.value)).filter(Number.isFinite);
    const max = Math.max(1, ...values);
    host.className = "fallback-chart";
    host.innerHTML = values.map((value) => `<span style="height:${Math.max(8, value / max * 100)}%"></span>`).join("");
  }
}

export function resolveChartOption(module, data, theme) {
  const option = clone(module.option || {});
  const sourcePath = option.dataset && option.dataset.sourcePath;
  const rows = sourcePath ? valueAt(data, sourcePath) : chartRows(module, data);
  if (option.dataset && sourcePath) {
    option.dataset = { ...option.dataset, source: rows };
    delete option.dataset.sourcePath;
  }
  if (module.chartType === "pie") {
    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "item" },
      legend: { bottom: 0, textStyle: { color: theme.muted } },
      series: option.series || [{ type: "pie", radius: ["48%", "72%"], data: rows }],
      ...option,
    };
  }
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    grid: { left: 36, right: 18, top: 22, bottom: 30 },
    dataset: option.dataset || { source: rows },
    xAxis: option.xAxis || { type: "category", axisLabel: { color: theme.muted } },
    yAxis: option.yAxis || { type: "value", axisLabel: { color: theme.muted }, splitLine: { lineStyle: { color: theme.line } } },
    series: option.series || [{ type: module.chartType || "line", smooth: true }],
    ...option,
  };
}

export function moduleData(payload, module) {
  if (!payload || !module.dataSourceId) return {};
  return payload.data[module.dataSourceId] || {};
}

export function chartRows(module, data) {
  if (module.option && module.option.dataset && module.option.dataset.sourcePath) {
    return valueAt(data, module.option.dataset.sourcePath) || [];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.series)) return data.series;
  if (Array.isArray(data.rows)) return data.rows;
  return [];
}

export function resizeCharts(charts) {
  for (const chart of charts.values()) chart.resize();
}

export function disposeCharts(charts) {
  for (const chart of charts.values()) chart.dispose();
  charts.clear();
}
