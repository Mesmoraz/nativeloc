import { describe, expect, it } from 'vitest';
import { readPage, translatePage } from '../src/index.js';

const URL_ = 'https://food.example.org/get-food';
const PAGE = `<!doctype html>
<html lang="en"><head><title>Get food</title><meta name="description" content="Free groceries every week.">
<link rel="stylesheet" href="/style.css"></head>
<body>
  <nav><a href="/">Home</a> <a href="/hours">Hours</a></nav>
  <h1>Get food</h1>
  <p>Call <a href="tel:555" class="phone">our hotline</a> or <strong>visit</strong> us.<br>No ID needed.</p>
  <p>See the <a href="https://other.example.com/map">map</a> <img src="/pin.png" alt="Map pin"> today.</p>
  <p>Not translated yet.</p>
  <p translate="no">Food Bank Inc.</p>
</body></html>`;

/** Translations keyed the way the crawler keys them, written by hand per source text. */
function translationsFor(es: Record<string, string>) {
  const keys = new Map(readPage(PAGE, URL_).segments.map((s) => [s.source, s.key]));
  return new Map(Object.entries(es).map(([source, text]) => {
    const key = keys.get(source);
    if (!key) throw new Error(`No segment for "${source}". Have: ${[...keys.keys()].join(' | ')}`);
    return [key, text];
  }));
}

describe('translatePage', () => {
  it('swaps translated text and keeps the markup inside sentences', () => {
    const translations = translationsFor({
      'Get food': 'Obtener comida',
      'Call {link1}our hotline{link1_end} or {bold1}visit{bold1_end} us.{br1}No ID needed.': '{bold1}Visítenos{bold1_end} o llame a {link1}nuestra línea{link1_end}.{br1}No se necesita identificación.',
      'Free groceries every week.': 'Comida gratis cada semana.',
      'Map pin': 'Marcador',
      'See the {link1}map{link1_end} {image1} today.': 'Vea el {link1}mapa{link1_end} {image1} hoy.',
    });
    const out = translatePage(PAGE, { url: URL_, locale: 'es', translations });
    expect(out.html).toContain('<title>Obtener comida</title>');
    expect(out.html).toContain('<h1>Obtener comida</h1>');
    expect(out.html).toContain('<p><strong>Visítenos</strong> o llame a <a href="tel:555" class="phone">nuestra línea</a>.<br>No se necesita identificación.</p>');
    expect(out.html).toContain('content="Comida gratis cada semana."');
    // The copied image carries the translated description.
    expect(out.html).toContain('<img src="/pin.png" alt="Marcador">');
    expect(out.html).toContain('<p>Not translated yet.</p>');
    expect(out.html).toContain('<p translate="no">Food Bank Inc.</p>');
    expect(out.html).toContain('<html lang="es" dir="ltr">');
    expect(out.translated).toBe(5);
    expect(out.strings).toBeGreaterThan(5);
  });

  it('keeps the original when a translation does not fit the sentence', () => {
    const translations = translationsFor({
      // Closing chip without its opening one, and an unknown placeholder.
      'Call {link1}our hotline{link1_end} or {bold1}visit{bold1_end} us.{br1}No ID needed.': 'Llame {link1_end} ahora',
      'See the {link1}map{link1_end} {image1} today.': 'Vea {other1}',
    });
    const out = translatePage(PAGE, { url: URL_, locale: 'es', translations });
    expect(out.html).toContain('Call <a href="tel:555" class="phone">our hotline</a> or');
    expect(out.html).toContain('See the <a href="https://other.example.com/map">map</a>');
    expect(out.translated).toBe(0);
  });

  it('points page addresses at the original site and links where the caller wants', () => {
    const out = translatePage(PAGE, {
      url: URL_,
      locale: 'so',
      translations: new Map(),
      linkFor: (u) => (u.hostname === 'food.example.org' ? `https://preview.test/p/x/so${u.pathname}` : null),
      head: '<meta name="robots" content="noindex">',
      banner: '<div id="nl-banner">Preview</div>',
    });
    expect(out.html).toMatch(/<head><base href="https:\/\/food\.example\.org\/get-food"><meta name="robots" content="noindex"><title>/);
    expect(out.html).toContain('<a href="https://preview.test/p/x/so/hours">Hours</a>');
    expect(out.html).toContain('<a href="https://other.example.com/map">');
    expect(out.html).toContain('href="tel:555"');
    expect(out.html).toMatch(/<body><div id="nl-banner">Preview<\/div>/);
  });

  it('marks right-to-left languages and resolves an existing <base>', () => {
    const page = '<html><head><base href="/site/"></head><body><a href="about">About</a></body></html>';
    const out = translatePage(page, { url: 'https://x.example/a/b', locale: 'ar', translations: new Map(), linkFor: (u) => `/proxy${u.pathname}` });
    expect(out.html).toContain('dir="rtl"');
    expect(out.html).toContain('<base href="https://x.example/site/">');
    expect(out.html).toContain('<a href="/proxy/site/about">');
  });
});
