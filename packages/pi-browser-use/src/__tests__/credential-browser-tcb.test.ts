import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configToArgs } from '../config.js';
import {
  attestCredentialBrowserTcb,
  credentialBrowserChildEnv,
  credentialBrowserConfig,
} from '../credential-browser-tcb.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('credential browser TCB', () => {
  it('attests the exact installed chrome-devtools-mcp build tree', () => {
    expect(attestCredentialBrowserTcb()).toMatchObject({
      package: 'chrome-devtools-mcp',
      version: '1.6.0',
      mode: 'puppeteer_pipe',
      buildFileCount: 348,
    });
  });

  it('rejects a version or tree that was not reviewed', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-browser-tcb-'));
    temporaryRoots.push(root);
    mkdirSync(join(root, 'build', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'chrome-devtools-mcp', version: '1.6.1' }),
    );
    writeFileSync(join(root, 'build', 'src', 'browser.js'), 'pipe: true');

    expect(() => attestCredentialBrowserTcb(join(root, 'package.json'))).toThrow(
      'browser_credential_tcb_version_mismatch',
    );

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'chrome-devtools-mcp', version: '1.6.0' }),
    );
    expect(() => attestCredentialBrowserTcb(join(root, 'package.json'))).toThrow(
      'browser_credential_tcb_digest_mismatch',
    );
  });

  it('emits only the credential transport allowlist', () => {
    expect(configToArgs(credentialBrowserConfig('/runtime/profile'), true)).toEqual([
      '--user-data-dir=/runtime/profile',
      '--category-network=false',
      '--experimental-page-id-routing',
      '--no-usage-statistics',
    ]);
  });

  it('does not inherit debug, loader, proxy, or puppeteer variables', () => {
    const env = credentialBrowserChildEnv({
      PATH: '/usr/bin',
      HOME: '/runtime/home',
      LANG: 'C.UTF-8',
      DEBUG: 'mcp:*',
      NODE_OPTIONS: '--require=/tmp/hook.cjs',
      PI_BROWSER_USE_NODE: '/tmp/wrapper',
      HTTPS_PROXY: 'http://attacker.invalid',
      PUPPETEER_EXECUTABLE_PATH: '/tmp/browser',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/runtime/home', LANG: 'C.UTF-8' });
  });
});
