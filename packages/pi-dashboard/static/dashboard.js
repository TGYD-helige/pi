import { gridColumns, layoutHistoryLimit, arrangeLayout, cloneLayout, currentLayoutFromGrid, layoutEquals } from "./dashboard-layout.js";
import { moduleFromDialog, populateModuleDialog } from "./dashboard-module-form.js";
import { disposeCharts, moduleData, renderCharts, renderGridItem, resizeCharts } from "./dashboard-renderer.js";
import { applyTheme, currentTheme, normalizeThemeMode, populateThemePresetSelect, themeForMode, themePresets } from "./dashboard-theme.js";
import { debounce, postJson } from "./dashboard-utils.js";

const state = {
  payload: undefined,
  grid: undefined,
  charts: new Map(),
  editing: new URLSearchParams(location.search).get("edit") === "1",
  editingModuleId: undefined,
  layoutBeforeInteraction: undefined,
  layoutHistory: [],
  redoLayoutHistory: [],
  lastLayout: [],
  requestedThemeMode: normalizeThemeMode(new URLSearchParams(location.search).get("themeMode")),
};

const elements = {
  title: document.getElementById("dashboardTitle"),
  grid: document.getElementById("grid"),
  error: document.getElementById("errorBanner"),
  addModule: document.getElementById("addModuleButton"),
  themePreset: document.getElementById("themePresetSelect"),
  themeMode: document.getElementById("themeModeButton"),
  reload: document.getElementById("reloadButton"),
  autoArrange: document.getElementById("autoArrangeButton"),
  undoLayout: document.getElementById("undoLayoutButton"),
  redoLayout: document.getElementById("redoLayoutButton"),
  completeEdit: document.getElementById("completeEditButton"),
  dialog: document.getElementById("moduleDialog"),
  closeDialog: document.getElementById("closeModuleDialogButton"),
  form: document.getElementById("moduleForm"),
  dialogTitle: document.getElementById("moduleDialogTitle"),
};

populateThemePresetSelect(elements.themePreset);
elements.addModule.addEventListener("click", () => openModuleDialog());
elements.themePreset.addEventListener("change", (event) => {
  void setThemePreset(event.currentTarget.value, { persist: true });
});
elements.themeMode.addEventListener("click", () => {
  const nextMode = currentDashboardTheme().mode === "light" ? "dark" : "light";
  void setThemeMode(nextMode, { persist: true, notify: true });
});
elements.reload.addEventListener("click", () => loadDashboard());
elements.autoArrange.addEventListener("click", () => {
  void autoArrangeLayout();
});
elements.undoLayout.addEventListener("click", () => {
  void undoLayoutChange();
});
elements.redoLayout.addEventListener("click", () => {
  void redoLayoutChange();
});
elements.completeEdit.addEventListener("click", () => setEditing(false, { notify: true }));
elements.closeDialog.addEventListener("click", () => {
  elements.dialog.close();
});
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveModuleFromDialog();
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.source !== "pi-agent-web-ui") return;
  if (message.type === "pi-dashboard:reload") {
    void loadDashboard();
  }
  if (message.type === "pi-dashboard:set-editing") {
    setEditing(Boolean(message.editing));
  }
  if (message.type === "pi-dashboard:set-theme-mode") {
    void setThemeMode(message.mode, { persist: true, notify: false });
  }
  if (message.type === "pi-dashboard:set-header-left-offset") {
    setHeaderLeftOffset(message.left);
  }
  if (message.type === "pi-dashboard:open-module-dialog") {
    openModuleDialog();
  }
});

window.addEventListener("resize", debounce(() => {
  resizeCharts(state.charts);
}, 120));

setEditing(state.editing);
void loadDashboard();

