import { collectArgs, parseMessage, plainVariants, TYPE, type MessageFormatElement } from './icu.js';
import { pluralCategories } from './plural.js';

export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ValidateOptions {
  locale: string;
  maxLength?: number | null;
}

function pluralNodes(ast: MessageFormatElement[], out: Extract<MessageFormatElement, { type: TYPE.plural }>[] = []) {
  for (const el of ast) {
    if (el.type === TYPE.plural) {
      out.push(el);
      for (const o of Object.values(el.options)) pluralNodes(o.value, out);
    } else if (el.type === TYPE.select) {
      for (const o of Object.values(el.options)) pluralNodes(o.value, out);
    } else if (el.type === TYPE.tag) {
      pluralNodes(el.children, out);
    }
  }
  return out;
}

/** Plain-language checks run on save; errors block saving, warnings do not. */
export function validateTranslation(source: string, target: string, opts: ValidateOptions): Issue[] {
  const issues: Issue[] = [];
  if (!target.trim()) return [{ level: 'error', code: 'empty', message: 'The translation is empty.' }];

  const t = parseMessage(target);
  if (!t.ok) return [{ level: 'error', code: 'syntax', message: t.error }];
  const s = parseMessage(source);
  if (!s.ok) return issues;

  const srcArgs = collectArgs(s.ast);
  const tgtArgs = collectArgs(t.ast);
  for (const name of srcArgs.keys()) {
    if (!tgtArgs.has(name)) issues.push({ level: 'error', code: 'missing-placeholder', message: `Missing placeholder {${name}}.` });
  }
  for (const name of tgtArgs.keys()) {
    if (!srcArgs.has(name)) issues.push({ level: 'error', code: 'unknown-placeholder', message: `{${name}} is not in the original text — remove it or fix its spelling.` });
  }

  const needed = pluralCategories(opts.locale);
  for (const node of pluralNodes(t.ast)) {
    if (node.pluralType === 'ordinal') continue;
    const have = Object.keys(node.options);
    const missing = needed.filter((c) => !have.includes(c));
    if (missing.length) issues.push({ level: 'warning', code: 'plural-missing', message: `Missing plural form(s): ${missing.join(', ')}.` });
    for (const [cat, opt] of Object.entries(node.options)) {
      if (!cat.startsWith('=') && !opt.value.length) issues.push({ level: 'error', code: 'plural-empty', message: `The "${cat}" form is empty.` });
    }
  }

  if (opts.maxLength) {
    const longest = Math.max(...plainVariants(t.ast, '').map((v) => [...v].length));
    if (longest > opts.maxLength) {
      issues.push({ level: 'warning', code: 'too-long', message: `${longest - opts.maxLength} character(s) over the ${opts.maxLength}-character limit for this screen.` });
    }
  }

  const ws = (x: string) => [/^\s/.test(x), /\s$/.test(x)];
  const [sl, sr] = ws(source);
  const [tl, tr] = ws(target);
  if (sl !== tl || sr !== tr) issues.push({ level: 'warning', code: 'whitespace', message: 'Leading/trailing spaces differ from the original.' });

  return issues;
}
