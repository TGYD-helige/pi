import { escapeAttr, escapeHtml, slugify } from "./dashboard-utils.js";

export function populateModuleDialog(elements, payload, moduleId) {
  if (!payload) return false;
  const module = moduleId ? payload.manifest.modules.find((item) => item.id === moduleId) : undefined;
  elements.dialogTitle.textContent = module ? "编辑模块" : "添加模块";
  const sourceSelect = elements.form.elements.dataSourceId;
  sourceSelect.innerHTML = '<option value="">无</option>' + payload.manifest.dataSources
    .map((source) => `<option value="${escapeAttr(source.id)}">${escapeHtml(source.name || source.id)}</option>`)
    .join("");
  elements.form.elements.title.value = module ? module.title : "";
  elements.form.elements.type.value = module ? module.type : "metric";
  elements.form.elements.dataSourceId.value = module && module.dataSourceId ? module.dataSourceId : "";
  elements.form.elements.path.value = pathValueForModule(module);
  elements.dialog.showModal();
  return true;
}

export function moduleFromDialog(elements, current) {
  const form = elements.form;
  const type = form.elements.type.value;
  const title = form.elements.title.value.trim();
  const dataSourceId = form.elements.dataSourceId.value.trim();
  const path = form.elements.path.value.trim();
  const id = current ? current.id : slugify(title || type);
  return {
    id,
    module: buildModule({ id, type, title, dataSourceId, path, current }),
  };
}

export function buildModule(input) {
  const base = {
    id: input.id,
    title: input.title || "未命名模块",
    type: input.type,
  };
  if (input.dataSourceId) base.dataSourceId = input.dataSourceId;
  if (input.type === "metric") {
    return { ...base, valuePath: input.path || "value" };
  }
  if (input.type === "chart") {
    return {
      ...base,
      chartType: input.current && input.current.chartType || "line",
      option: input.current && input.current.option || { dataset: { sourcePath: input.path || "series" } },
    };
  }
  if (input.type === "table") {
    return { ...base, rowsPath: input.path || "rows" };
  }
  return { ...base, content: input.path || "文本内容" };
}

export function pathValueForModule(module) {
  if (!module) return "";
  if (module.type === "metric") return module.valuePath || "";
  if (module.type === "table") return module.rowsPath || "";
  if (module.type === "chart") return module.option && module.option.dataset && module.option.dataset.sourcePath || "";
  if (module.type === "text") return module.content || "";
  return "";
}
