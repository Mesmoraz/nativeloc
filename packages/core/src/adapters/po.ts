import { escapeIcu } from '../icu.js';
import { toEditorModel } from '../editor.js';
import { argPositions, icuToPrintf, parseForm, printfToIcu, renderFlat } from '../printf.js';
import { describe } from './android.js';
import type { Adapter, ExportEntry, SourceEntry } from './types.js';

type PoStyle = 'c' | 'python' | 'brace' | 'text';

interface PoEntry {
  ctx?: string;
  id: string;
  idPlural?: string;
  str: string[];
  extracted: string[];
  refs: string[];
  flags: string[];
  obsolete: boolean;
}

/** gettext Plural-Forms per language, with the CLDR category each index maps to. */
const PLURAL_FORMS: Record<string, { header: string; cats: string[] }> = {
  one: { header: 'nplurals=1; plural=0;', cats: ['other'] },
  two: { header: 'nplurals=2; plural=(n != 1);', cats: ['one', 'other'] },
  fr: { header: 'nplurals=2; plural=(n > 1);', cats: ['one', 'other'] },
  ru: { header: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);', cats: ['one', 'few', 'many'] },
  pl: { header: 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);', cats: ['one', 'few', 'many'] },
  cs: { header: 'nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;', cats: ['one', 'few', 'other'] },
  ar: { header: 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);', cats: ['zero', 'one', 'two', 'few', 'many', 'other'] },
};
const LANG_FORMS: Record<string, keyof typeof PLURAL_FORMS> = {
  ja: 'one', zh: 'one', ko: 'one', vi: 'one', th: 'one', id: 'one', ms: 'one',
  fr: 'fr', pt_BR: 'fr', ru: 'ru', uk: 'ru', be: 'ru', pl: 'pl', cs: 'cs', sk: 'cs', ar: 'ar',
};

export function poPluralForms(locale: string) {
  const norm = locale.replace('-', '_');
  return PLURAL_FORMS[LANG_FORMS[norm] ?? LANG_FORMS[norm.split('_')[0]] ?? 'two'];
}

