import type { DnsLookup } from '@amaster.ai/pi-shared';
import { describe, expect, it } from 'vitest';
import type { BrowserReadPolicyV1 } from '../config.js';
import { resolveBrowserProxyTarget } from '../policy-proxy.js';

const lookup: DnsLookup = async (hostname) => [
  {
    address: hostname === 'private.example' ? '10.0.0.9' : '93.184.216.34',
    family: 4,
  },
];

const authenticatedPolicy: BrowserReadPolicyV1 = {
  version: 'browser_read_policy_v1',
  accessMode: 'authenticated',
  allowedTopLevelLocators: ['https://private.example/source'],
  allowedTopLevelOrigins: ['https://private.example'],
  subresources: 'public_or_same_origin',
  privateCrossOriginSubresources: 'deny',
  popups: 'deny',
  downloads: 'deny',
  newTargets: 'deny',
};

describe('resolveBrowserProxyTarget', () => {
  it('pins a public third-party host to its validated address', async () => {
    await expect(
      resolveBrowserProxyTarget('https://cdn.example/image.png', authenticatedPolicy, lookup),
    ).resolves.toMatchObject({ hostname: 'cdn.example', address: '93.184.216.34', port: 443 });
  });

  it('allows the signed authenticated origin even when it resolves privately', async () => {
    await expect(
      resolveBrowserProxyTarget('https://private.example/source', authenticatedPolicy, lookup),
    ).resolves.toMatchObject({ hostname: 'private.example', address: '10.0.0.9', port: 443 });
  });

  it('rejects a private cross-origin host before opening a socket', async () => {
    await expect(
      resolveBrowserProxyTarget(
        'https://other-private.example/resource',
        authenticatedPolicy,
        async () => [{ address: '192.168.1.8', family: 4 }],
      ),
    ).rejects.toThrow('public HTTP(S) destination');
  });
});
