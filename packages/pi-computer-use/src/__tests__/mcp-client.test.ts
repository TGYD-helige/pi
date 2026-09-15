import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CuaDriverClient,
  resolveBundledTarget,
  resolveDriverLayout,
  resolveUnixSocketPath,
  SanitizingJsonSchemaValidator,
  sanitizeSchemaFormats,
  waitForDaemonStatus,
} from '../mcp-client.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: () => ({}),
}));

describe('CuaDriverClient', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-universal'],
    ['darwin', 'x64', 'darwin-universal'],
    ['linux', 'arm64', 'linux-arm64'],
    ['linux', 'x64', 'linux-x64'],
    ['win32', 'arm64', 'win32-arm64'],
    ['win32', 'x64', 'win32-x64'],
  ])('resolves %s/%s to %s', (platform, arch, expected) => {
    expect(resolveBundledTarget(platform, arch)).toBe(expected);
  });

  it('uses the bundled Rust app identity on macOS', () => {
    expect(resolveDriverLayout({ mode: 'bundled' }, '/package', 'darwin', 'arm64')).toEqual({
      appPath: '/package/bin/darwin-universal/CuaDriver.app',
      binaryPath: '/package/bin/darwin-universal/CuaDriver.app/Contents/MacOS/cua-driver',
      embedded: false,
    });
  });

  it('uses the matching platform package on Linux and Windows', () => {
    expect(resolveDriverLayout({ mode: 'bundled' }, '/linux-package', 'linux', 'x64')).toEqual({
      binaryPath: '/linux-package/bin/linux-x64/cua-driver',
      embedded: false,
    });
    expect(resolveDriverLayout({ mode: 'bundled' }, '/windows-package', 'win32', 'arm64')).toEqual({
      binaryPath: '/windows-package/bin/win32-arm64/cua-driver.exe',
      embedded: false,
    });
  });

  it('uses embedded mode for a custom macOS binary', () => {
    expect(
      resolveDriverLayout(
        { mode: 'path', binaryPath: '/opt/cua-driver' },
        '/package',
        'darwin',
        'arm64',
      ),
    ).toEqual({ binaryPath: '/opt/cua-driver', embedded: true });
  });

  it('falls back to /tmp when the configured temp path exceeds Unix socket limits', () => {
    const longTempDir = `/var/folders/${'nested/'.repeat(14)}T`;

    expect(resolveUnixSocketPath(longTempDir, '123-deadbeef')).toBe(
      '/tmp/pi-cua-123-deadbeef.sock',
    );
    expect(Buffer.byteLength(resolveUnixSocketPath('/tmp', '123-deadbeef'))).toBeLessThan(91);
  });

  it('waits until the Windows daemon responds before opening the MCP proxy', async () => {
    const checkStatus = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('named pipe is not ready'))
      .mockRejectedValueOnce(new Error('named pipe is not ready'))
      .mockResolvedValue(undefined);

    await waitForDaemonStatus('cua-driver.exe', '\\\\.\\pipe\\pi-cua-test', undefined, checkStatus);

    expect(checkStatus).toHaveBeenCalledTimes(3);
  });

  it('stops Windows daemon status retries when the session is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('session stopped');
    const checkStatus = vi.fn(async () => {
      controller.abort(reason);
      throw new Error('named pipe is not ready');
    });

    await expect(
      waitForDaemonStatus(
        'cua-driver.exe',
        '\\\\.\\pipe\\pi-cua-test',
        controller.signal,
        checkStatus,
      ),
    ).rejects.toBe(reason);
    expect(checkStatus).toHaveBeenCalledOnce();
  });

  it('does not retry permanent Windows daemon status errors', async () => {
    const cause = Object.assign(new Error('spawn failed'), { code: 'EACCES' });
    const checkStatus = vi.fn().mockRejectedValue(cause);

    await expect(
      waitForDaemonStatus('cua-driver.exe', '\\\\.\\pipe\\pi-cua-test', undefined, checkStatus),
    ).rejects.toMatchObject({
      message: 'Cua Driver status check failed (EACCES).',
      cause,
    });
    expect(checkStatus).toHaveBeenCalledOnce();
  });

  it('constructs the MCP Client with the sanitizing schema validator', async () => {
    // biome-ignore lint/complexity/useArrowFunction: arrow functions are not constructible; the mock must survive `new Client(...)`.
    vi.mocked(Client).mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Client;
    });
    const client = new CuaDriverClient({ mode: 'path', binaryPath: '/opt/cua-driver' });
    // Isolate the wiring from the daemon process and the real binary.
    const internals = client as unknown as {
      ensureExecutable: () => void;
      ensureDaemon: () => Promise<string>;
    };
    internals.ensureExecutable = () => {};
    internals.ensureDaemon = () => Promise.resolve('/tmp/pi-cua-test.sock');

    await client.connect();

    const options = vi.mocked(Client).mock.calls[0]?.[1];
    expect(options?.jsonSchemaValidator).toBeInstanceOf(SanitizingJsonSchemaValidator);
  });
});

