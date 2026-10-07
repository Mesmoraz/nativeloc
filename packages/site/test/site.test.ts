import { listPlaceholders, validateTranslation } from '@nativeloc/core';
import { describe, expect, it } from 'vitest';
import { crawl, keyFor, readPage, robotsAllows, robotsRules, siteEntries, type CrawledPage } from '../src/index.js';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Get Food | Rainier Food Bank</title>
  <meta name="description" content="Free groceries for anyone who needs them. No ID required.">
  <script>var x = "not text";</script>
  <style>.a { content: "nope" }</style>
</head>
<body>
  <nav><ul>
    <li><a href="/get-help">Get help</a></li>
    <li><a href="/donate">Donate</a></li>
  </ul></nav>
  <main>
    <h1>Get food this week</h1>
    <p>Call <a href="tel:2065550100">our hotline</a> or visit us. <strong>No ID needed.</strong></p>
    <p>Open Monday<br>9 AM – 5 PM</p>
    <div class="card">Free produce every Tuesday <img src="a.png" alt="Volunteers handing out apples"></div>
    <p>Email us: help@example.org</p>
    <p>(206) 555-0100</p>
    <p class="notranslate">Rainier Food Bank</p>
    <p>Pick up at <span translate="no">Rainier Beach</span> today.</p>
    <a class="card" href="/hours"><h3>Hours</h3><p>See when we're open</p></a>
    <form><input type="search" placeholder="Search the site"><input type="submit" value="Search"></form>
    <div hidden>Old notice</div>
    <span aria-hidden="true">★</span>
  </main>
  <footer><p>© 2026 Rainier Food Bank</p></footer>
