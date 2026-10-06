import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  androidAdapter,
  escapeIcu,
  fromEditorModel,
  jsonAdapter,
  jsonNestedAdapter,
  listPlaceholders,
  parseMessage,
  pluralCategories,
  pluralExamples,
  poAdapter,
  targetTemplate,
  toEditorModel,
  validateTranslation,
} from '../src/index.js';

const examples = join(__dirname, '../../../examples');
const read = (p: string) => readFileSync(join(examples, p), 'utf8');

describe('plurals', () => {
  it('lists CLDR categories in order', () => {
    expect(pluralCategories('en')).toEqual(['one', 'other']);
    expect(pluralCategories('ru')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCategories('ja')).toEqual(['other']);
    expect(pluralCategories('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
  });
  it('gives example numbers per category', () => {
    expect(pluralExamples('ru').few).toEqual([2, 3, 4]);
  });
});

describe('editor model', () => {
  it('turns plurals into full sentences per form and back', () => {
    const src = 'You have {count, plural, one {# file} other {# files}} in {dir}.';
    const m = toEditorModel(src);
    expect(m).toEqual({ kind: 'plural', arg: 'count', ordinal: false, forms: { one: 'You have # file in {dir}.', other: 'You have # files in {dir}.' } });
    expect(parseMessage(fromEditorModel(m)).ok).toBe(true);
  });
  it('builds target templates with the target language categories', () => {
    const t = targetTemplate('{n, plural, =0 {None} one {# item} other {# items}}', null, 'pl');
    expect(t.kind === 'plural' && Object.keys(t.forms)).toEqual(['=0', 'one', 'few', 'many', 'other']);
  });
  it('lists placeholder chips', () => {
    expect(listPlaceholders('{count, plural, one {# item for {name}} other {# items for {name}}}')).toEqual([
      { token: '#', label: 'number' },
      { token: '{name}', label: 'name' },
    ]);
  });
});

describe('validation', () => {
  it('flags missing and unknown placeholders in plain language', () => {
    const issues = validateTranslation('Hello {name}', 'Hola {nombre}', { locale: 'es' });
    expect(issues.map((i) => i.code)).toEqual(['missing-placeholder', 'unknown-placeholder']);
  });
  it('flags syntax errors and too-long text', () => {
    expect(validateTranslation('Hi {name}', 'Hola {name', { locale: 'es' })[0].code).toBe('syntax');
    expect(validateTranslation('Checkout', 'Finalizar la compra', { locale: 'es', maxLength: 14 })[0].code).toBe('too-long');
  });
  it('warns about missing plural forms for the target language', () => {
    const issues = validateTranslation('{n, plural, one {# file} other {# files}}', '{n, plural, one {# plik} other {# pliki}}', { locale: 'pl' });
    expect(issues[0]).toMatchObject({ code: 'plural-missing', level: 'warning' });
  });
  it('accepts a correct translation', () => {
    expect(validateTranslation('Welcome back, {arg1}!', '¡Bienvenido de nuevo, {arg1}!', { locale: 'es' })).toEqual([]);
  });
});

describe('ICU escaping', () => {
  it('keeps apostrophes readable and escapes braces', () => {
    expect(escapeIcu("Don't")).toBe("Don't");
    expect(escapeIcu('a {b}')).toBe("a '{'b'}'");
  });
});

describe('android adapter', () => {
  const { entries } = androidAdapter.parse(read('android/res/values/strings.xml'));
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));

  it('parses strings, comments, max length, plurals and arrays', () => {
    expect(byKey.app_name).toBeUndefined();
    expect(byKey.welcome_title).toMatchObject({ source: 'Welcome! Tap to start', description: 'Big greeting on the idle/attract screen.', maxLength: 28 });
    expect(byKey.welcome_back.source).toBe('Welcome back, {arg1}!');
    expect(byKey.cart_items.source).toBe('{arg1, plural, one {# item in your cart} other {# items in your cart}}');
    expect(byKey['departments[2]'].source).toBe('Dairy & Eggs');
    expect(byKey.discount.source).toBe('Save {arg1, number}% today with "FRESH"');
  });

  it('round-trips through export', () => {
    const xml = androidAdapter.serialize(entries.map((e) => ({ ...e, text: e.source })), 'en');
    expect(xml).toContain('<string name="welcome_back">Welcome back, %1$s!</string>');
    expect(xml).toContain('<item quantity="one">%1$d item in your cart</item>');
    expect(xml).toContain('<string name="discount">Save %1$d%% today with \\"FRESH\\"</string>');
    const again = androidAdapter.parse(xml).entries;
    const pairs = (list: typeof entries) => list.map((e) => [e.key, e.source]).sort();
    expect(pairs(again)).toEqual(pairs(entries));
  });

  it('exports target plurals with the target categories', () => {
    const xml = androidAdapter.serialize(
      [{ key: 'cart_items', source: byKey.cart_items.source, text: '{arg1, plural, one {# товар} few {# товара} many {# товаров} other {# товара}}' }],
      'ru',
    );
    expect(xml).toContain('<item quantity="few">%1$d товара</item>');
  });
});

describe('gettext adapter', () => {
  const { entries } = poAdapter.parse(read('linux/messages.pot'));
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));

  it('parses flags, context, plurals and comments', () => {
    expect(byKey['Place item on the scale']).toMatchObject({ maxLength: 24, description: "Header on the scale's main screen." });
    expect(byKey['Weight: %s kg'].source).toBe('Weight: {arg1} kg');
    expect(byKey['%d label printed'].source).toBe('{arg1, plural, one {# label printed} other {# labels printed}}');
    expect(byKey['button\u0004Print label'].source).toBe('Print label');
    expect(byKey['Hello %(name)s, you saved %(amount)s'].source).toBe('Hello {name}, you saved {amount}');
  });

  it('exports a translated catalog with the right Plural-Forms', () => {
    const po = poAdapter.serialize(
      entries.map((e) => ({ ...e, text: e.key === '%d label printed' ? '{arg1, plural, one {# etykieta} few {# etykiety} many {# etykiet} other {# etykiety}}' : null })),
      'pl',
    );
    expect(po).toContain('Plural-Forms: nplurals=3;');
    expect(po).toContain('msgstr[1] "%1$d etykiety"');
    expect(po).toContain('msgctxt "button"\nmsgid "Print label"');
    const back = poAdapter.parse(po, 'pl').entries.find((e) => e.key === '%d label printed');
    expect(back?.translation).toBe('{arg1, plural, one {# etykieta} few {# etykiety} many {# etykiet} other {# etykiet}}');
  });
});

describe('json adapters', () => {
  it('parses nested and message/description objects', () => {
    const { entries } = jsonAdapter.parse(read('json/en.json'));
    expect(entries.map((e) => e.key)).toEqual(['menu.title', 'menu.price', 'menu.items_left', 'footer']);
    expect(entries[3]).toMatchObject({ description: 'Footer on the digital signage loop' });
  });
  it('serializes flat and nested', () => {
    const rows = [{ key: 'a.b', source: 'x', text: 'y' }, { key: 'a.c', source: 'z', text: null }];
    expect(JSON.parse(jsonAdapter.serialize(rows, 'es'))).toEqual({ 'a.b': 'y' });
    expect(JSON.parse(jsonNestedAdapter.serialize(rows, 'es'))).toEqual({ a: { b: 'y' } });
  });
});