describe('sanitizeSchemaFormats', () => {
  it.each([
    ['int8', { minimum: -128, maximum: 127 }],
    ['int16', { minimum: -32_768, maximum: 32_767 }],
    ['int32', { minimum: -2_147_483_648, maximum: 2_147_483_647 }],
    ['int64', {}],
    ['uint8', { minimum: 0, maximum: 255 }],
    ['uint16', { minimum: 0, maximum: 65_535 }],
    ['uint32', { minimum: 0, maximum: 4_294_967_295 }],
    ['uint64', { minimum: 0 }],
  ])('rewrites %s to its standard integer constraints', (format, bounds) => {
    expect(sanitizeSchemaFormats({ type: 'integer', format })).toEqual({
      type: 'integer',
      ...bounds,
    });
  });

  it('rewrites nested schemas in the verify_state shape', () => {
    const schema = {
      type: 'object',
      properties: {
        elapsed_ms: { type: 'integer', format: 'uint64' },
        predicates: {
          type: 'array',
          items: { type: 'object', properties: { index: { format: 'uint64' } } },
        },
        delivery: { type: 'object', properties: { delivered_count: { format: 'uint32' } } },
      },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.properties.elapsed_ms).toEqual({ type: 'integer', minimum: 0 });
    expect(sanitized.properties.predicates.items.properties.index).toEqual({
      type: 'integer',
      minimum: 0,
    });
    expect(sanitized.properties.delivery.properties.delivered_count).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 4_294_967_295,
    });
  });

  it('leaves standard formats untouched', () => {
    const schema = { type: 'string', format: 'date-time' };
    expect(sanitizeSchemaFormats(schema)).toEqual(schema);
  });

  it('does not override existing bounds', () => {
    expect(sanitizeSchemaFormats({ format: 'uint32', minimum: 1, maximum: 10 })).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
  });

  it('does not mutate the input schema', () => {
    const schema = { properties: { samples: { format: 'uint64' } } };
    sanitizeSchemaFormats(schema);
    expect(schema).toEqual({ properties: { samples: { format: 'uint64' } } });
  });

  it('sanitizes properties named like schema keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        default: { type: 'integer', format: 'uint64' },
        enum: { type: 'integer', format: 'uint32' },
      },
      $defs: { const: { format: 'uint64' } },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.properties.default).toEqual({ type: 'integer', minimum: 0 });
    expect(sanitized.properties.enum).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 4_294_967_295,
    });
    expect(sanitized.$defs.const).toEqual({ type: 'integer', minimum: 0 });
  });

  it('still leaves keyword-position instance data untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer', format: 'uint64', default: { format: 'uint64' } },
      },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.properties.count).toEqual({
      type: 'integer',
      minimum: 0,
      default: { format: 'uint64' },
    });
  });

  it('leaves integer formats on non-integer types untouched', () => {
    const schema = { type: 'string', format: 'uint32' };
    expect(sanitizeSchemaFormats(schema)).toEqual(schema);
  });

  it('ignores format values matching Object.prototype keys', () => {
    const schema = { type: 'integer', format: 'constructor' };
    expect(sanitizeSchemaFormats(schema)).toEqual(schema);
  });

  it('keeps an own __proto__ key instead of replacing the copy prototype', () => {
    // JSON.parse creates an own __proto__ property; a plain-object copy would
    // hit the inherited setter, dropping the key and swapping the prototype.
    const schema = JSON.parse(
      '{"properties":{"__proto__":{"type":"integer","format":"uint64"}},"format":"uint64"}',
    );

    const sanitized = sanitizeSchemaFormats(schema);
    expect(Object.keys(sanitized.properties)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(sanitized.properties)).toBeNull();
    expect(sanitized.properties.__proto__).toEqual({ type: 'integer', minimum: 0 });
    expect(sanitized.minimum).toBe(0);
  });

  it('traverses combinator and applicator keywords', () => {
    const schema = {
      allOf: [{ type: 'integer', format: 'uint64' }],
      additionalProperties: { type: 'integer', format: 'uint32' },
      patternProperties: { '^x-': { format: 'uint64' } },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.allOf[0]).toEqual({ type: 'integer', minimum: 0 });
    expect(sanitized.additionalProperties).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 4_294_967_295,
    });
    expect(sanitized.patternProperties['^x-']).toEqual({ type: 'integer', minimum: 0 });
  });
});

describe('SanitizingJsonSchemaValidator', () => {
  it('compiles non-standard formats without ajv warnings and keeps validating', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const validate = new SanitizingJsonSchemaValidator().getValidator({
        type: 'object',
        properties: { elapsed_ms: { type: 'integer', format: 'uint64' } },
      });

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(validate({ elapsed_ms: 5 }).valid).toBe(true);
      expect(validate({ elapsed_ms: -1 }).valid).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