function unescapeC(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[c] ?? c);
}
function escapeC(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function readEntries(content: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let cur: PoEntry | null = null;
  let field: { key: 'ctx' | 'id' | 'idPlural' } | { key: 'str'; index: number } | null = null;
  const fresh = (): PoEntry => ({ id: '', str: [], extracted: [], refs: [], flags: [], obsolete: false });
  const flush = () => {
    if (cur && (cur.id || cur.str.length)) entries.push(cur);
    cur = null;
    field = null;
  };
  const append = (text: string) => {
    if (!cur || !field) return;
    if (field.key === 'str') cur.str[field.index] = (cur.str[field.index] ?? '') + text;
    else cur[field.key] = (cur[field.key] ?? '') + text;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    let obsolete = false;
    if (line.startsWith('#~')) {
      obsolete = true;
      line = line.slice(2).trim();
    }
    if (line.startsWith('#')) {
      // A comment after a complete entry starts the next one.
      if (cur && field) flush();
      cur ??= fresh();
      if (line.startsWith('#.')) cur.extracted.push(line.slice(2).trim());
      else if (line.startsWith('#:')) cur.refs.push(...line.slice(2).trim().split(/\s+/));
      else if (line.startsWith('#,')) cur.flags.push(...line.slice(2).split(',').map((f) => f.trim()));
      continue;
    }
    const kw = /^(msgctxt|msgid_plural|msgid|msgstr)(?:\[(\d+)\])?\s+"(.*)"$/.exec(line);
    if (kw) {
      if (kw[1] === 'msgctxt' || (kw[1] === 'msgid' && cur && field && field.key === 'str')) flush();
      cur ??= fresh();
      cur.obsolete ||= obsolete;
      field = kw[1] === 'msgctxt' ? { key: 'ctx' } : kw[1] === 'msgid' ? { key: 'id' } : kw[1] === 'msgid_plural' ? { key: 'idPlural' } : { key: 'str', index: Number(kw[2] ?? 0) };
      append(unescapeC(kw[3]));
      continue;
    }
    const cont = /^"(.*)"$/.exec(line);
    if (cont) append(unescapeC(cont[1]));
  }
  flush();
  return entries;
}

function detectStyle(e: PoEntry): PoStyle {
  if (e.flags.includes('c-format')) return 'c';
  if (e.flags.includes('python-format')) return 'python';
  if (e.flags.includes('python-brace-format')) return 'brace';
  const text = e.id + (e.idPlural ?? '');
  if (/\{\w+\}/.test(text)) return 'brace';
  if (/%\(\w+\)[sd]/.test(text)) return 'python';
  if (/%(\d+\$)?[sd]/.test(text)) return 'c';
  return 'text';
}

const COUNT_NAMES = ['count', 'n', 'num', 'number'];

function toIcu(text: string, style: PoStyle, plural: boolean, pound?: string): { message: string; poundArg?: string } {
  if (style === 'c' || style === 'python') return printfToIcu(text, style, plural, pound);
  if (style === 'text') return { message: escapeIcu(text, plural), poundArg: pound };
  // Brace style is already ICU-shaped; in plurals the count placeholder becomes '#'.
  if (!plural) return { message: text };
  let p = pound;
  const message = text.replace(/\{(\w+)\}/g, (m, name: string) => {
    if ((p === undefined && COUNT_NAMES.includes(name)) || p === name) {
      p = name;
      return '#';
    }
    return m;
  });
  return { message, poundArg: p };
}

function pluralIcu(forms: [string, string][], style: PoStyle): string {
  let pound: string | undefined;
  let last = '';
  const parts = forms.map(([cat, text]) => {
    const r = toIcu(text, style, true, pound);
    pound = r.poundArg;
    last = r.message;
    return `${cat} {${r.message}}`;
  });
  // gettext has no "other" slot for some languages (ru, pl); ICU requires one.
  if (!forms.some(([cat]) => cat === 'other')) parts.push(`other {${last}}`);
  return `{${pound ?? 'count'}, plural, ${parts.join(' ')}}`;
}

function parse(content: string, locale?: string) {
  const all = readEntries(content);
  const header = all.find((e) => e.id === '' && !e.ctx);
  const lang = locale ?? (header ? /^Language:\s*(\S+)/m.exec(header.str[0] ?? '')?.[1] : undefined);
  const out: SourceEntry[] = [];
  for (const e of all) {
    if (e === header || e.obsolete || !e.id) continue;
    const style = detectStyle(e);
    const key = e.ctx ? `${e.ctx}\u0004${e.id}` : e.id;
    const meta = { poStyle: style, ...(e.idPlural ? { poIdPlural: e.idPlural } : {}), ...(e.refs.length ? { poRefs: e.refs } : {}) };
    let source: string;
    let translation: string | undefined;
    if (e.idPlural !== undefined) {
      source = pluralIcu([['one', e.id], ['other', e.idPlural]], style);
      if (e.str.some((s) => s)) {
        const cats = poPluralForms(lang ?? 'en').cats;
        translation = pluralIcu(e.str.map((s, i) => [cats[i] ?? 'other', s] as [string, string]), style);
      }
    } else {
      source = toIcu(e.id, style, false).message;
      if (e.str[0]) translation = toIcu(e.str[0], style, false).message;
    }
    out.push({ key, source, meta, ...describe(e.extracted.join(' ')), ...(translation ? { translation } : {}) });
  }
  return { locale: lang, entries: out };
}

function fromIcu(icu: string, style: PoStyle, positions: Map<string, number>, pluralArg?: string): string {
  if (style === 'c' || style === 'python') return icuToPrintf(icu, positions, pluralArg, (s) => s, style);
  const parsed = parseForm(icu, pluralArg);
  if (!parsed.ok) return icu;
  return renderFlat(parsed.ast, {
    literal: (s) => s,
    arg: (name) => `{${name}}`,
    pound: () => `{${pluralArg ?? 'count'}}`,
  });
}

function serialize(entries: ExportEntry[], locale: string): string {
  const pf = poPluralForms(locale);
  const out = [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    `"Language: ${locale.replace('-', '_')}\\n"`,
    `"Plural-Forms: ${pf.header}\\n"`,
    '',
  ];
  const q = (s: string) => `"${escapeC(s)}"`;
  for (const e of entries) {
    const meta = (e.meta ?? {}) as { poStyle?: PoStyle; poIdPlural?: string; poRefs?: string[] };
    const style: PoStyle = meta.poStyle ?? 'brace';
    const positions = argPositions(e.source);
    const src = toEditorModel(e.source);
    if (e.description) out.push(`#. ${e.description.replace(/\n/g, ' ')}`);
    if (meta.poRefs?.length) out.push(`#: ${meta.poRefs.join(' ')}`);
    if (style !== 'text') out.push(`#, ${style === 'c' ? 'c-format' : style === 'python' ? 'python-format' : 'python-brace-format'}`);

    // gettext entries keep their original msgid; keys from other formats use msgctxt=key.
    let ctx: string | undefined;
    let id: string;
    let idPlural: string | undefined;
    if (meta.poStyle) {
      const sep = e.key.indexOf('\u0004');
      ctx = sep >= 0 ? e.key.slice(0, sep) : undefined;
      id = sep >= 0 ? e.key.slice(sep + 1) : e.key;
      idPlural = meta.poIdPlural;
    } else {
      ctx = e.key;
      if (src.kind === 'plural') {
        id = fromIcu(src.forms.one ?? src.forms.other, style, positions, src.arg);
        idPlural = fromIcu(src.forms.other, style, positions, src.arg);
      } else {
        id = fromIcu(e.source, style, positions);
      }
    }
    if (ctx !== undefined) out.push(`msgctxt ${q(ctx)}`);
    out.push(`msgid ${q(id)}`);
    if (src.kind === 'plural') {
      out.push(`msgid_plural ${q(idPlural ?? id)}`);
      const model = e.text ? toEditorModel(e.text) : null;
      pf.cats.forEach((cat, i) => {
        const form = model?.kind === 'plural' ? (model.forms[cat] ?? model.forms.other) : '';
        out.push(`msgstr[${i}] ${q(form ? fromIcu(form, style, positions, src.arg) : '')}`);
      });
    } else {
      out.push(`msgstr ${q(e.text ? fromIcu(e.text, style, positions) : '')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export const poAdapter: Adapter = {
  id: 'po',
  label: 'gettext .po (Linux)',
  extensions: ['.po', '.pot'],
  parse,
  serialize,
};
