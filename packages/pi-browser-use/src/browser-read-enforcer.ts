import type { DnsLookup } from '@amaster.ai/pi-shared';
import type { BrowserReadPolicyV1 } from './config.js';
import { assertBrowserReadNavigation, assertBrowserReadSubresource } from './read-policy.js';

type InterceptedRequest = {
  url(): string;
  frame(): unknown;
  isNavigationRequest(): boolean;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

export type BrowserReadPage = {
  url(): string;
  mainFrame(): unknown;
  setBypassServiceWorker(value: boolean): Promise<void>;
  setRequestInterception(value: boolean): Promise<void>;
  evaluateOnNewDocument(pageFunction: () => void): Promise<unknown>;
  on(event: 'request', handler: (request: InterceptedRequest) => void): unknown;
  off(event: 'request', handler: (request: InterceptedRequest) => void): unknown;
};

export type InstalledBrowserReadPagePolicy = {
  close(): Promise<void>;
};

function topLevelOrigin(page: BrowserReadPage, policy: BrowserReadPolicyV1): string {
  try {
    return new URL(page.url()).origin;
  } catch {
    return policy.allowedTopLevelOrigins[0] ?? 'null';
  }
}

/**
 * Pause every request from a bound page before Chrome transmits it. Top-level
 * navigations keep exact signed scope; subresources may use the signed origin
 * or a public destination. The policy proxy independently re-resolves and pins
 * the destination address before opening the outbound socket.
 */
export async function installBrowserReadPagePolicy(
  page: BrowserReadPage,
  policy: BrowserReadPolicyV1,
  lookup?: DnsLookup,
): Promise<InstalledBrowserReadPagePolicy> {
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(globalThis, 'open', {
      configurable: false,
      value: () => null,
      writable: false,
    });
  });

  const onRequest = async (request: InterceptedRequest) => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        await assertBrowserReadNavigation(request.url(), policy, lookup);
      } else {
        await assertBrowserReadSubresource(
          request.url(),
          topLevelOrigin(page, policy),
          policy,
          lookup,
        );
      }
      await request.continue();
    } catch {
      await request.abort('blockedbyclient');
    }
  };
  page.on('request', onRequest);

  return {
    async close() {
      page.off('request', onRequest);
      await page.setRequestInterception(false).catch(() => {});
    },
  };
}
