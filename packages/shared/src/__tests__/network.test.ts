import { describe, expect, it, vi } from 'vitest';
import {
  assertPublicHttpUrl,
  type DnsLookup,
  hostFromUrl,
  readResponseBytes,
  safeFetch,
  trustedHostsFromUrls,
} from '../network.js';
import { classifyError } from '../tool-errors.js';

const publicLookup: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('network', () => {
  it.each([
    'http://127.0.0.1/private',
    'http://0.0.0.0/private',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/private',
    'http://192.0.2.1/documentation',
    'http://198.51.100.1/documentation',
    'http://203.0.113.1/documentation',
    'http://[::1]/private',
    'http://[::c0a8:101]/ipv4-compatible-private',
    'http://[100::1]/discard-only',
    'http://[2001:2::1]/benchmarking',
    'http://[2001:db8::1]/documentation',
    'http://[3fff::1]/documentation',
    'http://[5f00::1]/segment-routing',
    'http://[fec0::1]/private',
    'http://[64:ff9b:1::a00:1]/private',
    'http://[64:ff9b::a9fe:a9fe]/latest/meta-data',
    'http://[2002:a9fe:a9fe::]/latest/meta-data',
    'http://[2002:a9fe::]/private',
    'http://[2002:5db8:d822::]/path',
    'http://[::ffff:127.0.0.1]/private',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'file:///etc/passwd',
  ])('rejects non-public destination %s', async (url) => {
    await expect(assertPublicHttpUrl(url, { lookup: publicLookup })).rejects.toThrow(
      /public HTTP/i,
    );
  });

  it('rejects a hostname when DNS returns a private address', async () => {
    const privateLookup: DnsLookup = async () => [{ address: '192.168.1.20', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://internal.example/path', { lookup: privateLookup }),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('rejects a hostname when DNS64 embeds a private IPv4 address', async () => {
    const privateNat64Lookup: DnsLookup = async () => [
      { address: '64:ff9b::a9fe:a9fe', family: 6 },
    ];
    await expect(
      assertPublicHttpUrl('https://internal.example/path', { lookup: privateNat64Lookup }),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('allows a public HTTP URL', async () => {
    await expect(
      assertPublicHttpUrl('https://example.com/path', { lookup: publicLookup }),
    ).resolves.toMatchObject({ hostname: 'example.com', protocol: 'https:' });
    await expect(
      assertPublicHttpUrl('http://[::ffff:93.184.216.34]/path', { lookup: publicLookup }),
    ).resolves.toMatchObject({ hostname: '[::ffff:5db8:d822]' });
    await expect(
      assertPublicHttpUrl('http://[64:ff9b::5db8:d822]/path', { lookup: publicLookup }),
    ).resolves.toMatchObject({ hostname: '[64:ff9b::5db8:d822]' });
    await expect(
      assertPublicHttpUrl('https://[2606:4700:4700::1111]/path', { lookup: publicLookup }),
    ).resolves.toMatchObject({ hostname: '[2606:4700:4700::1111]' });
    await expect(
      assertPublicHttpUrl('https://[2001:3::1]/path', { lookup: publicLookup }),
    ).resolves.toMatchObject({ hostname: '[2001:3::1]' });
  });

  it('does not let a wrapped global fetch bypass DNS validation', async () => {
    const originalFetch = globalThis.fetch;
    const wrappedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('unsafe'));
    globalThis.fetch = wrappedFetch;

    try {
      await expect(
        safeFetch(
          'https://does-not-resolve.invalid/private',
          {},
          {
            lookup: async () => {
              throw Object.assign(new Error('DNS unavailable'), { code: 'ENOTFOUND' });
            },
          },
        ),
      ).rejects.toMatchObject({ errorCategory: 'network_error' });
      expect(wrappedFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the host and resolved address when rejecting non-public DNS answers', async () => {
    const fakeIpLookup: DnsLookup = async () => [{ address: '198.18.1.86', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://gateway.internal.example/path', { lookup: fakeIpLookup }),
    ).rejects.toThrow(/gateway\.internal\.example.*198\.18\.1\.86/s);
  });

  it('reports an unresolvable host distinctly', async () => {
    const emptyLookup: DnsLookup = async () => [];
    await expect(
      assertPublicHttpUrl('https://gone.example/path', { lookup: emptyLookup }),
    ).rejects.toThrow(/could not be resolved/i);
  });

  it.each([
    'gateway.internal.example',
    '*.internal.example',
    'INTERNAL.example',
    ' gateway.internal.example ',
  ])('trusts %s past the public-IP check', async (trusted) => {
    const fakeIpLookup: DnsLookup = async () => [{ address: '198.18.1.86', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://gateway.internal.example/path', {
        lookup: fakeIpLookup,
        trustedHosts: [trusted],
      }),
    ).resolves.toMatchObject({ hostname: 'gateway.internal.example' });
  });

  it('trusts subdomains of a trusted host', async () => {
    const fakeIpLookup: DnsLookup = async () => [{ address: '198.18.1.86', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://cdn.internal.example/path', {
        lookup: fakeIpLookup,
        trustedHosts: ['internal.example'],
      }),
    ).resolves.toMatchObject({ hostname: 'cdn.internal.example' });
  });

  it('does not trust a mere suffix match', async () => {
    const fakeIpLookup: DnsLookup = async () => [{ address: '198.18.1.86', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://evil-internal.example/path', {
        lookup: fakeIpLookup,
        trustedHosts: ['internal.example'],
      }),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('matches bracketed IPv6-literal trusted hosts', async () => {
    // ULA literals fail the public-IP check unless trusted; hostFromUrl keeps
    // the brackets, so the pattern side must strip them too.
    await expect(assertPublicHttpUrl('http://[fd00::1]/')).rejects.toThrow(/public HTTP/i);
    await expect(
      assertPublicHttpUrl('http://[fd00::1]/', { trustedHosts: ['[fd00::1]'] }),
    ).resolves.toBeDefined();
  });

  it('still applies protocol and localhost rules to trusted hosts', async () => {
    await expect(
      assertPublicHttpUrl('ftp://internal.example/path', {
        lookup: publicLookup,
        trustedHosts: ['internal.example'],
      }),
    ).rejects.toThrow(/public HTTP/i);
    await expect(
      assertPublicHttpUrl('https://localhost/path', {
        lookup: publicLookup,
        trustedHosts: ['localhost'],
      }),
    ).rejects.toThrow(/public HTTP/i);
    await expect(
      assertPublicHttpUrl('https://user:pass@internal.example/path', {
        lookup: publicLookup,
        trustedHosts: ['internal.example'],
      }),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('still rejects a trusted host that cannot be resolved', async () => {
    const emptyLookup: DnsLookup = async () => [];
    await expect(
      assertPublicHttpUrl('https://internal.example/path', {
        lookup: emptyLookup,
        trustedHosts: ['internal.example'],
      }),
    ).rejects.toThrow(/could not be resolved/i);
  });

  it('cancels and rejects a response body that exceeds the byte ceiling', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readResponseBytes(response, 10)).rejects.toThrow(/size ceiling/i);
    expect(cancelled).toBe(true);
  });
});

describe('hostFromUrl', () => {
  it.each([
    ['https://credits.example.com/v1', 'credits.example.com'],
    ['http://internal.example:8080/api', 'internal.example'],
    ['https://[2001:3::1]/v1', '[2001:3::1]'],
  ])('extracts the hostname from %s', (input, expected) => {
    expect(hostFromUrl(input)).toBe(expected);
  });

  it.each([[undefined], [''], ['not a url'], ['http://']])('returns undefined for %j', (input) => {
    expect(hostFromUrl(input)).toBeUndefined();
  });
});

describe('trustedHostsFromUrls', () => {
  it('collects hosts from valid URLs and skips the rest', () => {
    expect(
      trustedHostsFromUrls(
        'https://credits.example.com/v1',
        undefined,
        'not a url',
        'http://internal.example:8080/api',
      ),
    ).toEqual(['credits.example.com', 'internal.example']);
  });

  it('returns an empty list when nothing parses', () => {
    expect(trustedHostsFromUrls(undefined, '')).toEqual([]);
  });
});

describe('DNS error preservation', () => {
  it('keeps transient DNS failures distinct from public-destination rejection', async () => {
    const error = await assertPublicHttpUrl('https://fixture.invalid', {
      lookup: async () => {
        throw Object.assign(new Error('secret-token'), { code: 'EAI_AGAIN' });
      },
    }).catch((error) => error);
    expect(classifyError(error).errorCategory).toBe('network_error');
    expect(error.message).not.toContain('must use a public');
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });
});
