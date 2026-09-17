import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attestCredentialBrowserTcb,
  BrowserCredentialGate,
  credentialBrowserConfig,
  DevToolsClient,
} from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'pi-browser-credential-pipe-'));
const profile = join(root, 'profile');
const sentinel = `mirrorx-credential-pipe-sentinel-${process.pid}`;
const primary = new DevToolsClient(
  credentialBrowserConfig(profile),
  new BrowserCredentialGate(),
  true,
);
let secondary;

try {
  attestCredentialBrowserTcb();
  const pagesResult = await primary.callTrustedTool('list_pages', {});
  if (pagesResult.isError) throw new Error('primary_browser_launch_failed');
  const pageText = pagesResult.content?.find((entry) => entry.type === 'text')?.text ?? '';
  const pageId = Number(/^\s*(\d+):/mu.exec(pageText)?.[1]);
  if (!Number.isSafeInteger(pageId)) throw new Error('primary_page_id_missing');

  await primary.callTrustedTool('evaluate_script', {
    pageId,
    function: `() => ${JSON.stringify(sentinel)}`,
    args: [],
  });

  const processList = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  const chromeCommands = processList
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profile}`));
  if (chromeCommands.length === 0) throw new Error('credential_chrome_process_missing');
  if (!chromeCommands.some((line) => line.includes('--remote-debugging-pipe'))) {
    throw new Error('credential_chrome_pipe_missing');
  }
  if (chromeCommands.some((line) => line.includes('--remote-debugging-port'))) {
    throw new Error('credential_chrome_tcp_debugging_exposed');
  }
  if (existsSync(join(profile, 'DevToolsActivePort'))) {
    throw new Error('credential_chrome_ws_endpoint_exposed');
  }

  secondary = new DevToolsClient(
    credentialBrowserConfig(profile),
    new BrowserCredentialGate(),
    true,
  );
  let secondClientRejected = false;
  try {
    const secondResult = await secondary.callTrustedTool('list_pages', {});
    secondClientRejected = secondResult.isError === true;
  } catch {
    secondClientRejected = true;
  }
  if (!secondClientRejected) throw new Error('credential_second_client_attached');
  if (primary.getCredentialTransportDiagnosticsForVerification().includes(sentinel)) {
    throw new Error('credential_sentinel_in_mcp_stderr');
  }
  if (treeContains(root, sentinel)) throw new Error('credential_sentinel_in_probe_files');

  process.stdout.write(
    `${JSON.stringify({ status: 'passed', transport: 'puppeteer_pipe', secondClient: 'rejected' })}\n`,
  );
} finally {
  await secondary?.close().catch(() => undefined);
  await primary.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

function treeContains(directory, value) {
  if (!existsSync(directory)) return false;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isDirectory()) {
      if (treeContains(path, value)) return true;
    } else if (stat.isFile() && readFileSync(path).includes(Buffer.from(value))) {
      return true;
    }
  }
  return false;
}
