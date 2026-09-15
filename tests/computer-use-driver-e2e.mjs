#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageRoot = path.join(repoRoot, 'packages', 'pi-computer-use');
const release = JSON.parse(readFileSync(path.join(packageRoot, 'driver-release.json'), 'utf8'));
const { CuaDriverClient, resolveDriverLayout } = await import(
  pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href
);
const layout = resolveDriverLayout({ mode: 'bundled' });
assert.match(execFileSync(layout.binaryPath, ['--version'], { encoding: 'utf8' }), new RegExp(`${release.version}\\s*$`));

const client = new CuaDriverClient({ mode: 'bundled' });
try {
  const tools = await client.listAllTools();
  const names = new Set(tools.map(({ name }) => name));
  for (const name of ['get_window_state', 'click', 'check_permissions', 'health_report']) assert(names.has(name), `missing ${name}`);
  assert(tools.length >= 50, `expected at least 50 tools, received ${tools.length}`);
  for (const [name, args] of [['health_report', {}], ['check_permissions', { prompt: false }]]) {
    const result = await client.callTool(name, args);
    assert.notEqual(result.isError, true, `${name} returned an error`);
  }
  const cursor = await client.callTool('get_cursor_position', {});
  assert.notEqual(cursor.isError, true, 'get_cursor_position returned an error');
  assert(Number.isFinite(cursor.structuredContent?.x), 'cursor x is unavailable');
  assert(Number.isFinite(cursor.structuredContent?.y), 'cursor y is unavailable');
  process.stdout.write(`Cua Driver ${release.version}: ${tools.length} MCP tools verified.\n`);
} finally {
  await client.close();
}
