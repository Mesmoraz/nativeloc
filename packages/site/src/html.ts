import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes as T } from 'parse5';
import { extractSegments, type Segment, type TreeAdapter } from './extract.js';

type Node = T.ChildNode | T.Document;

export const parse5Tree: TreeAdapter<Node> = {
  kind: (n) => (n.nodeName === '#text' ? 'text' : 'tagName' in n || n.nodeName === '#document' ? 'element' : 'other'),
  tag: (n) => ('tagName' in n ? n.tagName.toLowerCase() : ''),
  attr: (n, name) => ('attrs' in n ? (n.attrs.find((a) => a.name === name)?.value ?? null) : null),
  // <template> content lives in a separate fragment; it isn't shown until scripts use it.
  children: (n) => ('tagName' in n && n.tagName === 'template' ? [] : 'childNodes' in n ? n.childNodes : []),
  text: (n) => (n.nodeName === '#text' ? (n as T.TextNode).value : ''),
};

export interface PageLink {
  url: string;
  text: string;
}

export interface ParsedPage {
  url: string;
  title: string;
  lang: string | null;
  segments: Segment<Node>[];
  links: PageLink[];
}

/** Segments, outgoing links and language of one HTML page. */
export function readPage(html: string, url: string): ParsedPage {
  const doc = parse(html);
  const links: PageLink[] = [];
  let title = '';
  let lang: string | null = null;
  let base = url;
  const textOf = (n: Node): string => (n.nodeName === '#text' ? parse5Tree.text(n) : parse5Tree.children(n).map(textOf).join(''));
  const walk = (n: Node) => {
    const tag = parse5Tree.tag(n);
    if (tag === 'html') lang = parse5Tree.attr(n, 'lang');
    if (tag === 'base' && parse5Tree.attr(n, 'href')) base = new URL(parse5Tree.attr(n, 'href')!, url).href;
    if (tag === 'title' && !title) title = textOf(n).replace(/\s+/g, ' ').trim();
    if (tag === 'a') {
      const href = parse5Tree.attr(n, 'href');
      if (href && !/^(mailto|tel|javascript|sms|data):/i.test(href)) {
        try {
          links.push({ url: new URL(href, base).href, text: textOf(n).replace(/\s+/g, ' ').trim() });
        } catch {
          // Malformed href: ignore it.
        }
      }
    }
    for (const c of parse5Tree.children(n)) walk(c);
  };
  walk(doc);
  return { url, title, lang, segments: extractSegments<Node>(doc, parse5Tree), links };
}
