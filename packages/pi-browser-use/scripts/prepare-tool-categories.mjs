import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = new URL('../', import.meta.url);
const require = createRequire(new URL('package.json', packageRoot));
const upstreamPath = require.resolve('chrome-devtools-mcp/package.json');
const { createTools } = await import(pathToFileURL(join(dirname(upstreamPath), 'build/src/tools/tools.js')).href);
const categories = Object.fromEntries(createTools({ slim: false }).map((tool) => [tool.name, tool.annotations?.category ?? 'other']));
writeFileSync(new URL('dist/tool-categories.json', packageRoot), JSON.stringify({
  packageVersion: require(upstreamPath).version,
  categories,
}) + '\n');
