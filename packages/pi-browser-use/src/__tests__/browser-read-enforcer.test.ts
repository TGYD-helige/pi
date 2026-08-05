import type { DnsLookup } from '@amaster.ai/pi-shared';
import { describe, expect, it, vi } from 'vitest';
import { installBrowserReadPagePolicy } from '../browser-read-enforcer.js';
import type { BrowserReadPolicyV1 } from '../config.js';

const publicLookup: DnsLookup = async (hostname) => [
  {
    address: hostname === 'private.example' ? '10.0.0.8' : '93.184.216.34',
    family: 4,
  },
];

const policy: BrowserReadPolicyV1 = {
  version: 'browser_read_policy_v1',
  accessMode: 'authenticated',
  allowedTopLevelLocators: ['https://app.example/source'],
  allowedTopLevelOrigins: ['https://app.example'],
  subresources: 'public_or_same_origin',
  privateCrossOriginSubresources: 'deny',
  popups: 'deny',
  downloads: 'deny',
  newTargets: 'deny',
};

function fakePage() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const mainFrame = {};
  return {
    page: {
      url: vi.fn(() => 'https://app.example/source'),
      mainFrame: vi.fn(() => mainFrame),
      setBypassServiceWorker: vi.fn(() => Promise.resolve()),
      setRequestInterception: vi.fn(() => Promise.resolve()),
      evaluateOnNewDocument: vi.fn(() => Promise.resolve()),
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        handlers.set(name, handler);
      }),
      off: vi.fn(),
    },
    handlers,
    mainFrame,
  };
}

function fakeRequest(url: string, frame: unknown, navigation = false) {
  return {
    url: vi.fn(() => url),
    frame: vi.fn(() => frame),
    isNavigationRequest: vi.fn(() => navigation),
    continue: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
  };
}

describe('installBrowserReadPagePolicy', () => {
  it('continues a public third-party subresource from an authenticated page', async () => {
    const { page, handlers, mainFrame } = fakePage();
    await installBrowserReadPagePolicy(page as any, policy, publicLookup);
    const request = fakeRequest('https://cdn.example/image.png', mainFrame);

    await handlers.get('request')!(request);

    expect(request.continue).toHaveBeenCalledOnce();
    expect(request.abort).not.toHaveBeenCalled();
  });

  it('aborts a private cross-origin subresource before it is continued', async () => {
    const { page, handlers, mainFrame } = fakePage();
    await installBrowserReadPagePolicy(page as any, policy, publicLookup);
    const request = fakeRequest('https://private.example/metadata', mainFrame);

    await handlers.get('request')!(request);

    expect(request.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(request.continue).not.toHaveBeenCalled();
  });

  it('allows same-origin private subresources for the signed authenticated origin', async () => {
    const { page, handlers, mainFrame } = fakePage();
    const privatePolicy = {
      ...policy,
      allowedTopLevelLocators: ['https://private.example/source'],
      allowedTopLevelOrigins: ['https://private.example'],
    };
    page.url.mockReturnValue('https://private.example/source');
    await installBrowserReadPagePolicy(page as any, privatePolicy, publicLookup);
    const request = fakeRequest('https://private.example/image.png', mainFrame);

    await handlers.get('request')!(request);

    expect(request.continue).toHaveBeenCalledOnce();
    expect(request.abort).not.toHaveBeenCalled();
  });

  it('aborts an undeclared top-level redirect before it is continued', async () => {
    const { page, handlers, mainFrame } = fakePage();
    await installBrowserReadPagePolicy(page as any, policy, publicLookup);
    const request = fakeRequest('https://other.example/redirected', mainFrame, true);

    await handlers.get('request')!(request);

    expect(request.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(request.continue).not.toHaveBeenCalled();
  });
});
