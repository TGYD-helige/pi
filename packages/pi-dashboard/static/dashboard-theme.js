import { escapeAttr, escapeHtml } from "./dashboard-utils.js";

export const themePresets = {
  aurora: {
    dark: {
      preset: "aurora",
      mode: "dark",
      accent: "#14b8a6",
      accentSoft: "rgba(20, 184, 166, 0.14)",
      accentText: "#99f6e4",
      bg: "#071014",
      panel: "rgba(12, 25, 31, 0.88)",
      panelStrong: "rgba(15, 34, 42, 0.96)",
      line: "rgba(148, 163, 184, 0.18)",
      lineStrong: "rgba(45, 212, 191, 0.34)",
      text: "#e5f2f4",
      muted: "#8aa1a8",
      topbar: "rgba(4, 10, 13, 0.72)",
      ambient1: "rgba(20, 184, 166, 0.14)",
      ambient2: "rgba(245, 158, 11, 0.11)",
    },
    light: {
      preset: "aurora",
      mode: "light",
      accent: "#0f766e",
      accentSoft: "rgba(15, 118, 110, 0.10)",
      accentText: "#0f766e",
      bg: "#f5f8f7",
      panel: "rgba(255, 255, 255, 0.86)",
      panelStrong: "rgba(255, 255, 255, 0.96)",
      line: "rgba(15, 23, 42, 0.12)",
      lineStrong: "rgba(15, 118, 110, 0.28)",
      text: "#10201f",
      muted: "#647574",
      topbar: "rgba(255, 255, 255, 0.72)",
      ambient1: "rgba(15, 118, 110, 0.10)",
      ambient2: "rgba(245, 158, 11, 0.10)",
    },
  },
  cobalt: {
    dark: {
      preset: "cobalt",
      mode: "dark",
      accent: "#38bdf8",
      accentSoft: "rgba(56, 189, 248, 0.14)",
      accentText: "#bae6fd",
      bg: "#07111f",
      panel: "rgba(12, 28, 48, 0.88)",
      panelStrong: "rgba(15, 40, 68, 0.96)",
      line: "rgba(147, 197, 253, 0.18)",
      lineStrong: "rgba(56, 189, 248, 0.38)",
      text: "#e7f3ff",
      muted: "#91aeca",
      topbar: "rgba(4, 12, 24, 0.74)",
      ambient1: "rgba(56, 189, 248, 0.15)",
      ambient2: "rgba(129, 140, 248, 0.10)",
    },
    light: {
      preset: "cobalt",
      mode: "light",
      accent: "#0284c7",
      accentSoft: "rgba(2, 132, 199, 0.10)",
      accentText: "#0369a1",
      bg: "#f5f9ff",
      panel: "rgba(255, 255, 255, 0.88)",
      panelStrong: "rgba(255, 255, 255, 0.98)",
      line: "rgba(15, 23, 42, 0.12)",
      lineStrong: "rgba(2, 132, 199, 0.30)",
      text: "#0b1b2d",
      muted: "#66788f",
      topbar: "rgba(255, 255, 255, 0.74)",
      ambient1: "rgba(2, 132, 199, 0.10)",
      ambient2: "rgba(99, 102, 241, 0.08)",
    },
  },
  ember: {
    dark: {
      preset: "ember",
      mode: "dark",
      accent: "#f59e0b",
      accentSoft: "rgba(245, 158, 11, 0.15)",
      accentText: "#fde68a",
      bg: "#15100b",
      panel: "rgba(35, 24, 14, 0.88)",
      panelStrong: "rgba(51, 33, 18, 0.96)",
      line: "rgba(251, 191, 36, 0.18)",
      lineStrong: "rgba(245, 158, 11, 0.36)",
      text: "#fff3df",
      muted: "#c8ac84",
      topbar: "rgba(18, 12, 8, 0.76)",
      ambient1: "rgba(245, 158, 11, 0.16)",
      ambient2: "rgba(20, 184, 166, 0.08)",
    },
    light: {
      preset: "ember",
      mode: "light",
      accent: "#b45309",
      accentSoft: "rgba(180, 83, 9, 0.10)",
      accentText: "#92400e",
      bg: "#fff8ed",
      panel: "rgba(255, 255, 255, 0.86)",
      panelStrong: "rgba(255, 255, 255, 0.98)",
      line: "rgba(67, 20, 7, 0.12)",
      lineStrong: "rgba(180, 83, 9, 0.28)",
      text: "#2c1810",
      muted: "#84624b",
      topbar: "rgba(255, 252, 247, 0.76)",
      ambient1: "rgba(245, 158, 11, 0.12)",
      ambient2: "rgba(20, 184, 166, 0.07)",
    },
  },
  daylight: {
    dark: {
      preset: "daylight",
      mode: "dark",
      accent: "#94a3b8",
      accentSoft: "rgba(148, 163, 184, 0.14)",
      accentText: "#e2e8f0",
      bg: "#0f172a",
      panel: "rgba(23, 31, 49, 0.88)",
      panelStrong: "rgba(30, 41, 59, 0.96)",
      line: "rgba(203, 213, 225, 0.16)",
      lineStrong: "rgba(148, 163, 184, 0.34)",
      text: "#f8fafc",
      muted: "#a8b3c3",
      topbar: "rgba(15, 23, 42, 0.76)",
      ambient1: "rgba(148, 163, 184, 0.12)",
      ambient2: "rgba(20, 184, 166, 0.06)",
    },
    light: {
      preset: "daylight",
      mode: "light",
      accent: "#0f766e",
      accentSoft: "rgba(15, 118, 110, 0.10)",
      accentText: "#0f766e",
      bg: "#f5f8f7",
      panel: "rgba(255, 255, 255, 0.86)",
      panelStrong: "rgba(255, 255, 255, 0.96)",
      line: "rgba(15, 23, 42, 0.12)",
      lineStrong: "rgba(15, 118, 110, 0.28)",
      text: "#10201f",
      muted: "#647574",
      topbar: "rgba(255, 255, 255, 0.72)",
      ambient1: "rgba(15, 118, 110, 0.10)",
      ambient2: "rgba(245, 158, 11, 0.10)",
    },
  },
};