async function loadDashboard() {
  clearError();
  try {
    const response = await fetch("./api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`加载失败：HTTP ${response.status}`);
    state.payload = await response.json();
    if (state.requestedThemeMode) {
      state.payload.manifest.theme = themeForMode(state.payload.manifest.theme, state.requestedThemeMode);
    }
    renderDashboard();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function renderDashboard() {
  const payload = state.payload;
  if (!payload) return;
  const { manifest } = payload;
  elements.title.textContent = manifest.title || "数据大屏";
  document.title = manifest.title || "Pi Dashboard";
  applyTheme(manifest.theme, elements);
  elements.grid.innerHTML = "";
  disposeCharts(state.charts);

  if (!manifest.modules.length) {
    elements.grid.innerHTML = '<div class="empty-state">暂无模块</div>';
    state.lastLayout = [];
    state.layoutBeforeInteraction = undefined;
    state.layoutHistory = [];
    state.redoLayoutHistory = [];
    updateEditHistoryButtonState();
    return;
  }

  for (const module of manifest.modules) {
    elements.grid.appendChild(renderGridItem(module, layoutForModule(module.id), {
      moduleData: (item) => moduleData(payload, item),
      onEdit: openModuleDialog,
      onDelete: deleteModule,
    }));
  }

  if (window.GridStack) {
    if (state.grid) {
      state.grid.destroy(false);
    }
    state.grid = window.GridStack.init({
      column: gridColumns,
      cellHeight: 32,
      margin: 8,
      float: true,
      disableDrag: !state.editing,
      disableResize: !state.editing,
    }, elements.grid);
    state.grid.on("dragstart", captureLayoutBeforeInteraction);
    state.grid.on("resizestart", captureLayoutBeforeInteraction);
    state.grid.on("change", debounce(saveCurrentLayout, 450));
    state.grid.on("resizestop", () => resizeCharts(state.charts));
    state.lastLayout = currentLayoutFromGridState();
  } else {
    elements.grid.classList.add("gridstack-missing");
    showError("Gridstack 未加载，当前为只读布局。");
  }

  renderCharts({ payload, charts: state.charts, getTheme: currentDashboardTheme });
  setEditing(state.editing);
  updateEditHistoryButtonState();
}

function currentDashboardTheme(theme) {
  const manifestTheme = theme || state.payload && state.payload.manifest && state.payload.manifest.theme;
  return currentTheme(manifestTheme);
}

async function setThemeMode(mode, options) {
  const normalizedMode = normalizeThemeMode(mode);
  if (!normalizedMode) return;
  state.requestedThemeMode = normalizedMode;
  if (!state.payload || !state.payload.manifest) return;
  state.payload.manifest.theme = themeForMode(state.payload.manifest.theme, normalizedMode);
  applyTheme(state.payload.manifest.theme, elements);
  disposeCharts(state.charts);
  renderCharts({ payload: state.payload, charts: state.charts, getTheme: currentDashboardTheme });
  if (options && options.persist) {
    try {
      const result = await postJson("./api/dashboard/manifest", { manifest: state.payload.manifest }, "PUT");
      if (result.manifest) state.payload.manifest = result.manifest;
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }
  if (!options || options.notify !== false) {
    window.parent.postMessage({
      source: "pi-dashboard",
      type: "pi-dashboard:theme-mode-changed",
      mode: normalizedMode,
    }, "*");
  }
}

async function setThemePreset(preset, options) {
  if (!themePresets[preset]) {
    applyTheme(currentDashboardTheme(), elements);
    return;
  }
  if (!state.payload || !state.payload.manifest) return;
  const mode = currentDashboardTheme().mode;
  state.payload.manifest.theme = themePresets[preset][mode];
  applyTheme(state.payload.manifest.theme, elements);
  disposeCharts(state.charts);
  renderCharts({ payload: state.payload, charts: state.charts, getTheme: currentDashboardTheme });
  if (options && options.persist) {
    try {
      const result = await postJson("./api/dashboard/manifest", { manifest: state.payload.manifest }, "PUT");
      if (result.manifest) {
        state.payload.manifest = result.manifest;
        applyTheme(state.payload.manifest.theme, elements);
      }
    } catch (error) {
      applyTheme(currentDashboardTheme(), elements);
      showError(error instanceof Error ? error.message : String(error));
    }
  }
}

function setHeaderLeftOffset(value) {
  const offset = Number(value);
  const clamped = Number.isFinite(offset) ? Math.max(0, Math.min(offset, 240)) : 0;
  document.documentElement.style.setProperty("--host-header-left-offset", `${clamped}px`);
}

async function autoArrangeLayout() {
  if (!state.grid || !state.payload || !state.editing) return;
  clearError();
  const current = currentLayoutFromGridState();
  const arranged = arrangeLayout(current);
  if (layoutEquals(current, arranged)) return;
  pushLayoutHistory(current);
  await applyLayout(arranged, { persist: true });
}

async function undoLayoutChange() {
  if (!state.payload || !state.editing || !state.layoutHistory.length) return;
  clearError();
  const current = currentLayoutFromGridState();
  const previous = state.layoutHistory.pop();
  if (!layoutEquals(current, previous)) {
    pushRedoLayoutHistory(current);
  }
  updateEditHistoryButtonState();
  await applyLayout(previous, { persist: true });
}

async function redoLayoutChange() {
  if (!state.payload || !state.editing || !state.redoLayoutHistory.length) return;
  clearError();
  const current = currentLayoutFromGridState();
  const next = state.redoLayoutHistory.pop();
  if (!layoutEquals(current, next)) {
    pushLayoutHistory(current, { clearRedo: false });
  }
  updateEditHistoryButtonState();
  await applyLayout(next, { persist: true });
}

async function applyLayout(layout, options) {
  const normalized = cloneLayout(layout);
  state.layoutBeforeInteraction = undefined;
  state.lastLayout = normalized;
  state.payload.manifest.layout = normalized;
  renderDashboard();
  if (options && options.persist) {
    try {
      const result = await persistLayout(normalized);
      if (result.manifest) state.payload.manifest = result.manifest;
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }
  updateEditHistoryButtonState();
}

async function saveCurrentLayout() {
  if (!state.grid || !state.editing || !state.payload) return;
  const layout = currentLayoutFromGridState();
  recordLayoutChange(layout);
  state.payload.manifest.layout = cloneLayout(layout);
  try {
    const result = await persistLayout(layout);
    if (result.manifest) state.payload.manifest = result.manifest;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function persistLayout(layout) {
  return postJson("./api/dashboard/layout", { layout });
}

function captureLayoutBeforeInteraction() {
  if (!state.grid || !state.editing) return;
  state.layoutBeforeInteraction = currentLayoutFromGridState();
}

function recordLayoutChange(layout) {
  const previous = state.layoutBeforeInteraction && !layoutEquals(state.layoutBeforeInteraction, layout)
    ? state.layoutBeforeInteraction
    : state.lastLayout;
  if (previous && previous.length && !layoutEquals(previous, layout)) {
    pushLayoutHistory(previous);
  }
  state.layoutBeforeInteraction = undefined;
  state.lastLayout = cloneLayout(layout);
  updateEditHistoryButtonState();
}

function pushLayoutHistory(layout, options) {
  const snapshot = cloneLayout(layout);
  if (!snapshot.length) return;
  const lastSnapshot = state.layoutHistory[state.layoutHistory.length - 1];
  if (lastSnapshot && layoutEquals(lastSnapshot, snapshot)) {
    if (!options || options.clearRedo !== false) {
      state.redoLayoutHistory = [];
    }
    updateEditHistoryButtonState();
    return;
  }
  state.layoutHistory.push(snapshot);
  if (state.layoutHistory.length > layoutHistoryLimit) {
    state.layoutHistory.splice(0, state.layoutHistory.length - layoutHistoryLimit);
  }
  if (!options || options.clearRedo !== false) {
    state.redoLayoutHistory = [];
  }
  updateEditHistoryButtonState();
}

function pushRedoLayoutHistory(layout) {
  const snapshot = cloneLayout(layout);
  if (!snapshot.length) return;
  const lastSnapshot = state.redoLayoutHistory[state.redoLayoutHistory.length - 1];
  if (lastSnapshot && layoutEquals(lastSnapshot, snapshot)) return;
  state.redoLayoutHistory.push(snapshot);
  if (state.redoLayoutHistory.length > layoutHistoryLimit) {
    state.redoLayoutHistory.splice(0, state.redoLayoutHistory.length - layoutHistoryLimit);
  }
  updateEditHistoryButtonState();
}

function updateEditHistoryButtonState() {
  elements.undoLayout.disabled = !state.editing || state.layoutHistory.length === 0;
  elements.undoLayout.title = elements.undoLayout.disabled ? "暂无可撤销的布局" : "撤销上一次布局调整";
  elements.redoLayout.disabled = !state.editing || state.redoLayoutHistory.length === 0;
  elements.redoLayout.title = elements.redoLayout.disabled ? "暂无可重做的布局" : "重做上一次撤销";
}

function currentLayoutFromGridState() {
  return currentLayoutFromGrid(state.grid, currentLayoutFromManifest());
}

function currentLayoutFromManifest() {
  if (!state.payload) return [];
  return cloneLayout(state.payload.manifest.modules.map((module) => layoutForModule(module.id)));
}

function openModuleDialog(moduleId) {
  if (populateModuleDialog(elements, state.payload, moduleId)) {
    state.editingModuleId = moduleId;
  }
}

async function saveModuleFromDialog() {
  const current = state.editingModuleId && state.payload
    ? state.payload.manifest.modules.find((item) => item.id === state.editingModuleId)
    : undefined;
  const { id, module } = moduleFromDialog(elements, current);
  const url = current ? `./api/dashboard/modules/${encodeURIComponent(id)}` : "./api/dashboard/modules";
  const method = current ? "PATCH" : "POST";
  const result = await postJson(url, { module }, method);
  elements.dialog.close();
  state.payload.manifest = result.manifest;
  await loadDashboard();
}

async function deleteModule(moduleId) {
  if (!confirm("删除这个模块？")) return;
  const result = await fetch(`./api/dashboard/modules/${encodeURIComponent(moduleId)}`, { method: "DELETE" });
  if (!result.ok) {
    showError(`删除失败：HTTP ${result.status}`);
    return;
  }
  await loadDashboard();
}

function setEditing(editing, options) {
  state.editing = editing;
  document.body.classList.toggle("editing", editing);
  if (state.grid) {
    state.grid.enableMove(editing);
    state.grid.enableResize(editing);
  }
  updateEditHistoryButtonState();
  if (options && options.notify) {
    window.parent.postMessage({
      source: "pi-dashboard",
      type: "pi-dashboard:editing-changed",
      editing,
    }, "*");
  }
}

function layoutForModule(moduleId) {
  const layout = state.payload.manifest.layout.find((item) => item.id === moduleId);
  return layout || { id: moduleId, x: 0, y: 0, w: 6, h: 6 };
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.textContent = "";
  elements.error.hidden = true;
}
