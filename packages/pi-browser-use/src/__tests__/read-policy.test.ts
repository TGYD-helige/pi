import { describe, expect, it } from 'vitest';
import type { BrowserReadPolicyV1 } from '../config.js';
import { assertBrowserReadNavigation, assertBrowserReadSubresource } from '../read-policy.js';

const publicPolicy: BrowserReadPolicyV1 = {
  version: 'browser_read_policy_v1',
  accessMode: 'public',
  allowedTopLevelLocators: ['https://example.com/page'],
  allowedTopLevelOrigins: ['https://example.com'],
  subresources: 'public_or_same_origin',
  privateCrossOriginSubresources: 'deny',
  popups: 'deny',
  downloads: 'deny',
  newTargets: 'deny',
};

describe('assertBrowserReadNavigation', () => {
  it('allows only a declared public top-level locator', async () => {
    await expect(
      assertBrowserReadNavigation('https://example.com/page', publicPolicy, async () => [
        { address: '93.184.216.34', family: 4 },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      assertBrowserReadNavigation('https://example.com/other', publicPolicy, async () => [
        { address: '93.184.216.34', family: 4 },
      ]),
    ).rejects.toThrow('outside the signed browser read scope');
  });

  it('rejects a declared public locator when DNS resolves privately', async () => {
    await expect(
      assertBrowserReadNavigation('https://example.com/page', publicPolicy, async () => [
        { address: '192.168.1.5', family: 4 },
      ]),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('allows the exact authenticated locator without sending it to a public reader', async () => {
    await expect(
      assertBrowserReadNavigation('https://private.example/page', {
        ...publicPolicy,
        accessMode: 'authenticated',
        allowedTopLevelLocators: ['https://private.example/page'],
        allowedTopLevelOrigins: ['https://private.example'],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('assertBrowserReadSubresource', () => {
  it('allows public third-party resources without expanding top-level navigation', async () => {
    await expect(
      assertBrowserReadSubresource(
        'https://cdn.example.net/image.png',
        'https://example.com',
        publicPolicy,
        async () => [{ address: '93.184.216.35', family: 4 }],
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects private cross-origin resources before the request is continued', async () => {
    await expect(
      assertBrowserReadSubresource(
        'https://internal.example/image.png',
        'https://example.com',
        publicPolicy,
        async () => [{ address: '10.0.0.8', family: 4 }],
      ),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('allows the signed authenticated origin but still rejects another private origin', async () => {
    const authenticatedPolicy: BrowserReadPolicyV1 = {
      ...publicPolicy,
      accessMode: 'authenticated',
      allowedTopLevelLocators: ['https://private.example/page'],
      allowedTopLevelOrigins: ['https://private.example'],
    };
    await expect(
      assertBrowserReadSubresource(
        'https://private.example/image.png',
        'https://private.example',
        authenticatedPolicy,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertBrowserReadSubresource(
        'https://other-private.example/image.png',
        'https://private.example',
        authenticatedPolicy,
        async () => [{ address: '10.0.0.9', family: 4 }],
      ),
    ).rejects.toThrow(/public HTTP/i);
  });
});
