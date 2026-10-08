import { escapeIcu } from '@nativeloc/core';

/**
 * Splits a web page into translatable segments: one per block of running text (a heading, a paragraph,
 * a list item, a button) plus attribute text (image descriptions, field hints, the page description).
 *
 * Works over a minimal tree interface so the same code runs on a server-side parse (crawler) and on the
 * live DOM (the in-page snippet). Both must produce identical keys for the same content.
 *
 * Inline markup inside a block becomes paired placeholders, so translators see chips instead of HTML:
 *   `Call <a href="tel:…">our hotline</a> today` → `Call {link1}our hotline{link1_end} today`
 */
export interface TreeAdapter<N> {
  kind(node: N): 'element' | 'text' | 'other';
  /** Lowercase tag name (elements only). */
  tag(node: N): string;
  attr(node: N, name: string): string | null;
  children(node: N): N[];
  /** Text content of a text node. */
  text(node: N): string;
}

export interface Segment<N = unknown> {
  /** Stable key derived from the source text: the same sentence on any page is one string. */
  key: string;
  /** ICU source text. */
  source: string;
  /** What the text is, in words a translator understands: "heading", "button", "image description"… */
  role: string;
  /** Placeholder labels for the editor chips, e.g. { link1: 'link start' }. */
  labels: Record<string, string>;
  /** Element that owns the text (block element, or the element carrying the attribute). */
  element: N;
  /** For attribute text: which attribute. */
  attr?: string;
  /** For running text: the child nodes of `element` the segment was built from. */
  nodes?: N[];
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'pre', 'textarea']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'img', 'input', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
/** Inline elements with no translatable content of their own: they become a single placeholder. */
const ATOMIC: Record<string, string> = { br: 'line break', wbr: '', img: 'image', input: 'form field', code: 'code', kbd: 'keyboard key', samp: 'sample output', var: 'variable' };
/** Inline elements whose tags carry no meaning; their text is kept and the tags dropped. */
const UNWRAP = new Set(['span', 'font', 'bdi', 'data']);
const PAIR_NAMES: Record<string, [string, string]> = {
  a: ['link', 'link'],
  b: ['bold', 'bold text'],
  strong: ['bold', 'bold text'],
  em: ['italic', 'emphasis'],
  i: ['italic', 'italic text'],
  u: ['underline', 'underlined text'],
  mark: ['highlight', 'highlighted text'],
};

const ROLES: Record<string, string> = {
  h1: 'main heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  li: 'list item',
  a: 'link',
  button: 'button',
  label: 'form label',
  legend: 'form section title',
  th: 'table heading',
  td: 'table cell',
  caption: 'table title',
  figcaption: 'image caption',
  blockquote: 'quote',
  dt: 'term',
  dd: 'definition',
  summary: 'expandable section title',
  option: 'menu choice',
  title: 'page title (browser tab and search results)',
};
const AREAS: Record<string, string> = { nav: 'navigation menu', header: 'page header', footer: 'page footer', form: 'form', aside: 'sidebar' };

/** 53-bit string hash (cyrb53). Deterministic and synchronous so the browser snippet can compute keys too. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const keyFor = (source: string) => `w.${hashText(source)}`;

/** Worth sending to a translator: has letters, and isn't just an email address, URL or phone number. */
export function isTranslatable(plain: string): boolean {
  const t = plain.trim();
  if (!/\p{L}/u.test(t)) return false;
  if (/^(\S+@\S+\.\S+|https?:\/\/\S+|www\.\S+)$/i.test(t)) return false;
  return true;
}

