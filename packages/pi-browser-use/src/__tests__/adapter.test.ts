import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserAdapter } from '../adapter.js';
import { validateBrowserBinding } from '../session-backend.js';

describe('browser adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { config: { headless: true }, ownership: 'local' },
    { config: { sessionMode: 'existing' as const }, ownership: 'external' },
    { config: { wsEndpoint: 'ws://localhost:9222' }, ownership: 'external' },
    { config: { browserUrl: 'http://sidecar:9222' }, ownership: 'external' },
  ] as const)('acquires $ownership connections without creating a cloud instance', async ({
    config,
    ownership,
  }) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const adapter = await createBrowserAdapter(config);
    const signal = new AbortController().signal;
    const browser = await adapter.acquire(config, signal);
    expect(adapter.ownership).toBe(ownership);
    expect(browser.id).toEqual(expect.any(String));
    expect(browser.connection).toMatchObject(config);
    expect(() => validateBrowserBinding(browser, ownership)).not.toThrow();
    await adapter.release(browser, signal);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the same acquire/release interface for injected backends and preserves their receiver', async () => {
    const browser = { id: 'owned', connection: { wsEndpoint: 'ws://localhost:9222' } };
    const backend = {
      browser,
      async acquire() {
        return this.browser;
      },
      async release(value: typeof browser) {
        expect(value).toBe(this.browser);
      },
    };
    const adapter = await createBrowserAdapter({}, { adapter: backend });
    const signal = new AbortController().signal;
    expect(await adapter.acquire({}, signal)).toBe(browser);
    await adapter.release(browser, signal);
  });

  it('validates native connection headers before starting a transport', () => {
    expect(() =>
      validateBrowserBinding({ id: 'native', connection: JSON.parse('{"wsHeaders":0}') }, 'local'),
    ).toThrow();
  });

  it('keeps malformed managed connections from falling back to local Chrome', async () => {
    expect(() => validateBrowserBinding({ id: 'paid', connection: {} })).toThrow('explicit CDP');
    const adapter = await createBrowserAdapter({});
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(adapter.acquire({}, controller.signal)).rejects.toThrow('cancelled');
  });
  it('keeps disabled session credentials unused when selecting a direct adapter', async () => {
    const config = {
      session: { enabled: false as const, provider: { name: 'steel' as const, apiKey: '' } },
      wsEndpoint: 'ws://localhost:9222',
    };
    const adapter = await createBrowserAdapter(config);
    expect(adapter.ownership).toBe('external');
    expect(
      (await adapter.acquire(config, new AbortController().signal)).connection,
    ).not.toHaveProperty('session');
  });
});
