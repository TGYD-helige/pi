import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'linux') {
  throw new Error('computer-use owner-exit integration test requires Linux');
}

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repoRoot, 'packages', 'pi-computer-use');
const extensionUrl = pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href;
const { resolveDriverLayout } = await import(extensionUrl);
const { binaryPath } = resolveDriverLayout({ mode: 'bundled' });

const owner = execFile(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    `
      import { CuaDriverClient } from ${JSON.stringify(extensionUrl)};
      const client = new CuaDriverClient({ mode: 'bundled' });
      await client.connect();
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1_000);
    `,
  ],
  { cwd: repoRoot, maxBuffer: 8_192 },
);
let ownerStderr = '';
owner.stderr?.on('data', (chunk) => {
  ownerStderr = `${ownerStderr}${chunk}`.slice(-8_192);
});

let socketPath;
let daemonPid;
let leasePid;
let proxyPid;

try {
  socketPath = await waitForSocket(owner);
  try {
    await waitFor(async () => {
      ({ daemonPid, leasePid, proxyPid } = await findDriverProcesses(socketPath));
      return Boolean(daemonPid && leasePid && proxyPid);
    }, 5_000);
  } catch {
    throw new Error(`Cua Driver processes not found for ${socketPath}`);
  }

  owner.kill('SIGKILL');
  await waitFor(() => owner.exitCode !== null || owner.signalCode !== null, 5_000);
  let cleanupStatus;
  try {
    await waitFor(async () => {
      cleanupStatus = await inspectCleanup(socketPath, { daemonPid, leasePid, proxyPid });
      return cleanupStatus.complete;
    }, 5_000);
  } catch {
    throw new Error(`Cua Driver cleanup timed out: ${JSON.stringify(cleanupStatus)}`);
  }

  console.log('Cua Driver lease, daemon, and proxy exited after their owner was killed.');
} finally {
  if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  if (socketPath && existsSync(socketPath)) {
    await execFileAsync(binaryPath, ['stop', '--socket', socketPath], { timeout: 3_000 }).catch(
      () => undefined,
    );
  }
  for (const pid of [daemonPid, leasePid, proxyPid]) {
    if (!pid || !(await processMatchesSocket(pid, socketPath))) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The exact test-owned process may have exited between the check and kill.
    }
  }
  if (socketPath) await rm(socketPath, { force: true }).catch(() => undefined);
}

async function waitForSocket(ownerProcess) {
  const ownerPid = ownerProcess.pid;
  const pattern = new RegExp(`^pi-cua-${ownerPid}-[0-9a-f]{8}\\.sock$`);
  let socket;
  await waitFor(async () => {
    if (ownerProcess.exitCode !== null || ownerProcess.signalCode !== null) {
      throw new Error(`Owner exited before its daemon started:\n${ownerStderr}`);
    }
    for (const directory of new Set([tmpdir(), '/tmp'])) {
      const entries = await readdir(directory).catch(() => []);
      const filename = entries.find((entry) => pattern.test(entry));
      if (filename) {
        socket = path.join(directory, filename);
        return true;
      }
    }
    return false;
  }, 15_000);
  return socket;
}

async function findDriverProcesses(socket) {
  let daemonPid;
  let leasePid;
  let proxyPid;
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const command = await readFile(`/proc/${entry.name}/cmdline`, 'utf8').catch(() => '');
    if (!command.includes(socket)) continue;
    if (command.includes('\0serve\0')) daemonPid = Number(entry.name);
    if (command.includes('pi-computer-use-lease')) leasePid = Number(entry.name);
    if (command.includes('\0mcp\0')) proxyPid = Number(entry.name);
  }
  return { daemonPid, leasePid, proxyPid };
}

async function processMatchesSocket(pid, socket) {
  if (!socket) return false;
  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  return command.includes(socket);
}

async function inspectCleanup(socket, { daemonPid, leasePid, proxyPid }) {
  const [daemon, lease, proxy] = await Promise.all([
    inspectProcess(daemonPid, socket),
    inspectProcess(leasePid, socket),
    inspectProcess(proxyPid, socket),
  ]);
  const socketExists = existsSync(socket);
  return {
    complete: !socketExists && !daemon.running && !lease.running && !proxy.running,
    socketExists,
    daemon,
    lease,
    proxy,
  };
}

async function inspectProcess(pid, socket) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  if (!stat) return { pid, state: 'missing', matchesSocket: false, running: false };

  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0) || 'unknown';
  const matchesSocket = command.includes(socket);
  return {
    pid,
    state,
    matchesSocket,
    running: matchesSocket && state !== 'Z' && state !== 'X',
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
