import type { Browser, ChromeReleaseChannel, LaunchOptions, Page, Target } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';
import {
  type InstalledBrowserReadPagePolicy,
  installBrowserReadPagePolicy,
} from './browser-read-enforcer.js';
import type { BrowserUseConfig } from './config.js';
import { type BrowserPolicyProxy, startBrowserPolicyProxy } from './policy-proxy.js';

export type BrowserReadSession = {
  mcpConfig: BrowserUseConfig;
  close(): Promise<void>;
};

function chromeChannel(channel: BrowserUseConfig['channel']): ChromeReleaseChannel {
  switch (channel) {
    case 'beta':
      return 'chrome-beta';
    case 'canary':
      return 'chrome-canary';
    case 'dev':
      return 'chrome-dev';
    default:
      return 'chrome';
  }
}

function parseViewport(value: string | undefined): { width: number; height: number } | null {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function mcpConnectionConfig(config: BrowserUseConfig, browser: Browser): BrowserUseConfig {
  const result: BrowserUseConfig = {
    ...config,
    sessionMode: 'existing',
    wsEndpoint: browser.wsEndpoint(),
    autoConnect: false,
    isolated: false,
  };
  delete result.browserUrl;
  delete result.wsHeaders;
  delete result.userDataDir;
  delete result.readPolicy;
  delete result.allowedUrlPattern;
  delete result.blockedUrlPattern;
  delete result.extraArgs;
  return result;
}

async function selectBoundPage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  if (pages.length !== 1) {
    throw new Error('Browser read policy requires exactly one dedicated page.');
  }
  return pages[0]!;
}

async function closeNewTarget(target: Target, boundTarget: Target): Promise<void> {
  if (target === boundTarget) return;
  try {
    const page = await target.page();
    if (page) {
      await page.close({ runBeforeUnload: false });
      return;
    }
    const worker = await target.worker();
    if (worker) await worker.close();
  } catch {
    // The target may already have disappeared after being denied.
  }
}

/**
 * Launch one dedicated Chromium through pi-browser-use, attach the pre-request
 * policy, then let chrome-devtools-mcp connect to that same browser. Public
 * runs use an ephemeral profile; authenticated runs reuse only the adapter-
 * resolved profile directory and never attach to an arbitrary live browser.
 */
export async function startBrowserReadSession(
  config: BrowserUseConfig,
): Promise<BrowserReadSession | undefined> {
  const policy = config.readPolicy;
  if (!policy) return undefined;

  let proxy: BrowserPolicyProxy | undefined;
  let browser: Browser | undefined;
  let pagePolicy: InstalledBrowserReadPagePolicy | undefined;
  let targetHandler: ((target: Target) => void) | undefined;
  try {
    proxy = await startBrowserPolicyProxy(policy);
    const launchOptions: LaunchOptions = {
      defaultViewport: parseViewport(config.viewport),
      downloadBehavior: { policy: 'deny' },
      args: [
        `--proxy-server=${proxy.url}`,
        '--proxy-bypass-list=<-loopback>',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
      ],
    };
    if (config.executablePath) launchOptions.executablePath = config.executablePath;
    else launchOptions.channel = chromeChannel(config.channel);
    if (config.headless !== undefined) launchOptions.headless = config.headless;
    if (config.acceptInsecureCerts !== undefined) {
      launchOptions.acceptInsecureCerts = config.acceptInsecureCerts;
    }
    if (policy.accessMode === 'authenticated' && config.userDataDir) {
      launchOptions.userDataDir = config.userDataDir;
    }
    browser = await puppeteer.launch(launchOptions);
    const page = await selectBoundPage(browser);
    pagePolicy = await installBrowserReadPagePolicy(page, policy);
    const boundTarget = page.target();
    targetHandler = (target) => {
      void closeNewTarget(target, boundTarget);
    };
    browser.on('targetcreated', targetHandler);

    return {
      mcpConfig: mcpConnectionConfig(config, browser),
      async close() {
        if (targetHandler) browser?.off('targetcreated', targetHandler);
        await pagePolicy?.close();
        await browser?.close();
        await proxy?.close();
      },
    };
  } catch {
    if (targetHandler) browser?.off('targetcreated', targetHandler);
    await pagePolicy?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    throw new Error('Browser read policy session could not be established.');
  }
}
