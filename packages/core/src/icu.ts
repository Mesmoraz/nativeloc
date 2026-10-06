import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

export type { MessageFormatElement };
export { TYPE };

export type ArgKind = 'simple' | 'number' | 'date' | 'time' | 'plural' | 'selectordinal' | 'select';

export interface ParseOk {
  ok: true;
  ast: MessageFormatElement[];
}
export interface ParseFail {
  ok: false;
  error: string;
  offset?: number;
}

const FRIENDLY_ERRORS: Record<string, string> = {
  EXPECT_ARGUMENT_CLOSING_BRACE: 'A placeholder is missing its closing "}".',
  EMPTY_ARGUMENT: 'There is an empty placeholder "{}".',
  MALFORMED_ARGUMENT: 'A placeholder is malformed.',
  MISSING_OTHER_CLAUSE: 'Plural or choice text needs an "other" form.',
  UNCLOSED_QUOTE_IN_ARGUMENT_STYLE: 'There is an unclosed quote inside a placeholder.',
  EXPECT_PLURAL_ARGUMENT_OPTIONS: 'Plural forms are missing.',
  EXPECT_SELECT_ARGUMENT_OPTIONS: 'Choice options are missing.',
  INVALID_ARGUMENT_TYPE: 'A placeholder has an unknown type.',
  DUPLICATE_PLURAL_ARGUMENT_SELECTOR: 'A plural form is listed twice.',
  DUPLICATE_SELECT_ARGUMENT_SELECTOR: 'A choice option is listed twice.',
};

export function parseMessage(message: string): ParseOk | ParseFail {
  try {
    return { ok: true, ast: parse(message, { ignoreTag: true, requiresOtherClause: true, captureLocation: true }) };
  } catch (e) {
    const err = e as Error & { location?: { start: { offset: number } } };
    return { ok: false, error: FRIENDLY_ERRORS[err.message] ?? `Invalid message (${err.message}).`, offset: err.location?.start.offset };
  }
}

/** Every argument referenced by a message, with how it is used. */
export function collectArgs(ast: MessageFormatElement[], out = new Map<string, ArgKind>()): Map<string, ArgKind> {
  for (const el of ast) {
    switch (el.type) {
      case TYPE.argument:
        if (!out.has(el.value)) out.set(el.value, 'simple');
        break;
      case TYPE.number:
        out.set(el.value, 'number');
        break;
      case TYPE.date:
        out.set(el.value, 'date');
        break;
      case TYPE.time:
        out.set(el.value, 'time');
        break;
      case TYPE.plural:
        out.set(el.value, el.pluralType === 'ordinal' ? 'selectordinal' : 'plural');
        for (const opt of Object.values(el.options)) collectArgs(opt.value, out);
        break;
      case TYPE.select:
        out.set(el.value, 'select');
        for (const opt of Object.values(el.options)) collectArgs(opt.value, out);
        break;
      case TYPE.tag:
        collectArgs(el.children, out);
        break;
    }
  }
  return out;
}

export function hasPluralOrSelect(ast: MessageFormatElement[]): boolean {
  return ast.some((el) => el.type === TYPE.plural || el.type === TYPE.select || (el.type === TYPE.tag && hasPluralOrSelect(el.children)));
}

/** Escape plain text so it survives as literal ICU text. `inPlural` also protects '#'. */
export function escapeIcu(text: string, inPlural = false): string {
  const special = inPlural ? /[{}#]/ : /[{}]/;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      // An apostrophe is only special when it precedes a syntax char or another apostrophe.
      const next = text[i + 1] ?? '';
      out += next === "'" || special.test(next) ? "''" : "'";
    } else if (special.test(ch)) {
      out += `'${ch}'`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Plain-text rendering of a message for length checks: placeholders become `sample`. */
export function plainVariants(ast: MessageFormatElement[], sample = 'xxxx'): string[] {
  let variants = [''];
  for (const el of ast) {
    let pieces: string[];
    switch (el.type) {
      case TYPE.literal:
        pieces = [el.value];
        break;
      case TYPE.pound:
        pieces = ['00'];
        break;
      case TYPE.plural:
      case TYPE.select:
        pieces = Object.values(el.options).flatMap((o) => plainVariants(o.value, sample));
        break;
      case TYPE.tag:
        pieces = plainVariants(el.children, sample);
        break;
      default:
        pieces = [sample];
    }
    variants = variants.flatMap((v) => pieces.map((p) => v + p)).slice(0, 64);
  }
  return variants;
}
