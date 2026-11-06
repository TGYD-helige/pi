import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../registry.js';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

describe('ChannelRegistry', () => {
  it('returns a safe timeout and ambiguous delivery outcome', async () => {
    const registry = new ChannelRegistry();
    registry.register('fixture', {
      direction: 'outgoing',
      send: async () => {
        throw new DOMException('secret-token', 'TimeoutError');
      },
    } as any);
    const result = await registry.send({ adapter: 'fixture', recipient: 'room', text: 'hello' });
    expect(result).toHaveProperty('errorCategory', 'timeout');
    expect(result.error).toContain('Delivery may have completed');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    safeFetchMock.mockReset();
    safeFetchMock.mockImplementation((input, init) => globalThis.fetch(input, init));
  });

  it('does not forward webhook credentials to a recipient outside configured routes', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const log = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ChannelRegistry();
    registry.setLogger(log);
    await registry.loadConfig(
      {
        adapters: {
          webhook: { type: 'webhook', secret: 'configured-secret' },
        },
        routes: {
          ops: {
            adapter: 'webhook',
            recipient: 'https://allowed.example/hook?token=recipient-secret',
          },
        },
      },
      '/workspace',
    );

    const rejected = await registry.send({
      adapter: 'ops',
      recipient: 'https://attacker.example/collect',
      text: 'hello',
    });
    const allowed = await registry.send({ adapter: 'ops', recipient: '', text: 'hello' });

    expect(rejected).toEqual({
      ok: false,
      error: 'Credentialed webhook destinations must use a configured route.',
    });
    expect(allowed).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://allowed.example/hook?token=recipient-secret',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer configured-secret' }),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('recipient-secret');
  });

  it('rejects a private webhook destination even when the adapter has no credentials', async () => {
    const { safeFetch } =
      await vi.importActual<typeof import('@amaster.ai/pi-shared')>('@amaster.ai/pi-shared');
    safeFetchMock.mockImplementation(safeFetch);
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ChannelRegistry();
    await registry.loadConfig(
      {
        adapters: {
          webhook: { type: 'webhook' },
        },
      },
      '/workspace',
    );

    await expect(
      registry.send({
        adapter: 'webhook',
        recipient: 'http://127.0.0.1/private',
        text: 'hello',
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('Outbound URL must use a public HTTP(S) destination.'),
      errorCategory: 'invalid_request',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds webhook sends and propagates caller cancellation', async () => {
    safeFetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const registry = new ChannelRegistry();
    await registry.loadConfig(
      {
        adapters: { webhook: { type: 'webhook' } },
        routes: { ops: { adapter: 'webhook', recipient: 'https://example.test/hook' } },
      },
      '/workspace',
    );
    const controller = new AbortController();

    await registry.send({ adapter: 'ops', recipient: '', text: 'hello' }, controller.signal);

    const init = safeFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it('does not return webhook response bodies to callers', async () => {
    safeFetchMock.mockResolvedValue(
      new Response('remote response contains secret material', { status: 500 }),
    );
    const registry = new ChannelRegistry();
    await registry.loadConfig({ adapters: { webhook: { type: 'webhook' } } }, '/workspace');

    const result = await registry.send({
      adapter: 'webhook',
      recipient: 'https://example.test/hook',
      text: 'hello',
    });

    expect(result).toMatchObject({ ok: false, errorCategory: 'http_error', httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('secret material');
  });

  it('logs bounded metadata without message text or raw adapter errors', async () => {
    const log = vi.fn();
    const registry = new ChannelRegistry();
    registry.setLogger(log);
    registry.register('failing', {
      direction: 'outgoing',
      send: async () => {
        throw new Error('remote body contains configured-secret');
      },
    });

    await registry.send({
      adapter: 'failing',
      recipient: 'target',
      text: 'private message',
      source: 'unit',
    });

    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain('private message');
    expect(serialized).not.toContain('configured-secret');
    expect(log).toHaveBeenCalledWith(
      'message_send_failed',
      { adapter: 'failing', source: 'unit', errorCategory: 'request_failed' },
      'ERROR',
    );
  });
});
