import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserReadPolicyV1 } from '../config.js';

const mockProxyClose = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockStartProxy = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ url: 'http://127.0.0.1:43123', close: mockProxyClose })),
);
const mockPagePolicyClose = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockInstallPagePolicy = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ close: mockPagePolicyClose })),
);
const mockBrowserClose = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockBrowserOn = vi.hoisted(() => vi.fn());
const mockBrowserOff = vi.hoisted(() => vi.fn());
const mockPage = vi.hoisted(() => ({ target: vi.fn(() => ({ id: 'bound' })) }));
const mockBrowser = vi.hoisted(() => ({
  wsEndpoint: vi.fn(() => 'ws://127.0.0.1:43124/devtools/browser/opaque'),
  pages: vi.fn(() => Promise.resolve([mockPage])),
  on: mockBrowserOn,
  off: mockBrowserOff,
  close: mockBrowserClose,
}));
const mockLaunch = vi.hoisted(() => vi.fn((_options: unknown) => Promise.resolve(mockBrowser)));

vi.mock('../policy-proxy.js', () => ({ startBrowserPolicyProxy: mockStartProxy }));
vi.mock('../browser-read-enforcer.js', () => ({
  installBrowserReadPagePolicy: mockInstallPagePolicy,
}));
vi.mock('puppeteer-core', () => ({ default: { launch: mockLaunch } }));

const { startBrowserReadSession } = await import('../browser-read-session.js');

const publicPolicy: BrowserReadPolicyV1 = {
  version: 'browser_read_policy_v1',
  accessMode: 'public',
  allowedTopLevelLocators: ['https://public.example/source'],
  allowedTopLevelOrigins: ['https://public.example'],
  subresources: 'public_or_same_origin',
  privateCrossOriginSubresources: 'deny',
  popups: 'deny',
  downloads: 'deny',
  newTargets: 'deny',
};

describe('startBrowserReadSession', () => {
  beforeEach(() => {
    mockStartProxy.mockClear();
    mockInstallPagePolicy.mockClear();
    mockLaunch.mockClear();
    mockBrowserClose.mockClear();
    mockProxyClose.mockClear();
    mockPagePolicyClose.mockClear();
    mockBrowserOn.mockClear();
    mockBrowserOff.mockClear();
  });

  it('launches one ephemeral browser behind the pinning proxy and gives MCP its endpoint', async () => {
    const session = await startBrowserReadSession({
      sessionMode: 'isolated',
      headless: true,
      readPolicy: publicPolicy,
    });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadBehavior: { policy: 'deny' },
        args: expect.arrayContaining([
          '--proxy-server=http://127.0.0.1:43123',
          '--proxy-bypass-list=<-loopback>',
        ]),
      }),
    );
    expect(mockLaunch.mock.calls[0]![0]).not.toHaveProperty('userDataDir');
    expect(mockInstallPagePolicy).toHaveBeenCalledWith(mockPage, publicPolicy);
    expect(session?.mcpConfig).toMatchObject({
      sessionMode: 'existing',
      wsEndpoint: 'ws://127.0.0.1:43124/devtools/browser/opaque',
    });
    expect(session?.mcpConfig.readPolicy).toBeUndefined();
  });

  it('reuses only the adapter-resolved authenticated profile', async () => {
    await startBrowserReadSession({
      sessionMode: 'existing',
      userDataDir: '/opaque/browser-profile',
      readPolicy: { ...publicPolicy, accessMode: 'authenticated' },
    });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ userDataDir: '/opaque/browser-profile' }),
    );
  });

  it('closes policy interception, browser and proxy in order at shutdown', async () => {
    const session = await startBrowserReadSession({
      sessionMode: 'isolated',
      readPolicy: publicPolicy,
    });

    await session?.close();

    expect(mockPagePolicyClose).toHaveBeenCalledOnce();
    expect(mockBrowserClose).toHaveBeenCalledOnce();
    expect(mockProxyClose).toHaveBeenCalledOnce();
  });
});
