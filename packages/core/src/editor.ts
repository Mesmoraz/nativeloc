import { collectArgs, hasPluralOrSelect, parseMessage, TYPE, type MessageFormatElement } from './icu.js';
import { pluralCategories, type PluralCategory } from './plural.js';

/**
 * What a localizer edits. ICU syntax is hidden: simple strings are plain text with
 * `{name}` chips, and plurals become one full sentence per plural form.
 */
export type EditorModel =
  | { kind: 'text'; text: string }
  | { kind: 'plural'; arg: string; ordinal: boolean; forms: Record<string, string> }
  | { kind: 'advanced'; text: string };

export interface Placeholder {
  /** Token the localizer inserts, e.g. "{name}" or "#". */
  token: string;
  /** Human label shown on the chip. */
  label: string;
}

function isSimplePlural(el: MessageFormatElement): el is Extract<MessageFormatElement, { type: TYPE.plural }> {
  return el.type === TYPE.plural && el.offset === 0 && Object.values(el.options).every((o) => !hasPluralOrSelect(o.value));
}

export function toEditorModel(message: string): EditorModel {
  const parsed = parseMessage(message);
  if (!parsed.ok) return { kind: 'advanced', text: message };
  if (!hasPluralOrSelect(parsed.ast)) return { kind: 'text', text: message };

  const top = parsed.ast.filter((el) => el.type === TYPE.plural || el.type === TYPE.select || el.type === TYPE.tag);
  const plural = parsed.ast.find(isSimplePlural);
  if (top.length !== 1 || !plural || !plural.location) return { kind: 'advanced', text: message };

  const prefix = message.slice(0, plural.location.start.offset);
  const suffix = message.slice(plural.location.end.offset);
  // A literal '#' outside the plural would change meaning once folded inside a form.
  if (/#/.test(prefix + suffix)) return { kind: 'advanced', text: message };

  const forms: Record<string, string> = {};
  for (const [cat, opt] of Object.entries(plural.options)) {
    const inner = opt.location ? message.slice(opt.location.start.offset + 1, opt.location.end.offset - 1) : '';
    forms[cat] = prefix + inner + suffix;
  }
  return { kind: 'plural', arg: plural.value, ordinal: plural.pluralType === 'ordinal', forms };
}

export function fromEditorModel(model: EditorModel): string {
  if (model.kind !== 'plural') return model.text;
  const order = (c: string) => (c.startsWith('=') ? -1 : ['zero', 'one', 'two', 'few', 'many', 'other'].indexOf(c));
  const parts = Object.keys(model.forms)
    .sort((a, b) => order(a) - order(b))
    .map((cat) => `${cat} {${model.forms[cat]}}`);
  return `{${model.arg}, ${model.ordinal ? 'selectordinal' : 'plural'}, ${parts.join(' ')}}`;
}

function ordinalCategories(locale: string): PluralCategory[] {
  try {
    const cats = new Intl.PluralRules(locale, { type: 'ordinal' }).resolvedOptions().pluralCategories;
    return (['zero', 'one', 'two', 'few', 'many', 'other'] as PluralCategory[]).filter((c) => cats.includes(c));
  } catch {
    return ['other'];
  }
}

/** The empty (or pre-filled) model a localizer starts from for a target locale. */
export function targetTemplate(source: string, existing: string | null | undefined, locale: string): EditorModel {
  const src = toEditorModel(source);
  const prev = existing ? toEditorModel(existing) : null;
  if (src.kind === 'plural') {
    const cats: string[] = src.ordinal ? ordinalCategories(locale) : pluralCategories(locale);
    const exact = Object.keys(src.forms).filter((k) => k.startsWith('='));
    const forms: Record<string, string> = {};
    for (const cat of [...exact, ...cats]) {
      forms[cat] = prev?.kind === 'plural' ? (prev.forms[cat] ?? '') : '';
    }
    return { kind: 'plural', arg: src.arg, ordinal: src.ordinal, forms };
  }
  return { kind: src.kind, text: existing ?? '' };
}

/** Source text to show beside a given target plural form ("few" falls back to "other"). */
export function sourceFormFor(source: EditorModel, category: string): string {
  if (source.kind !== 'plural') return source.text;
  return source.forms[category] ?? source.forms.other ?? '';
}

/**
 * Placeholders a localizer may need to insert, derived from the source message.
 * `labels` (e.g. from Android xliff:g ids) gives friendlier chip names.
 */
export function listPlaceholders(source: string, labels: Record<string, string> = {}): Placeholder[] {
  const parsed = parseMessage(source);
  if (!parsed.ok) return [];
  const out: Placeholder[] = [];
  const model = toEditorModel(source);
  if (model.kind === 'plural') out.push({ token: '#', label: 'number' });
  for (const [name, kind] of collectArgs(parsed.ast)) {
    if (model.kind === 'plural' && name === model.arg) continue;
    if (kind === 'plural' || kind === 'select' || kind === 'selectordinal') continue;
    const token = kind === 'simple' ? `{${name}}` : `{${name}, ${kind}}`;
    out.push({ token, label: labels[name] ?? name.replace(/^arg(\d+)$/, 'value $1') });
  }
  return out;
}
