import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('node:https', () => ({ request: requestMock }));

import { safeFetch } from '../network.js';

describe('network transport', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('uses the single-address lookup contract when connecting to a pinned address', async () => {
    requestMock.mockImplementation(
      (
        _url: URL,
        options: {
          family?: number;
          lookup: (
            hostname: string,
            options: { all: boolean; family: number },
            callback: (error: Error | null, address: unknown, family?: number) => void,
          ) => void;
        },
        onResponse: (response: {
          headers: Record<string, string>;
          statusCode: number;
          statusMessage: string;
        }) => void,
      ) => {
        const request = new EventEmitter() as EventEmitter & { end(): void };
        request.end = () => {
          const all = options.family === undefined;
          options.lookup(
            'cdn.example',
            { all, family: options.family ?? 0 },
            (error, address, family) => {
              if (error) {
                request.emit('error', error);
                return;
              }
              if (all ? !Array.isArray(address) : typeof address !== 'string' || !family) {
                request.emit('error', new TypeError('lookup callback returned the wrong shape'));
                return;
              }
              onResponse({ headers: {}, statusCode: 200, statusMessage: 'OK' });
            },
          );
        };
        return request;
      },
    );

    await expect(
      safeFetch(
        'https://cdn.example/image.png',
        { method: 'HEAD' },
        { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('cancels while resolving a redirect without making another connection', async () => {
    const controller = new AbortController();
    requestMock.mockImplementation(
      (_url: URL, _options: unknown, onResponse: (response: unknown) => void) => {
        const request = new EventEmitter() as EventEmitter & { end(): void };
        request.end = () =>
          onResponse({
            headers: { location: 'https://redirect.example/next' },
            statusCode: 302,
            statusMessage: 'Found',
          });
        return request;
      },
    );
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockImplementationOnce(() => {
        controller.abort(new Error('redirect DNS cancelled'));
        return new Promise(() => {});
      });
    await expect(
      safeFetch(
        'https://cdn.example/start',
        { method: 'HEAD', signal: controller.signal },
        { lookup },
      ),
    ).rejects.toThrow('redirect DNS cancelled');
    expect(requestMock.mock.calls.length).toBe(1);
  });

  it('revalidates every redirect before following it', async () => {
    requestMock.mockImplementation(
      (
        _url: URL,
        _options: unknown,
        onResponse: (response: {
          headers: Record<string, string>;
          statusCode: number;
          statusMessage: string;
        }) => void,
      ) => {
        const request = new EventEmitter() as EventEmitter & { end(): void };
        request.end = () => {
          onResponse({
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
            statusCode: 302,
            statusMessage: 'Found',
          });
        };
        return request;
      },
    );

    await expect(
      safeFetch(
        'https://cdn.example/start',
        { method: 'HEAD' },
        { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
      ),
    ).rejects.toThrow(/public HTTP/i);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