export const themePresetLabels = {
  aurora: "深海青",
  cobalt: "钴蓝",
  ember: "暖金",
  daylight: "浅色",
};

export const customThemeId = "__custom__";
export const defaultTheme = themePresets.aurora.dark;

export function applyTheme(theme, elements) {
  const resolved = currentTheme(theme);
  document.documentElement.style.colorScheme = resolved.mode === "light" ? "light" : "dark";
  document.documentElement.dataset.dashboardMode = resolved.mode;
  document.documentElement.style.setProperty("--bg", resolved.bg);
  document.documentElement.style.setProperty("--panel", resolved.panel);
  document.documentElement.style.setProperty("--panel-strong", resolved.panelStrong);
  document.documentElement.style.setProperty("--line", resolved.line);
  document.documentElement.style.setProperty("--line-strong", resolved.lineStrong);
  document.documentElement.style.setProperty("--text", resolved.text);
  document.documentElement.style.setProperty("--muted", resolved.muted);
  document.documentElement.style.setProperty("--accent", resolved.accent);
  document.documentElement.style.setProperty("--accent-soft", resolved.accentSoft);
  document.documentElement.style.setProperty("--accent-text", resolved.accentText);
  document.documentElement.style.setProperty("--topbar-bg", resolved.topbar);
  document.documentElement.style.setProperty("--ambient-1", resolved.ambient1);
  document.documentElement.style.setProperty("--ambient-2", resolved.ambient2);
  if (elements) {
    updateThemeModeButton(elements.themeMode, resolved.mode);
    updateThemePresetSelect(elements.themePreset, resolved);
  }
  return resolved;
}

export function currentTheme(theme) {
  if (!theme || typeof theme !== "object") return defaultTheme;
  const mode = normalizeThemeMode(theme.mode) || defaultTheme.mode;
  const preset = typeof theme.preset === "string" ? theme.preset : defaultTheme.preset;
  if (themePresets[preset]) return themePresets[preset][mode];
  return { ...themePresets.aurora[mode], ...theme, mode };
}

export function themeForMode(theme, mode) {
  const normalizedMode = normalizeThemeMode(mode) || defaultTheme.mode;
  const current = currentTheme(theme);
  const preset = current.preset && themePresets[current.preset] ? current.preset : defaultTheme.preset;
  return themePresets[preset][normalizedMode];
}

export function populateThemePresetSelect(selectElement) {
  const options = Object.keys(themePresets)
    .map((preset) => `<option value="${escapeAttr(preset)}">${escapeHtml(themePresetLabels[preset] || preset)}</option>`)
    .join("");
  selectElement.innerHTML = options + `<option value="${customThemeId}" disabled>自定义</option>`;
}

export function normalizeThemeMode(value) {
  return value === "light" || value === "dark" ? value : undefined;
}

function updateThemeModeButton(buttonElement, mode) {
  const nextLabel = mode === "light" ? "切换为深色" : "切换为浅色";
  buttonElement.setAttribute("aria-label", nextLabel);
  buttonElement.setAttribute("title", nextLabel);
}

function updateThemePresetSelect(selectElement, theme) {
  const preset = theme && theme.preset && themePresets[theme.preset] ? theme.preset : customThemeId;
  selectElement.disabled = false;
  selectElement.value = preset;
}
