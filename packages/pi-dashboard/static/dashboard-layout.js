export const gridColumns = 24;
export const layoutHistoryLimit = 20;

export function arrangeLayout(layout) {
  const items = cloneLayout(layout).sort((left, right) => {
    if (left.y !== right.y) return left.y - right.y;
    if (left.x !== right.x) return left.x - right.x;
    return String(left.id).localeCompare(String(right.id));
  });
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return items.map((item) => {
    const width = Math.min(Math.max(1, item.w), gridColumns);
    const height = Math.max(1, item.h);
    if (x > 0 && x + width > gridColumns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const arranged = { ...item, x, y, w: width, h: height };
    x += width;
    rowHeight = Math.max(rowHeight, height);
    if (x >= gridColumns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    return arranged;
  });
}

export function currentLayoutFromGrid(grid, fallbackLayout) {
  if (!grid || !grid.engine) return cloneLayout(fallbackLayout);
  return cloneLayout(grid.engine.nodes.map((node) => ({
    id: node.id || node.el.getAttribute("gs-id"),
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
  })));
}

export function cloneLayout(layout) {
  return (Array.isArray(layout) ? layout : [])
    .map(normalizeLayoutItem)
    .filter(Boolean);
}

export function normalizeLayoutItem(item) {
  if (!item || !item.id) return undefined;
  const width = clampInteger(item.w, 1, gridColumns, 6);
  return {
    id: String(item.id),
    x: clampInteger(item.x, 0, gridColumns - width, 0),
    y: clampInteger(item.y, 0, Number.MAX_SAFE_INTEGER, 0),
    w: width,
    h: clampInteger(item.h, 1, Number.MAX_SAFE_INTEGER, 6),
  };
}

export function layoutEquals(left, right) {
  return layoutSignature(left) === layoutSignature(right);
}

function layoutSignature(layout) {
  return JSON.stringify(cloneLayout(layout).sort((left, right) => String(left.id).localeCompare(String(right.id))));
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}
