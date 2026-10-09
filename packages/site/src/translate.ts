import { parseMessage, renderFlat } from '@nativeloc/core';
import { defaultTreeAdapter as A, parse, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterTypes as T } from 'parse5';
import { extractSegments, type Segment } from './extract.js';
import { parse5Tree } from './html.js';

type Node = T.ChildNode | T.Document;

export interface TranslatePageOptions {
  /** Address the HTML came from. Relative links, images and styles resolve against it. */
  url: string;
  locale: string;
  /** Translation per key (ICU text). Keys without one keep the original text. */
  translations: Map<string, string>;
  /** Where a link should point instead, given its absolute address; null leaves it pointing at the original. */
  linkFor?: (target: URL) => string | null;
  /** HTML added to <head> (after <base>), e.g. robots tags. */
  head?: string;
  /** HTML added at the start of <body>, e.g. a preview banner. */
  banner?: string;
}

export interface TranslatedPage {
  html: string;
  /** Distinct texts on the page, and how many of them had a translation that could be used. */
  strings: number;
  translated: number;
}

const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi', 'dv', 'ckb', 'sd', 'ug']);

/**
 * Rebuilds a page with translated text: the same segmenter that read the page for translators finds each
 * text again by key, so only what volunteers translated changes. Links, images and markup inside a
 * sentence come back from the original page through the placeholders.
 */
export function translatePage(html: string, opts: TranslatePageOptions): TranslatedPage {
  const doc = parse(html);
  const htmlEl = find(doc, 'html');
  const head = find(doc, 'head');
  const body = find(doc, 'body');

  // Text first, then the page around it: a <base> or banner added earlier would otherwise be read as content.
  const segments = extractSegments<Node>(doc, parse5Tree);
  const keys = new Set<string>();
  const used = new Set<string>();
  // Attributes before running text: running text copies the original inline elements (an <img> inside a
  // sentence), and those copies should carry the translated image description.
  const ordered = [...segments.filter((s) => s.attr), ...segments.filter((s) => !s.attr)];
  for (const s of ordered) {
    keys.add(s.key);
    const text = opts.translations.get(s.key);
    if (text == null || !(s.attr ? setAttribute(s, text) : replaceText(s, text))) continue;
    used.add(s.key);
  }

  let base = opts.url;
  const existingBase = findAll(doc, 'base').find((b) => parse5Tree.attr(b, 'href'));
  if (existingBase) {
    base = resolve(parse5Tree.attr(existingBase, 'href')!, opts.url)?.href ?? opts.url;
    setAttr(existingBase as T.Element, 'href', base);
  }
  if (opts.linkFor) {
    for (const a of [...findAll(doc, 'a'), ...findAll(doc, 'area')]) {
      const href = parse5Tree.attr(a, 'href');
      const target = href && !href.startsWith('#') ? resolve(href, base) : null;
      const to = target && /^https?:$/.test(target.protocol) ? opts.linkFor(target) : null;
      if (to) setAttr(a as T.Element, 'href', to);
    }
  }

  if (htmlEl) {
    setAttr(htmlEl, 'lang', opts.locale);
    setAttr(htmlEl, 'dir', RTL.has(opts.locale.split('-')[0]) ? 'rtl' : 'ltr');
  }
  if (head) {
    // <base> goes first so every relative address in the page (styles, scripts, images, forms) still
    // reaches the original site.
    const added = parseFragment(head, `${existingBase ? '' : `<base href="${escapeAttr(base)}">`}${opts.head ?? ''}`, {}).childNodes;
    const first = head.childNodes[0];
    for (const n of added) first ? A.insertBefore(head, n, first) : A.appendChild(head, n);
  }
  if (body && opts.banner) {
    const added = parseFragment(body, opts.banner, {}).childNodes;
    const first = body.childNodes[0];
    for (const n of added) first ? A.insertBefore(body, n, first) : A.appendChild(body, n);
  }

  return { html: serialize(doc), strings: keys.size, translated: used.size };
}

