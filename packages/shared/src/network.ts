import { lookup as nodeLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: DnsLookup = async (hostname) =>
  nodeLookup(hostname, { all: true, verbatim: true });
const wellKnownNat64Addresses = new BlockList();
wellKnownNat64Addresses.addSubnet('64:ff9b::', 96, 'ipv6');
const globalIpv6Addresses = new BlockList();
globalIpv6Addresses.addSubnet('2000::', 3, 'ipv6');
const nonGlobalIpv6Addresses = new BlockList();
nonGlobalIpv6Addresses.addSubnet('2001::', 23, 'ipv6');
nonGlobalIpv6Addresses.addSubnet('2001:db8::', 32, 'ipv6');
nonGlobalIpv6Addresses.addSubnet('2002::', 16, 'ipv6');
nonGlobalIpv6Addresses.addSubnet('3fff::', 20, 'ipv6');
// IANA marks 2001::/23 non-global except for these more-specific allocations.
const globalIetfProtocolAddresses = new BlockList();
globalIetfProtocolAddresses.addAddress('2001:1::1', 'ipv6');
globalIetfProtocolAddresses.addAddress('2001:1::2', 'ipv6');
globalIetfProtocolAddresses.addAddress('2001:1::3', 'ipv6');
globalIetfProtocolAddresses.addSubnet('2001:3::', 32, 'ipv6');
globalIetfProtocolAddresses.addSubnet('2001:4:112::', 48, 'ipv6');
globalIetfProtocolAddresses.addSubnet('2001:20::', 28, 'ipv6');
globalIetfProtocolAddresses.addSubnet('2001:30::', 28, 'ipv6');

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function mappedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return undefined;
  const value = Number.parseInt(hex[1]!, 16) * 65_536 + Number.parseInt(hex[2]!, 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function nat64Ipv4(address: string): string | undefined {
  if (!wellKnownNat64Addresses.check(address, 'ipv6')) return undefined;
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const hex = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!hex) return undefined;
  const value = Number.parseInt(hex[1]!, 16) * 65_536 + Number.parseInt(hex[2]!, 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;
  const embeddedIpv4 = mappedIpv4(normalized) ?? nat64Ipv4(normalized);
  if (embeddedIpv4) return isPublicIpv4(embeddedIpv4);
  if (!globalIpv6Addresses.check(normalized, 'ipv6')) return false;
  return (
    globalIetfProtocolAddresses.check(normalized, 'ipv6') ||
    !nonGlobalIpv6Addresses.check(normalized, 'ipv6')
  );
}

/**
 * Parse an outbound URL once using Node's WHATWG parser and require every DNS
 * answer to be globally routable. Call this again for every redirect target.
 */
export async function resolvePublicHttpUrl(
  value: string | URL,
  lookup: DnsLookup = defaultLookup,
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error('Outbound URL must use a public HTTP(S) destination.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost')
  ) {
    throw new Error('Outbound URL must use a public HTTP(S) destination.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('Outbound URL must use a public HTTP(S) destination.');
  }
  return { url, addresses };
}

export async function assertPublicHttpUrl(
  value: string | URL,
  lookup: DnsLookup = defaultLookup,
): Promise<URL> {
  return (await resolvePublicHttpUrl(value, lookup)).url;
}

export async function safeFetch(
  value: string | URL,
  init: RequestInit = {},
  options: {
    lookup?: DnsLookup;
    maxRedirects?: number;
  } = {},
): Promise<Response> {
  const lookup = options.lookup ?? defaultLookup;
  const maxRedirects = options.maxRedirects ?? 5;
  let resolved = await resolvePublicHttpUrl(value, lookup);

  for (let redirects = 0; ; redirects++) {
    const response = await pinnedFetch(resolved.url, resolved.addresses[0]!, init);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects >= maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Outbound request exceeded the redirect limit.');
    }
    const next = new URL(location, resolved.url);
    await response.body?.cancel().catch(() => {});
    resolved = await resolvePublicHttpUrl(next, lookup);
  }
}

async function pinnedFetch(
  url: URL,
  target: { address: string; family: number },
  init: RequestInit,
): Promise<Response> {
  const method = init.method?.toUpperCase() ?? 'GET';
  if ((method === 'GET' || method === 'HEAD') && init.body) {
    throw new Error(`${method} outbound requests cannot include a body.`);
  }
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body !== 'string' &&
    !(init.body instanceof Uint8Array)
  ) {
    throw new Error('Safe outbound fetch requires a replayable string or byte body.');
  }

  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers,
        signal: init.signal ?? undefined,
        family: target.family,
        lookup(_hostname, _options, callback) {
          callback(null, target.address, target.family);
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const body =
          method === 'HEAD' || incoming.statusCode === 204 || incoming.statusCode === 304
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(init.body ?? undefined);
  });
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Remote response exceeds the size ceiling.');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Remote response exceeds the size ceiling.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
