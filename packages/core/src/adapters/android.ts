import { collectArgs, escapeIcu, parseMessage } from '../icu.js';
import { toEditorModel } from '../editor.js';
import { argPositions, icuToPrintf, printfToIcu } from '../printf.js';
import type { Adapter, ExportEntry, SourceEntry } from './types.js';

const TOKEN = /<!--([\s\S]*?)-->|<(string-array|string|plurals)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\2\s*>)/g;
const ITEM = /<item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/item\s*>)/g;
const MAX_HINT = /\s*\(?\bmax(?:Length)?\s*[=:]\s*(\d+)\)?\s*/i;

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)));
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[lower];
  });
}

/** Android resource string → plain text (quotes, escapes, whitespace collapsing). */
export function unescapeAndroid(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  s = s.replace(/<\/?xliff:g\b[^>]*>/g, '');
  s = decodeEntities(s);
  let out = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[++i];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += n;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(ch)) {
      if (!out.endsWith(' ') || out.length === 0) out += ' ';
    } else {
      out += ch;
    }
  }
  return quoted ? out : out.replace(/^ | $/g, '');
}

export function escapeAndroid(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/<(?!\/?[a-zA-Z][\w-]*\s*>)/g, '&lt;')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/^([@?])/, '\\$1');
}

export function describe(comment: string | undefined): Pick<SourceEntry, 'description' | 'maxLength'> {
  if (!comment) return {};
  const text = comment.trim();
  const m = MAX_HINT.exec(text);
  const description = (m ? text.replace(MAX_HINT, ' ') : text).trim();
  return { ...(description ? { description } : {}), ...(m ? { maxLength: Number(m[1]) } : {}) };
}

/**
 * `<xliff:g id="name">%1$s</xliff:g>` names a placeholder; keep that name as the chip label
 * localizers see ("name" instead of "value 1").
 */
function xliffLabels(raw: string): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  for (const m of raw.matchAll(/<xliff:g\b[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xliff:g>/g)) {
    const pos = /%(\d+)\$/.exec(m[2])?.[1] ?? String((raw.slice(0, m.index).match(/%(?!%)/g) ?? []).length + 1);
    if (/%/.test(m[2])) labels[`arg${pos}`] = m[1].replace(/[_-]+/g, ' ');
  }
  return Object.keys(labels).length ? labels : undefined;
}

function convert(raw: string, formatted: boolean, plural = false, pound?: string) {
  const text = unescapeAndroid(raw);
  // getString() without args returns "%%" verbatim, so only plurals and strings with real specs are formats.
  const isFormat = formatted && (plural || /%(?!%)/.test(text.replace(/%%/g, '')));
  return isFormat ? printfToIcu(text, 'c', plural, pound) : { message: escapeIcu(text, plural), poundArg: pound };
}

function parse(content: string) {
  const entries: SourceEntry[] = [];
  let comment: string | undefined;
  let lastEnd = 0;
  for (const m of content.matchAll(TOKEN)) {
    const between = content.slice(lastEnd, m.index);
    if (between.trim()) comment = undefined;
    lastEnd = m.index! + m[0].length;
    if (m[1] !== undefined) {
      comment = m[1];
      continue;
    }
    const tag = m[2];
    const a = attrs(m[3]);
    const body = m[4] ?? '';
    const meta = describe(comment);
    comment = undefined;
    if (!a.name || a.translatable === 'false') continue;
    const formatted = a.formatted !== 'false';

    if (tag === 'string') {
      const labels = xliffLabels(body);
      entries.push({ key: a.name, source: convert(body, formatted).message, ...meta, ...(labels ? { meta: { labels } } : {}) });
    } else if (tag === 'string-array') {
      [...body.matchAll(ITEM)].forEach((item, i) => {
        entries.push({ key: `${a.name}[${i}]`, source: convert(item[2] ?? '', formatted).message, ...meta });
      });
    } else {
      let pound: string | undefined;
      const forms: string[] = [];
      for (const item of body.matchAll(ITEM)) {
        const q = attrs(item[1]).quantity;
        if (!q) continue;
        const r = convert(item[2] ?? '', formatted, true, pound);
        pound = r.poundArg;
        forms.push(`${q} {${r.message}}`);
      }
      if (!forms.some((f) => f.startsWith('other '))) continue;
      entries.push({ key: a.name, source: `{${pound ?? 'count'}, plural, ${forms.join(' ')}}`, ...meta });
    }
  }
  return { entries };
}

function needsFormatting(icu: string): boolean {
  const p = parseMessage(icu);
  return p.ok && collectArgs(p.ast).size > 0;
}

function serialize(entries: ExportEntry[], _locale: string): string {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>'];
  const arrays = new Map<string, string[]>();
  const comment = (e: ExportEntry) => (e.description ? `    <!-- ${e.description.replace(/--/g, '- -')} -->` : null);

  for (const e of entries) {
    if (e.text == null) continue;
    const positions = argPositions(e.source);
    const model = toEditorModel(e.text);
    const arr = /^(.*)\[(\d+)\]$/.exec(e.key);
    if (model.kind === 'plural') {
      const c = comment(e);
      if (c) lines.push(c);
      lines.push(`    <plurals name="${e.key}">`);
      for (const [cat, form] of Object.entries(model.forms)) {
        if (cat.startsWith('=')) continue;
        lines.push(`        <item quantity="${cat}">${icuToPrintf(form, positions, model.arg, escapeAndroid)}</item>`);
      }
      lines.push('    </plurals>');
      continue;
    }
    const pct = needsFormatting(e.text);
    const value = icuToPrintf(e.text, positions, undefined, (s) => escapeAndroid(pct ? s : s.replace(/%%/g, '%')));
    if (arr) {
      const list = arrays.get(arr[1]) ?? [];
      list[Number(arr[2])] = value;
      arrays.set(arr[1], list);
      continue;
    }
    const c = comment(e);
    if (c) lines.push(c);
    lines.push(`    <string name="${e.key}">${value}</string>`);
  }
  for (const [name, items] of arrays) {
    lines.push(`    <string-array name="${name}">`);
    for (const item of items) lines.push(`        <item>${item ?? ''}</item>`);
    lines.push('    </string-array>');
  }
  lines.push('</resources>', '');
  return lines.join('\n');
}

export const androidAdapter: Adapter = {
  id: 'android-xml',
  label: 'Android strings.xml',
  extensions: ['.xml'],
  parse,
  serialize,
};