</body></html>`;

describe('readPage', () => {
  const page = readPage(PAGE, 'https://food.example/get-food');
  const sources = page.segments.map((s) => s.source);
  const find = (src: string) => page.segments.find((s) => s.source === src)!;

  it('finds the text a visitor reads, and nothing else', () => {
    expect(sources).toEqual([
      'Get Food | Rainier Food Bank',
      'Free groceries for anyone who needs them. No ID required.',
      'Get help',
      'Donate',
      'Get food this week',
      'Call {link1}our hotline{link1_end} or visit us. {bold1}No ID needed.{bold1_end}',
      'Open Monday{br1}9 AM – 5 PM',
      'Free produce every Tuesday {image1}',
      'Volunteers handing out apples',
      'Email us: help@example.org',
      'Pick up at {keep1} today.',
      'Hours',
      "See when we're open",
      'Search the site',
      'Search',
      '© 2026 Rainier Food Bank',
    ]);
    expect(page.title).toBe('Get Food | Rainier Food Bank');
    expect(page.lang).toBe('en');
  });

  it('describes each piece of text for translators', () => {
    expect(find('Get help').role).toBe('link (navigation menu)');
    expect(find('Get food this week').role).toBe('main heading');
    expect(find('Volunteers handing out apples').role).toBe('image description');
    expect(find('Search').role).toBe('button (form)');
    expect(find('© 2026 Rainier Food Bank').role).toBe('paragraph (page footer)');
  });

  it('turns inline markup into placeholders translators keep, with plain-language labels', () => {
    const s = find('Call {link1}our hotline{link1_end} or visit us. {bold1}No ID needed.{bold1_end}');
    expect(s.labels).toMatchObject({ link1: 'start of link', link1_end: 'end of link', bold1: 'start of bold text' });
    expect(listPlaceholders(s.source, s.labels).map((p) => p.label)).toEqual(['start of link', 'end of link', 'start of bold text', 'end of bold text']);
    const good = 'Llame a {link1}nuestra línea{link1_end} o visítenos. {bold1}No necesita identificación.{bold1_end}';
    expect(validateTranslation(s.source, good, { locale: 'es' }).filter((i) => i.level === 'error')).toEqual([]);
    expect(validateTranslation(s.source, 'Llame a nuestra línea.', { locale: 'es' }).some((i) => i.level === 'error')).toBe(true);
  });

  it('uses one pair of chips when formatting tags wrap each other', () => {
    const src = (html: string) => readPage(html, 'https://x.example').segments[0].source;
    expect(src('<p>Read our <a href="/a"><u>Community Agreement</u></a> first.</p>')).toBe('Read our {link1}Community Agreement{link1_end} first.');
    expect(src('<p>Read our <u><a href="/a">Community Agreement</a></u> first.</p>')).toBe('Read our {link1}Community Agreement{link1_end} first.');
    expect(src('<p>Read <b><i>this</i></b> first.</p>')).toBe('Read {bold1}this{bold1_end} first.');
  });

  it('keys text by content, so the same sentence anywhere is one string', () => {
    expect(find('Get help').key).toBe(keyFor('Get help'));
    const other = readPage('<p>Totally different <b>page</b></p><ul><li><a href="/x">Get help</a></li></ul>', 'https://food.example/other');
    expect(other.segments.find((s) => s.source === 'Get help')!.key).toBe(find('Get help').key);
  });

  it('escapes ICU syntax in page text', () => {
    const s = readPage("<p>Use code {SAVE} at checkout, it's free</p>", 'https://x.example').segments[0];
    expect(s.source).toBe("Use code '{'SAVE'}' at checkout, it's free");
    expect(listPlaceholders(s.source)).toEqual([]);
  });

  it('collects links for the crawler', () => {
    expect(page.links.map((l) => l.url)).toEqual(['https://food.example/get-help', 'https://food.example/donate', 'https://food.example/hours']);
  });
});

describe('crawl', () => {
  const site: Record<string, string> = {
    '/robots.txt': 'User-agent: *\nDisallow: /admin\n',
    '/': '<h1>Welcome</h1><a href="/blog/2026/05/gala">Gala recap</a><a href="/get-help">Get help</a><a href="/admin/x">Admin</a><a href="https://other.example/">Partner</a><a href="/flyer.pdf">Flyer</a><footer>Shared footer</footer>',
    '/get-help': '<h1>Get help</h1><a href="/hours?utm_source=x">Hours</a><footer>Shared footer</footer>',
    '/hours': '<h1>Hours</h1><p>Mon–Fri 9–5</p><footer>Shared footer</footer>',
    '/blog/2026/05/gala': '<h1>Gala recap</h1>',
  };
  const fakeFetch = (async (url: string) => {
    const path = new URL(url).pathname;
    const body = site[path];
    return new Response(body ?? 'not found', { status: body ? 200 : 404, headers: { 'content-type': path.endsWith('.txt') ? 'text/plain' : 'text/html' } });
  }) as typeof fetch;

  it('reads help pages before the blog, respects robots.txt and stays on the site', async () => {
    const r = await crawl('https://food.example/', { fetch: fakeFetch, delayMs: 0 });
    expect(r.pages.map((p) => p.path)).toEqual(['/', '/get-help', '/hours', '/blog/2026/05/gala']);
    expect(r.disallowed).toEqual(['https://food.example/admin/x']);
    expect(r.documents).toEqual(['https://food.example/flyer.pdf']);
  });

  it('reads a page once when several links redirect to it', async () => {
    const redirecting = (async (url: string) => {
      const path = new URL(url).pathname;
      const html = path === '/' ? '<a href="/old-help">Help</a><a href="/help">Help</a>' : '<h1>Help</h1>';
      const res = new Response(path === '/robots.txt' ? '' : html, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: path === '/old-help' ? 'https://food.example/help' : url });
      return res;
    }) as typeof fetch;
    const r = await crawl('https://food.example/', { fetch: redirecting, delayMs: 0 });
    expect(r.pages.map((p) => p.path)).toEqual(['/', '/help']);
  });

  it('stops at the page limit', async () => {
    const r = await crawl('https://food.example/', { fetch: fakeFetch, delayMs: 0, maxPages: 2 });
    expect(r.pages).toHaveLength(2);
  });

  it('builds one string per distinct text, in priority order, with where it appears', async () => {
    const { pages } = await crawl('https://food.example/', { fetch: fakeFetch, delayMs: 0 });
    const { entries, summary } = siteEntries(pages as CrawledPage[]);
    const footer = entries.find((e) => e.source === 'Shared footer')!;
    expect(footer.meta).toMatchObject({ pages: ['/', '/get-help', '/hours'] });
    expect(footer.description).toBe('Text (page footer). Website text on /, /get-help, /hours.');
    expect(entries.map((e) => e.source).indexOf('Hours')).toBeLessThan(entries.map((e) => e.source).indexOf('Gala recap', 3));
    expect(summary).toMatchObject({ pages: 4 });
    expect(summary.priorityWords).toBeGreaterThan(0);
  });
});

describe('robots.txt', () => {
  it('uses the group naming us, else the * group', () => {
    const txt = 'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: GPTBot\nUser-agent: *\nDisallow: /private\nDisallow:\n';
    expect(robotsRules(txt)).toEqual([{ allow: false, pattern: '/private' }]);
    expect(robotsRules(txt + '\nUser-agent: NativeLoc\nDisallow: /only-us\n')).toEqual([{ allow: false, pattern: '/only-us' }]);
  });

  it('matches wildcards and anchors like search engines do (Squarespace defaults)', () => {
    const rules = robotsRules('User-agent: AI2Bot\nUser-agent: *\nDisallow: /api/\nAllow: /api/ui-extensions/\nDisallow:/*?author=*\nDisallow: /account$\n');
    expect(robotsAllows(rules, '/')).toBe(true);
    expect(robotsAllows(rules, '/get-food')).toBe(true);
    expect(robotsAllows(rules, '/blog?author=5')).toBe(false);
    expect(robotsAllows(rules, '/api/x')).toBe(false);
    expect(robotsAllows(rules, '/api/ui-extensions/y')).toBe(true);
    expect(robotsAllows(rules, '/account')).toBe(false);
    expect(robotsAllows(rules, '/accounting')).toBe(true);
  });
});
