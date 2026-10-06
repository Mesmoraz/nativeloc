import { collectArgs, escapeIcu, parseMessage, TYPE, type ArgKind, type MessageFormatElement } from './icu.js';
import { toEditorModel } from './editor.js';

export type PrintfStyle = 'c' | 'python';

const C_SPEC = /%%|%(?:(\d+)\$)?[-#+0,(]*\d*(?:\.\d+)?([sdifuxXoeEgGc])/g;
const PY_SPEC = /%%|%\((\w+)\)[-#+0]*\d*(?:\.\d+)?([sdifrxXeEgGc])|%[-#+0]*\d*(?:\.\d+)?([sdifrxXeEgGc])/g;
const NUMERIC = /[diuf]/;

export interface PrintfResult {
  message: string;
  /** Argument whose number became '#' (only when `plural` is set). */
  poundArg?: string;
}

/**
 * Convert printf-style text (Android/C or Python) to ICU. In plural text the first
 * integer placeholder becomes '#', the number the plural form is chosen by.
 */
export function printfToIcu(text: string, style: PrintfStyle, plural = false, poundArg?: string): PrintfResult {
  const re = style === 'c' ? C_SPEC : PY_SPEC;
  let out = '';
  let last = 0;
  let seq = 0;
  let pound = poundArg;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += escapeIcu(text.slice(last, m.index), plural);
    last = m.index + m[0].length;
    if (m[0] === '%%') {
      out += '%';
      continue;
    }
    let name: string;
    let type: string;
    if (style === 'c') {
      name = `arg${m[1] ? Number(m[1]) : ++seq}`;
      type = m[2];
    } else if (m[1]) {
      name = m[1];
      type = m[2];
    } else {
      name = `arg${++seq}`;
      type = m[3];
    }
    const numeric = NUMERIC.test(type);
    if (plural && numeric && (pound === undefined || pound === name)) {
      pound = name;
      out += '#';
    } else {
      out += numeric ? `{${name}, number}` : `{${name}}`;
    }
  }
  out += escapeIcu(text.slice(last), plural);
  return { message: out, poundArg: pound };
}

/** Positions for printf export: argN keeps N, other names fill free slots in order of appearance. */
export function argPositions(source: string): Map<string, number> {
  const parsed = parseMessage(source);
  const pos = new Map<string, number>();
  if (!parsed.ok) return pos;
  const model = toEditorModel(source);
  const args = collectArgs(parsed.ast);
  const names = [...args.keys()];
  if (model.kind === 'plural' && !names.includes(model.arg)) names.unshift(model.arg);
  const taken = new Set<number>();
  for (const n of names) {
    const m = /^arg(\d+)$/.exec(n);
    if (m) {
      pos.set(n, Number(m[1]));
      taken.add(Number(m[1]));
    }
  }
  let next = 1;
  for (const n of names) {
    if (pos.has(n)) continue;
    while (taken.has(next)) next++;
    pos.set(n, next);
    taken.add(next);
  }
  return pos;
}

export interface FlatHandlers {
  literal(text: string): string;
  arg(name: string, kind: ArgKind): string;
  pound(): string;
}

/** Render a message without plural/select (or a single plural form) through handlers. */
export function renderFlat(ast: MessageFormatElement[], h: FlatHandlers): string {
  let out = '';
  for (const el of ast) {
    switch (el.type) {
      case TYPE.literal:
        out += h.literal(el.value);
        break;
      case TYPE.pound:
        out += h.pound();
        break;
      case TYPE.argument:
        out += h.arg(el.value, 'simple');
        break;
      case TYPE.number:
        out += h.arg(el.value, 'number');
        break;
      case TYPE.date:
      case TYPE.time:
        out += h.arg(el.value, el.type === TYPE.date ? 'date' : 'time');
        break;
      case TYPE.plural:
      case TYPE.select: {
        // Not representable in flat formats: fall back to the "other" branch.
        const other = el.options.other ?? Object.values(el.options)[0];
        out += renderFlat(other?.value ?? [], h);
        break;
      }
      case TYPE.tag:
        out += renderFlat(el.children, h);
        break;
    }
  }
  return out;
}

/**
 * Parse ICU text; with `pluralArg` the text is one plural form, so '#' means the count.
 */
export function parseForm(message: string, pluralArg?: string) {
  if (pluralArg === undefined) return parseMessage(message);
  const parsed = parseMessage(`{${pluralArg}, plural, other {${message}}}`);
  if (!parsed.ok || parsed.ast[0]?.type !== TYPE.plural) return parsed;
  return { ok: true as const, ast: parsed.ast[0].options.other.value };
}

export function icuToPrintf(message: string, positions: Map<string, number>, pluralArg: string | undefined, escape: (s: string) => string, style: PrintfStyle = 'c'): string {
  const parsed = parseForm(message, pluralArg);
  if (!parsed.ok) return escape(message);
  const spec = (name: string, kind: ArgKind) => {
    const t = kind === 'number' || kind === 'plural' ? 'd' : 's';
    if (style === 'python' && !/^arg\d+$/.test(name)) return `%(${name})${t}`;
    return `%${positions.get(name) ?? 1}$${t}`;
  };
  return renderFlat(parsed.ast, {
    literal: (s) => escape(s.replace(/%/g, '%%')),
    arg: spec,
    pound: () => spec(pluralArg ?? 'count', 'number'),
  });
}
