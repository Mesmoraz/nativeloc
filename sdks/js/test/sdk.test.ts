import { describe, expect, it } from 'vitest';
import { memoryStorage, NativeLoc } from '../src/index.js';

const manifest = {
  version: 3,
  sourceLocale: 'en',
  locales: {
    en: { sha256: 'aaa', url: '/b/tok/en.json', completeness: 1 },
    ru: { sha256: 'bbb', url: '/b/tok/ru.json', completeness: 0.5 },
  },
};
const bundles: Record<string, Record<string, string>> = {
  '/b/tok/en.json': { hello: 'Hello {name}!', items: '{count, plural, one {# item} other {# items}}', only_en: 'English only' },
  '/b/tok/ru.json': { hello: 'Привет, {name}!', items: '{count, plural, one {# товар} few {# товара} many {# товаров} other {# товара}}' },
};

function fakeServer() {
  const calls: string[] = [];
  let online = true;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (!online) throw new TypeError('network down');
    if (url.pathname.endsWith('manifest.json')) {
      const etag = '"m3"';
      if ((init?.headers as Record<string, string> | undefined)?.['if-none-match'] === etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(manifest), { headers: { etag } });
    }
    return new Response(JSON.stringify(bundles[url.pathname]));
  }) as typeof fetch;
  return { fetchImpl, calls, setOnline: (v: boolean) => (online = v) };
}

describe('NativeLoc JS SDK', () => {
  it('downloads, formats plurals for the locale, and falls back to the source', async () => {
    const s = fakeServer();
    const loc = await new NativeLoc({ baseUrl: 'http://x', bundleToken: 'tok', locale: 'ru', fetch: s.fetchImpl }).init();
    expect(loc.t('hello', { name: 'Олег' })).toBe('Привет, Олег!');
    expect(loc.t('items', { count: 3 })).toBe('3 товара');
    expect(loc.t('items', { count: 5 })).toBe('5 товаров');
    expect(loc.t('only_en')).toBe('English only');
    expect(loc.t('missing.key')).toBe('missing.key');
  });

  it('uses ETags so unchanged checks are cheap', async () => {
    const s = fakeServer();
    const loc = await new NativeLoc({ baseUrl: 'http://x', bundleToken: 'tok', locale: 'ru', fetch: s.fetchImpl }).init();
    s.calls.length = 0;
    expect(await loc.refresh()).toBe(false);
    expect(s.calls).toEqual(['/b/tok/manifest.json']);
  });

  it('works offline from cache, then from bundled fallback', async () => {
    const storage = memoryStorage();
    const s = fakeServer();
    await new NativeLoc({ baseUrl: 'http://x', bundleToken: 'tok', locale: 'ru', fetch: s.fetchImpl, storage }).init();
    s.setOnline(false);
    const cached = await new NativeLoc({ baseUrl: 'http://x', bundleToken: 'tok', locale: 'ru', fetch: s.fetchImpl, storage }).init();
    expect(cached.t('hello', { name: 'A' })).toBe('Привет, A!');

    const fresh = await new NativeLoc({ baseUrl: 'http://x', bundleToken: 'tok', locale: 'ru', fetch: s.fetchImpl, fallback: { en: { hello: 'Hi {name}' } } }).init();
    expect(fresh.t('hello', { name: 'A' })).toBe('Hi A');
  });
});