/** Flat pieces of a translation: text, and placeholder names in order. */
function pieces(text: string): ({ text: string } | { name: string })[] | null {
  const parsed = parseMessage(text);
  if (!parsed.ok) return null;
  const out: ({ text: string } | { name: string })[] = [];
  renderFlat(parsed.ast, {
    literal: (t) => (out.push({ text: t }), ''),
    arg: (name) => (out.push({ name }), ''),
    pound: () => (out.push({ text: '#' }), ''),
  });
  return out;
}

function setAttribute(s: Segment<Node>, text: string): boolean {
  const parts = pieces(text);
  if (!parts || parts.some((p) => 'name' in p)) return false;
  setAttr(s.element as T.Element, s.attr!, parts.map((p) => ('text' in p ? p.text : '')).join(''));
  return true;
}

/** Swap a segment's original nodes for the translation. Returns false (page unchanged) if it doesn't fit. */
function replaceText(s: Segment<Node>, text: string): boolean {
  const original = s.nodes as T.ChildNode[] | undefined;
  const parent = original?.[0] && A.getParentNode(original[0]);
  const parts = pieces(text);
  if (!original?.length || !parent || !parts) return false;

  const root: T.ChildNode[] = [];
  const stack: { name: string; el: T.Element }[] = [];
  const add = (n: T.ChildNode) => (stack.length ? A.appendChild(stack[stack.length - 1].el, n) : root.push(n));
  for (const p of parts) {
    if ('text' in p) {
      if (p.text) add(A.createTextNode(p.text));
      continue;
    }
    const nodes = s.parts?.[p.name];
    if (p.name.endsWith('_end') && s.parts?.[p.name.slice(0, -4)]) {
      if (stack.pop()?.name !== p.name.slice(0, -4)) return false;
    } else if (nodes && `${p.name}_end` in s.labels) {
      // Opening chip: shallow copies of the wrapping elements (a link keeps its address and attributes).
      const [outer, inner] = nodes.map((n) => shallowClone(n as T.Element));
      if (inner) A.appendChild(outer, inner);
      add(outer);
      stack.push({ name: p.name, el: inner ?? outer });
    } else if (nodes) {
      add(deepClone(nodes[0] as T.ChildNode));
    } else {
      return false;
    }
  }
  if (stack.length) return false;

  // Keep the spacing around the sentence: the source text was trimmed, the page around it wasn't.
  const lead = /^\s/.test(textOf(original[0])) ? ' ' : '';
  const trail = /\s$/.test(textOf(original[original.length - 1])) ? ' ' : '';
  if (lead) root.unshift(A.createTextNode(lead));
  if (trail) root.push(A.createTextNode(trail));

  const after = A.getParentNode(original[original.length - 1]) === parent ? nextSibling(original[original.length - 1]) : null;
  for (const n of original) if (A.getParentNode(n)) A.detachNode(n);
  for (const n of root) after ? A.insertBefore(parent as T.ParentNode, n, after) : A.appendChild(parent as T.ParentNode, n);
  return true;
}

const textOf = (n: T.ChildNode) => (A.isTextNode(n) ? n.value : '');

function nextSibling(n: T.ChildNode): T.ChildNode | null {
  const siblings = A.getParentNode(n)!.childNodes;
  return siblings[siblings.indexOf(n) + 1] ?? null;
}

function shallowClone(el: T.Element): T.Element {
  return A.createElement(el.tagName, el.namespaceURI, el.attrs.map((a) => ({ ...a })));
}

function deepClone(n: T.ChildNode): T.ChildNode {
  if (A.isTextNode(n)) return A.createTextNode(n.value);
  if (A.isCommentNode(n)) return A.createCommentNode(n.data);
  if (!A.isElementNode(n)) return n;
  const el = shallowClone(n);
  for (const c of n.childNodes) A.appendChild(el, deepClone(c));
  return el;
}

function setAttr(el: T.Element, name: string, value: string) {
  const found = el.attrs.find((a) => a.name === name);
  if (found) found.value = value;
  else el.attrs.push({ name, value });
}

function findAll(root: Node, tag: string, out: Node[] = []): Node[] {
  for (const c of 'childNodes' in root ? root.childNodes : []) {
    if (A.isElementNode(c) && c.tagName === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
const find = (root: Node, tag: string) => findAll(root, tag)[0] as T.Element | undefined;

function resolve(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

export const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
