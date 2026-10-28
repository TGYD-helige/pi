import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(
  new URL('../../packages/pi-browser-use/dist/index.js', import.meta.url),
);
const fixture = fileURLToPath(new URL('./browser-session-client.mjs', import.meta.url));

export async function waitForSessionEnd(path) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.ended) return record.ended;
    await delay(100);
  }
  throw Error('Browser session did not finish within its cleanup deadline');
}

export function createBrowserSessionRunner(root, configPath, url) {
  const children = new Set();
  async function run(phase, binding) {
    const child = spawn(process.execPath, [fixture, entry, configPath, phase, url], {
      env: {
        ...process.env,
        PI_AGENT_HOME: root,
        PI_CODING_AGENT_DIR: root,
        PI_BROWSER_USE_SESSION_BINDING: binding ? JSON.stringify(binding) : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(Error('Browser session E2E timed out'));
      }, 60000);
      child.once('error', reject);
      child.once('exit', async (code) => {
        clearTimeout(timeout);
        children.delete(child);
        if (code) {
          let state = 'unknown';
          try {
            const current = JSON.parse(await readFile(configPath, 'utf8'));
            const record = JSON.parse(
              await readFile(
                join(
                  root,
                  'browser-sessions',
                  createHash('sha256').update(current.session.key).digest('hex'),
                  'session.json',
                ),
                'utf8',
              ),
            );
            state = record.ended ?? 'live';
          } catch {}
          reject(Error(`Browser session client ${phase} failed (${code}, ${state}): ${stderr}`));
        } else {
          try {
            resolve(stdout.trim() ? JSON.parse(stdout) : {});
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }

  return {
    run,
    stop() {
      for (const child of children) child.kill();
    },
  };
}
