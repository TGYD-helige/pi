import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListToolsResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  type BrowserUseConfig,
  buildSubprocessEnv,
  configToArgs,
  DEFAULT_ENV_ALLOWLIST,
} from './config.js';
import type { CategoryMap } from './tool-groups.js';

const require = createRequire(import.meta.url);
export function sandboxCatalogIdentity(config: BrowserUseConfig) {
  // Connection bindings rotate per Run; they do not change upstream tool schemas.
  const args = configToArgs(config).filter(
    (arg) => !/^--(?:ws-endpoint|ws-headers|browser-url|user-data-dir|executable-path)=/.test(arg),
  );
  return {
    schema: 'pi-browser-use.sandbox-tool-catalog.v1' as const,
    mcpVersion: require('chrome-devtools-mcp/package.json').version as string,
    configurationSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
  };
}
export interface SandboxToolCatalog extends ReturnType<typeof sandboxCatalogIdentity> {
  tools: Tool[];
  categories: CategoryMap;
}

/** An optional image-owned index; cache misses retain live discovery. */
export function readSandboxToolCatalog(config: BrowserUseConfig): SandboxToolCatalog | undefined {
  if (process.env.MIRRORX_EXECUTION_ISOLATED !== '1') return;
  const env = buildSubprocessEnv(process.env, config.envAllowlist, config.envBlocklist);
  if (
    config.envAllowlist?.some((name) => {
      name = name.trim();
      return (
        name !== 'CHROME_DEVEL_SANDBOX' &&
        !DEFAULT_ENV_ALLOWLIST.includes(name) &&
        env[name] !== undefined
      );
    })
  )
    return;
  try {
    const file = fileURLToPath(new URL('./sandbox-tool-catalog.json', import.meta.url));
    for (let path = file; ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (
        stat.uid !== 0 ||
        stat.mode & 0o022 ||
        stat.isSymbolicLink() ||
        (path === file && (!stat.isFile() || stat.size > 1024 * 1024))
      )
        return;
      if (path === '/') break;
    }
    const catalog = JSON.parse(readFileSync(file, 'utf8')) as SandboxToolCatalog;
    const expected = sandboxCatalogIdentity(config);
    if (
      catalog.schema !== expected.schema ||
      catalog.mcpVersion !== expected.mcpVersion ||
      catalog.configurationSha256 !== expected.configurationSha256 ||
      !catalog.categories ||
      typeof catalog.categories !== 'object' ||
      Array.isArray(catalog.categories) ||
      Object.values(catalog.categories).some((value) => typeof value !== 'string')
    )
      return;
    return { ...catalog, tools: ListToolsResultSchema.parse({ tools: catalog.tools }).tools };
  } catch {
    return;
  }
}
