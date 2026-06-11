#!/usr/bin/env node
import { startDashboardServer } from './server.js';

const args = process.argv.slice(2);
const command = args[0];

if (command !== 'serve') {
  printHelp();
  process.exit(command ? 1 : 0);
}

const workspace = readFlag('--workspace') ?? process.cwd();
const portValue = readFlag('--port');
const host = readFlag('--host') ?? '127.0.0.1';
const port = portValue ? Number(portValue) : 0;

const server = await startDashboardServer({
  workspaceDir: workspace,
  host,
  port: Number.isFinite(port) ? port : 0,
});

console.log(`Pi Dashboard running at ${server.url}`);
console.log(`Workspace: ${workspace}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

function readFlag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printHelp(): void {
  console.log('Usage: pi-dashboard serve --workspace <dir> [--port <port>] [--host <host>]');
}
