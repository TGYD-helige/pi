export function arrayAt(value, pathExpression) {
  const valueAtPath = pathExpression ? valueAt(value, pathExpression) : value;
  return Array.isArray(valueAtPath) ? valueAtPath : [];
}

export function valueAt(value, pathExpression) {
  if (!pathExpression) return value;
  return String(pathExpression).split(".").filter(Boolean).reduce((current, key) => {
    if (current == null || typeof current !== "object") return undefined;
    return current[key];
  }, value);
}

export async function postJson(url, body, method) {
  const response = await fetch(url, {
    method: method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`保存失败：HTTP ${response.status}`);
  return response.json();
}

export function formatValue(value) {
  if (typeof value === "number") return new Intl.NumberFormat("zh-CN").format(value);
  if (value == null) return "-";
  return String(value);
}

export function formatTrend(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `${numeric >= 0 ? "+" : ""}${numeric}%`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

export function slugify(value) {
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-+|-+$/g, "");
  return slug || `module-${Date.now().toString(36)}`;
}

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function cssEscape(value) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}

export function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
