import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockedUrl, checkUrl, guardedFetch, isPublicAddress, netSettings } from '../src/posting/netguard.js';

/** A local website for the crawler. `pages` maps a path to [status, headers, body]. */
async function site(pages: Record<string, [number, Record<string, string>, string]>) {
  const server = createServer((req, res) => {
    const page = pages[req.url ?? '/'];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(page[0], page[1]).end(page[2]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

beforeAll(() => {
  netSettings.hostDelayMs = 0;
});

describe('network guard', () => {
  it('knows public from private addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'nonsense',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('refuses addresses that would reach inside the network', async () => {
    for (const url of [
      'http://127.0.0.1/', 'http://localhost/', 'http://LOCALHOST./admin', 'http://foo.localhost/', 'http://printer.local/',
      'http://10.0.0.5/', 'http://192.168.0.1/router', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://intranet/',
      'file:///etc/passwd', 'ftp://example.org/', 'gopher://example.org/', 'javascript:alert(1)',
      'http://user:pass@example.org/', 'http://example.org:8080/', 'http://example.org:22/', 'not a url',
    ])
      await expect(checkUrl(url), url).rejects.toBeInstanceOf(BlockedUrl);
  });

  it('checks every redirect hop, so a page cannot bounce the crawler inside', async () => {
    const inside = await site({ '/secret': [200, { 'content-type': 'text/html' }, '<p>internal</p>'] });
    const outside = await site({
      '/': [302, { location: `${inside.origin}/secret` }, ''],
      '/meta': [301, { location: 'http://169.254.169.254/latest/meta-data/' }, ''],
      '/ok': [302, { location: '/landing' }, ''],
      '/landing': [200, { 'content-type': 'text/html' }, '<p>hello</p>'],
      '/big': [200, { 'content-type': 'text/html' }, 'x'.repeat(4096)],
    });
    servers.push(inside.server, outside.server);
    // Only the "outside" server is allowed (it stands in for a public site); the other local server is not.
    netSettings.allowHosts = new Set([`127.0.0.1:${outside.port}`]);
    await expect(guardedFetch(`${inside.origin}/secret`)).rejects.toBeInstanceOf(BlockedUrl);
    await expect(guardedFetch(`${outside.origin}/`)).rejects.toBeInstanceOf(BlockedUrl);
    await expect(guardedFetch(`${outside.origin}/meta`)).rejects.toBeInstanceOf(BlockedUrl);
    const res = await guardedFetch(`${outside.origin}/ok`, { headers: { 'user-agent': 'NativeLocBot/test' } });
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${outside.origin}/landing`);
    expect(await res.text()).toBe('<p>hello</p>');
    const max = netSettings.maxBytes;
    netSettings.maxBytes = 1024;
    await expect(guardedFetch(`${outside.origin}/big`)).rejects.toThrow(/larger than/);
    netSettings.maxBytes = max;
    netSettings.allowHosts = new Set();
  });
});
