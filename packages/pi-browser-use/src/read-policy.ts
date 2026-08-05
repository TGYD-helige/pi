import { assertPublicHttpUrl, type DnsLookup } from '@amaster.ai/pi-shared';
import type { BrowserReadPolicyV1 } from './config.js';

function canonicalLocator(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

export async function assertBrowserReadNavigation(
  locator: string,
  policy: BrowserReadPolicyV1,
  lookup?: DnsLookup,
): Promise<void> {
  let canonical: string;
  try {
    canonical = canonicalLocator(locator);
  } catch {
    throw new Error('Browser navigation is outside the signed browser read scope.');
  }
  const allowed = policy.allowedTopLevelLocators.some((candidate) => {
    try {
      return canonicalLocator(candidate) === canonical;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new Error('Browser navigation is outside the signed browser read scope.');
  }
  const origin = new URL(canonical).origin;
  if (!policy.allowedTopLevelOrigins.includes(origin)) {
    throw new Error('Browser navigation is outside the signed browser read scope.');
  }
  if (policy.accessMode === 'public') {
    await assertPublicHttpUrl(canonical, lookup);
  }
}

export async function assertBrowserReadSubresource(
  locator: string,
  topLevelOrigin: string,
  policy: BrowserReadPolicyV1,
  lookup?: DnsLookup,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error('Browser subresource is outside the signed browser read scope.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Browser subresource is outside the signed browser read scope.');
  }
  if (
    policy.accessMode === 'authenticated' &&
    url.origin === topLevelOrigin &&
    policy.allowedTopLevelOrigins.includes(url.origin)
  ) {
    return;
  }
  await assertPublicHttpUrl(url, lookup);
}