export function extractSegments<N>(root: N, tree: TreeAdapter<N>): Segment<N>[] {
  const out: Segment<N>[] = [];
  const isEl = (n: N) => tree.kind(n) === 'element';
  const hidden = (n: N) => tree.attr(n, 'hidden') != null || tree.attr(n, 'aria-hidden') === 'true';
  const noTranslate = (n: N) => tree.attr(n, 'translate') === 'no' || /(^|\s)notranslate(\s|$)/.test(tree.attr(n, 'class') ?? '');
  const skipped = (n: N) => isEl(n) && (SKIP.has(tree.tag(n)) || hidden(n));

  const containsBlock = (n: N): boolean =>
    tree.children(n).some((c) => isEl(c) && !skipped(c) && (!INLINE.has(tree.tag(c)) || containsBlock(c)));
  const isInline = (n: N) => tree.kind(n) === 'text' || (isEl(n) && INLINE.has(tree.tag(n)) && !containsBlock(n));

  function addAttributes(el: N, area: string | null) {
    const tag = tree.tag(el);
    const add = (attr: string, role: string) => {
      const value = tree.attr(el, attr)?.replace(/\s+/g, ' ').trim();
      if (!value || !isTranslatable(value)) return;
      const source = escapeIcu(value);
      out.push({ key: keyFor(source), source, role: area ? `${role} (${area})` : role, labels: {}, element: el, attr });
    };
    if (tag === 'img') add('alt', 'image description');
    if (tag === 'input' || tag === 'textarea') add('placeholder', 'hint inside a form field');
    if (tag === 'input' && /^(submit|button|reset)$/i.test(tree.attr(el, 'type') ?? '')) add('value', 'button');
    if (tag === 'meta') {
      const name = (tree.attr(el, 'name') ?? tree.attr(el, 'property') ?? '').toLowerCase();
      if (name === 'description' || name === 'og:description') add('content', 'page description (search results and link previews)');
      if (name === 'og:title') add('content', 'page title in link previews');
    }
    add('aria-label', 'label read aloud by screen readers');
    add('title', 'tooltip');
  }

  /** Turn a run of inline nodes into ICU text with paired placeholders. */
  function renderRun(nodes: N[]) {
    const labels: Record<string, string> = {};
    const counts: Record<string, number> = {};
    const next = (base: string) => `${base}${(counts[base] = (counts[base] ?? 0) + 1)}`;
    const render = (n: N): string => {
      if (tree.kind(n) === 'text') return escapeIcu(tree.text(n).replace(/\s+/g, ' '));
      if (!isEl(n) || skipped(n)) return '';
      const tag = tree.tag(n);
      if (tag in ATOMIC || noTranslate(n)) {
        if (tag === 'wbr') return '';
        const name = next(tag === 'br' ? 'br' : tag === 'img' ? 'image' : noTranslate(n) ? 'keep' : tag);
        labels[name] = noTranslate(n) ? 'kept as is' : ATOMIC[tag];
        return `{${name}}`;
      }
      if (UNWRAP.has(tag)) return tree.children(n).map(render).join('');
      // When one formatting tag exactly wraps another (<a><u>Agreement</u></a>), translators only need
      // one pair of chips: keep the link, else the outer tag.
      const kids = tree.children(n).filter((c) => isEl(c) || tree.text(c).trim());
      const only = kids.length === 1 && isEl(kids[0]) && !(tree.tag(kids[0]) in ATOMIC) && !noTranslate(kids[0]) ? kids[0] : null;
      if (only && tag !== 'a' && tree.tag(only) === 'a') return render(only);
      const inner = (only && !UNWRAP.has(tree.tag(only)) ? tree.children(only) : tree.children(n)).map(render).join('');
      const [base, what] = PAIR_NAMES[tag] ?? [tag, tag];
      const name = next(base);
      labels[name] = `start of ${what}`;
      labels[`${name}_end`] = `end of ${what}`;
      return `{${name}}${inner}{${name}_end}`;
    };
    return { source: nodes.map(render).join('').replace(/\s+/g, ' ').trim(), labels };
  }

  /** Text only, for deciding whether a run is worth translating. */
  const plainText = (n: N): string =>
    tree.kind(n) === 'text' ? tree.text(n) : isEl(n) && !skipped(n) && !(tree.tag(n) in ATOMIC) && !noTranslate(n) ? tree.children(n).map(plainText).join('') : '';

  function flush(owner: N, run: N[], role: string) {
    // A run that is only one wrapping element (e.g. a nav item <li><a>Get help</a></li>) is described by
    // that element and translated without the wrapper.
    let nodes = run;
    let what = role;
    for (;;) {
      const meaningful = nodes.filter((n) => isEl(n) || tree.text(n).trim());
      const only = meaningful[0];
      if (meaningful.length !== 1 || !isEl(only) || tree.tag(only) in ATOMIC || noTranslate(only)) break;
      if (tree.tag(only) === 'a' && !what.startsWith('link')) what = /^(list item|text)\b/.test(what) ? what.replace(/^(list item|text)/, 'link') : `link in ${what}`;
      nodes = tree.children(only);
    }
    if (!isTranslatable(nodes.map(plainText).join(''))) return;
    const { source, labels } = renderRun(nodes);
    if (!source) return;
    out.push({ key: keyFor(source), source, role: what, labels, element: owner, nodes });
  }

  function visit(el: N, area: string | null) {
    if (skipped(el) || noTranslate(el)) return;
    const tag = tree.tag(el);
    const here = AREAS[tag] ?? area;
    addAttributes(el, here);
    const role = (ROLES[tag] ?? 'text') + (here ? ` (${here})` : '');
    let run: N[] = [];
    const endRun = () => {
      if (!run.length) return;
      flush(el, run, role);
      // Attributes on inline elements (image descriptions, tooltips) follow their sentence.
      for (const n of run) if (isEl(n)) walkAttributes(n, here);
      run = [];
    };
    for (const child of tree.children(el)) {
      if (isInline(child)) {
        run.push(child);
        continue;
      }
      endRun();
      if (isEl(child)) visit(child, here);
    }
    endRun();
  }

  function walkAttributes(n: N, area: string | null) {
    if (skipped(n)) return;
    addAttributes(n, area);
    for (const c of tree.children(n)) if (isEl(c)) walkAttributes(c, area);
  }

  visit(root, null);
  return out;
}
