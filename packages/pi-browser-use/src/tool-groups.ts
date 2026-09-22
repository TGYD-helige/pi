/**
 * Deferred tool groups: every upstream tool stays registered, but only the
 * core set is active at session start. The `browser_tools` tool or the
 * `/browser-tools` command activates a group on demand.
 *
 * Group membership follows the upstream chrome-devtools-mcp tool categories,
 * read from the installed package at runtime so groups track the upstream
 * version instead of a hand-maintained table. Names are unprefixed upstream
 * tool names; the `browser_` prefix is applied where tools are registered.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CORE_TOOLS: readonly string[] = [
  // Pages and navigation
  'list_pages',
  'new_page',
  'navigate_page',
  'select_page',
  'close_page',
  'wait_for',
  // Perception
  'take_snapshot',
  'take_screenshot',
  // Input
  'click',
  'fill',
  'fill_form',
  'press_key',
  'handle_dialog',
  // Escape hatch and console
  'evaluate_script',
  'list_console_messages',
];

/** One-line summary per known upstream category, used in group listings. */
export const GROUP_SUMMARIES: Readonly<Record<string, string>> = {
  input: 'Additional input automation tools',
  navigation: 'Additional page and tab management',
  debugging: 'Audits, console message details, and screencast',
  network: 'Network request inspection',
  emulation: 'Device, locale, and viewport emulation',
  memory: 'Heap snapshots and memory analysis',
  performance: 'Performance traces and insights',
  extensions: 'Browser extension management',
  experimentalThirdParty: 'Third-party DevTools integration',
  experimentalWebmcp: 'WebMCP integration',
  other: 'Tools without an upstream category',
};

export type CategoryMap = Readonly<Record<string, string>>;

const require = createRequire(import.meta.url);

/** name → upstream category, read from the installed chrome-devtools-mcp. */
export async function loadCategoryMap(): Promise<CategoryMap> {
  try {
    const packageJsonPath = require.resolve('chrome-devtools-mcp/package.json');
    // Optional build output; a different installed upstream version uses live discovery.
    try {
      const snapshot = JSON.parse(
        readFileSync(new URL('./tool-categories.json', import.meta.url), 'utf8'),
      );
      if (
        snapshot.packageVersion === require(packageJsonPath).version &&
        snapshot.categories &&
        typeof snapshot.categories === 'object' &&
        !Array.isArray(snapshot.categories) &&
        Object.values(snapshot.categories).every((category) => typeof category === 'string')
      ) {
        return snapshot.categories;
      }
    } catch {
      // Source checkouts and older packages have no snapshot.
    }
    const toolsUrl = pathToFileURL(
      join(dirname(packageJsonPath), 'build', 'src', 'tools', 'tools.js'),
    );
    const mod = (await import(toolsUrl.href)) as {
      createTools: (args: {
        slim: boolean;
      }) => Array<{ name: string; annotations?: { category?: string } }>;
    };
    const map: Record<string, string> = {};
    for (const tool of mod.createTools({ slim: false })) {
      map[tool.name] = tool.annotations?.category ?? 'other';
    }
    return map;
  } catch (error) {
    // Upstream layout changed — grouping degrades to a single 'other' group.
    console.error(
      `[pi-browser-use] failed to load upstream tool categories; grouping degraded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

/** Group registered upstream tools by category, excluding the core set. */
export function buildGroups(
  registered: readonly string[],
  categories: CategoryMap,
): Map<string, string[]> {
  const core = new Set(CORE_TOOLS);
  const groups = new Map<string, string[]>();
  for (const name of registered) {
    if (core.has(name)) continue;
    const category = categories[name] ?? 'other';
    const list = groups.get(category) ?? [];
    list.push(name);
    groups.set(category, list);
  }
  return groups;
}
