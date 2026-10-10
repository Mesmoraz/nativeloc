import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Fetching on a requester's behalf without letting them probe our network. Every request the crawler makes
 * (robots.txt, pages, redirects) goes through guardedFetch:
 *   - http and https only, no user:password@ in the URL, default ports only;
 *   - the host must resolve only to public addresses, checked again at connect time (so a DNS answer that changes
 *     between the check and the connection can't point us inside);
 *   - redirects are followed one hop at a time, each checked the same way;
 *   - a timeout, a size cap, and a pause between requests to the same host.
 */
export const netSettings = {
  /** Pause between two requests to the same host. */
  hostDelayMs: 1000,
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  /** "host:port" pairs allowed even though they are private (tests run a local server). Empty in production. */
  allowHosts: new Set<string>(),
};

export class BlockedUrl extends Error {}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can reach IPv4 inside
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** Whether an IP address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(ip);
  if (!v) return false;
  if (v === 6) {
    // IPv4-mapped (::ffff:10.0.0.1, or its hex form) and IPv4-compatible addresses: check the IPv4 inside.
    const mapped = /^(?:0*:)*(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPublicAddress(mapped[1]);
    const hex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      return isPublicAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

const hostPort = (u: URL) => `${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
const allowed = (u: URL) => netSettings.allowHosts.has(hostPort(u));

const resolveAll = (host: string) =>
  new Promise<LookupAddress[]>((resolve, reject) => dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/**
 * Check a URL before fetching it. Returns it parsed; throws BlockedUrl with a sentence for the requester.
 * Resolves the host name, so a name that points at a private address is refused here too.
 */
export async function checkUrl(input: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new BlockedUrl('That is not a web address. Use one like https://example.org/help.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrl('Only http:// and https:// web addresses can be read.');
  if (url.username || url.password) throw new BlockedUrl('Web addresses with a user name or password in them can’t be read.');
  if (allowed(url)) return url;
  if (url.port && url.port !== '80' && url.port !== '443') throw new BlockedUrl('Only websites on the standard ports (80 and 443) can be read.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedUrl('That address is on a private network. Only public websites can be read.');
    return url;
  }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host)) {
    throw new BlockedUrl('That address is on a private network. Only public websites can be read.');
  }
  let addrs: LookupAddress[];
  try {
    addrs = await resolveAll(host);
  } catch {
    throw new BlockedUrl(`Couldn’t find the website ${host}. Check the address.`);
  }
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new BlockedUrl('That address is on a private network. Only public websites can be read.');
  return url;
}

/** DNS lookup for the actual connection: refuses private answers, so the connection can't land somewhere checkUrl didn't see. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: (options as { family?: number }).family ?? 0 }, (err, addrs) => {
    if (err) return callback(err, '', 0);
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad || !addrs.length) return callback(Object.assign(new BlockedUrl(`${hostname} points at a private address.`), { code: 'EBLOCKED' }), '', 0);
    if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addrs);
    else callback(null, addrs[0].address, addrs[0].family);
  });
};

/** Requests to one host are spaced at least hostDelayMs apart, across every crawl in this process. */
const nextSlot = new Map<string, number>();
async function waitForHost(host: string) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + netSettings.hostDelayMs);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

function request(url: URL, headers: Record<string, string>): Promise<RawResponse> {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      url,
      { headers: { ...headers, 'accept-encoding': 'identity' }, timeout: netSettings.timeoutMs, ...(allowed(url) ? {} : { lookup: guardedLookup }) },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > netSettings.maxBytes) {
            reject(new Error(`The page is larger than ${Math.round(netSettings.maxBytes / 1024)} KB, too large to read.`));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          resolve({ status: res.statusCode ?? 500, headers: h, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The website took too long to answer.')));
    req.on('error', reject);
  });
}

/**
 * A fetch for the crawler (packages/site's crawl takes one). GET only. Follows redirects itself, checking every hop.
 * The returned Response's `url` is where the last hop landed.
 */
export async function guardedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  let url = await checkUrl(input instanceof Request ? input.url : input);
  for (let hop = 0; ; hop++) {
    await waitForHost(url.host);
    const res = await request(url, headers);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= netSettings.maxRedirects) throw new Error('Too many redirects.');
      url = await checkUrl(new URL(location, url));
      continue;
    }
    const status = res.status < 200 || res.status > 599 ? 502 : res.status;
    const out = new Response([101, 204, 205, 304].includes(status) ? null : new Uint8Array(res.body), { status, headers: res.headers });
    Object.defineProperty(out, 'url', { value: url.href });
    return out;
  }
}
